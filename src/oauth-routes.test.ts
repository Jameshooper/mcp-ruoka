import { beforeEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import * as z from "zod/v4";

process.env.OAUTH_CLIENT_ID = "test-client-id";
process.env.OAUTH_CLIENT_SECRET = "test-client-secret-value";
const { authorizeResponse, tokenResponse, limiter } = await import("./oauth-routes.ts");
const { validateAccessToken } = await import("./auth.ts");

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "a".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function authorizeUrl(overrides: Record<string, string> = {}): URL {
	const url = new URL("https://x/authorize");
	const params = {
		response_type: "code",
		client_id: "test-client-id",
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "abc",
		...overrides,
	};
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url;
}

function codeFrom(response: Response): string {
	const code = new URL(response.headers.get("location") ?? "").searchParams.get("code");
	if (!code) throw new Error("no code issued");
	return code;
}

const exchange = (code: string, extra: Record<string, string> = {}) =>
	tokenResponse({
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT,
			client_id: "test-client-id",
			...extra,
		}).toString(),
	});

beforeEach(() => limiter.reset());

test("the normal flow works with the client secret", async () => {
	const authorized = authorizeResponse(authorizeUrl());
	expect(authorized.status).toBe(302);
	const done = await exchange(codeFrom(authorized), { client_secret: "test-client-secret-value" });
	expect(done.status).toBe(200);
	const token = z.object({ access_token: z.string() }).parse(await done.json());
	expect(validateAccessToken(token.access_token)).toBe(true);
});

test("a code is useless without the client secret", async () => {
	const code = codeFrom(authorizeResponse(authorizeUrl()));
	expect((await exchange(code)).status).toBe(401);
	// and with a wrong one
	const again = codeFrom(authorizeResponse(authorizeUrl()));
	expect((await exchange(again, { client_secret: "wrong" })).status).toBe(401);
});

test("an authorize request cannot send the code to an address of its own choosing", () => {
	const response = authorizeResponse(authorizeUrl({ redirect_uri: "https://attacker.example/cb" }));
	expect(response.status).toBe(400);
	expect(response.headers.get("location")).toBeNull();
});

const SECRET = "test-client-secret-value";
const ATTACKER = "198.51.100.66";
const CLAUDE = "160.79.106.22";
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function signIn(): Promise<{ access_token: string; refresh_token: string }> {
	const code = codeFrom(authorizeResponse(authorizeUrl(), CLAUDE));
	const done = await exchange(code, { client_secret: SECRET });
	return z.object({ access_token: z.string(), refresh_token: z.string() }).parse(await done.json());
}

function lockOut(ip: string): void {
	for (let i = 0; i < 10; i++) {
		authorizeResponse(authorizeUrl({ client_id: "made-up" }), ip);
	}
}

test("repeated failures pause the failing address", () => {
	lockOut(ATTACKER);
	expect(authorizeResponse(authorizeUrl(), ATTACKER).status).toBe(429);
	const guess = tokenResponse({
		body: form({
			grant_type: "client_credentials",
			client_id: "test-client-id",
			client_secret: "x",
		}),
		ip: ATTACKER,
	});
	expect(guess.status).toBe(429);
});

test("a stranger's failures cannot lock Claude out", async () => {
	const tokens = await signIn();
	lockOut(ATTACKER);
	expect(authorizeResponse(authorizeUrl(), CLAUDE).status).toBe(302);
	const refreshed = tokenResponse({
		body: form({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: "test-client-id",
			client_secret: SECRET,
		}),
		ip: CLAUDE,
	});
	expect(refreshed.status).toBe(200);
});

test("Claude's renewals go through even when its shared address is paused", async () => {
	const tokens = await signIn();
	lockOut(CLAUDE);
	const refreshed = tokenResponse({
		body: form({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: "test-client-id",
			client_secret: SECRET,
		}),
		ip: CLAUDE,
	});
	expect(refreshed.status).toBe(200);
});

test("a refresh token alone is not enough", async () => {
	const tokens = await signIn();
	const bare = tokenResponse({
		body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
		ip: ATTACKER,
	});
	expect(bare.status).toBe(401);
	const wrong = tokenResponse({
		body: form({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: "test-client-id",
			client_secret: "wrong",
		}),
		ip: ATTACKER,
	});
	expect(wrong.status).toBe(401);
});

test("client credentials are also accepted as HTTP Basic", async () => {
	const tokens = await signIn();
	const basic = Buffer.from(`test-client-id:${SECRET}`).toString("base64");
	const refreshed = tokenResponse({
		body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
		ip: CLAUDE,
		authorization: `Basic ${basic}`,
	});
	expect(refreshed.status).toBe(200);
	const broken = tokenResponse({
		body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
		authorization: `Basic ${Buffer.from("test-client-id:%E0%A4%A").toString("base64")}`,
	});
	expect(broken.status).toBe(400);
});

test("refreshing cannot extend a sign-in past 90 days", async () => {
	const start = Date.now();
	try {
		setSystemTime(new Date(start));
		let { refresh_token } = await signIn();
		const refresh = () =>
			tokenResponse({
				body: form({
					grant_type: "refresh_token",
					refresh_token,
					client_id: "test-client-id",
					client_secret: SECRET,
				}),
				ip: CLAUDE,
			});
		// Renewing every 20 days keeps working until the sign-in is 90 days old
		for (let day = 20; day <= 80; day += 20) {
			setSystemTime(new Date(start + day * 86_400_000));
			const response = refresh();
			expect(response.status).toBe(200);
			refresh_token = z
				.object({ refresh_token: z.string() })
				.parse(await response.json()).refresh_token;
		}
		setSystemTime(new Date(start + 91 * 86_400_000));
		expect(refresh().status).toBe(400);
	} finally {
		setSystemTime();
	}
});

test("too many pending codes is a polite 503, not a crash", () => {
	for (let i = 0; i < 100; i++) authorizeResponse(authorizeUrl(), CLAUDE);
	const response = authorizeResponse(authorizeUrl(), CLAUDE);
	expect(response.status).toBe(503);
});
