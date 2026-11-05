import { beforeEach, expect, setSystemTime, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import * as z from "zod/v4";

process.env.OAUTH_CLIENT_ID = "test-client-id";
process.env.OAUTH_CLIENT_SECRET = "test-client-secret-value";
const { authorizeResponse, tokenResponse, limiter } = await import("./oauth-routes.ts");
const { validateAccessToken, validateRefreshToken } = await import("./auth.ts");

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

test("too many pending codes is a polite 503, not a crash, and clears as codes expire", () => {
	const start = Date.now();
	try {
		setSystemTime(new Date(start));
		for (let i = 0; i < 100; i++) authorizeResponse(authorizeUrl(), CLAUDE);
		expect(authorizeResponse(authorizeUrl(), CLAUDE).status).toBe(503);
		// unused codes expire after 60 s and make room again
		setSystemTime(new Date(start + 61_000));
		expect(authorizeResponse(authorizeUrl(), CLAUDE).status).toBe(302);
	} finally {
		setSystemTime();
	}
});

// Builds a token signed with the test secret, so tampering can be tried one field at a time
function forge(
	header: Record<string, unknown>,
	claims: Record<string, unknown>,
	key = SECRET,
): string {
	const h = Buffer.from(JSON.stringify(header)).toString("base64url");
	const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${h}.${p}.${createHmac("sha256", key).update(`${h}.${p}`).digest("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
const HS256 = { alg: "HS256", typ: "JWT" };

// AUTH-10
test("tampered and malformed tokens are refused without crashing", () => {
	const good = forge(HS256, { sub: "test-client-id", iat: now(), exp: now() + 60 });
	expect(validateAccessToken(good)).toBe(true);
	const [h, p] = good.split(".");
	const unsigned = (header: object) =>
		`${Buffer.from(JSON.stringify(header)).toString("base64url")}.${p}.`;
	const raisedExp = Buffer.from(JSON.stringify({ sub: "x", exp: now() + 999_999 })).toString(
		"base64url",
	);
	const bad = [
		unsigned({ alg: "none", typ: "JWT" }),
		`${Buffer.from(JSON.stringify({ alg: "HS512" })).toString("base64url")}.${p}.${good.split(".")[2]}`,
		`${h}.${raisedExp}.${good.split(".")[2]}`,
		forge(HS256, { exp: now() + 60 }, "another-secret"),
		`${h}.${p}`,
		`${good}.extra`,
		"a.b.c",
		"...",
		"",
		forge(HS256, { exp: "never" }),
		forge(HS256, { exp: now() - 1 }),
		`${h}.${Buffer.from("not json").toString("base64url")}.${createHmac("sha256", SECRET)
			.update(`${h}.${Buffer.from("not json").toString("base64url")}`)
			.digest("base64url")}`,
		forge(HS256, { exp: now() + 60, typ: "refresh" }),
	];
	for (const token of bad) expect(validateAccessToken(token)).toBe(false);
	// an access token is not a refresh token either
	expect(validateRefreshToken(good)).toBeNull();
});

// AUTH-08 (h)
test("a refresh token from before auth_time existed counts from when it was issued", () => {
	const old = forge(HS256, {
		sub: "test-client-id",
		iat: now() - 91 * 86_400,
		exp: now() + 86_400,
		typ: "refresh",
	});
	expect(validateRefreshToken(old)).toBeNull();
	const recent = forge(HS256, {
		sub: "test-client-id",
		iat: now() - 86_400,
		exp: now() + 86_400,
		typ: "refresh",
	});
	expect(validateRefreshToken(recent)).toBe(now() - 86_400);
});

// AUTH-08 (f)
test("an access token cannot be used to refresh", async () => {
	const tokens = await signIn();
	const response = tokenResponse({
		body: form({
			grant_type: "refresh_token",
			refresh_token: tokens.access_token,
			client_id: "test-client-id",
			client_secret: SECRET,
		}),
		ip: CLAUDE,
	});
	expect(response.status).toBe(400);
});

// AUTH-03
test("PKCE and the code itself are checked strictly", async () => {
	expect(authorizeResponse(authorizeUrl({ code_challenge_method: "plain" }), CLAUDE).status).toBe(
		400,
	);

	const wrongVerifier = codeFrom(authorizeResponse(authorizeUrl(), CLAUDE));
	expect(
		(await exchange(wrongVerifier, { client_secret: SECRET, code_verifier: "b".repeat(50) }))
			.status,
	).toBe(400);
	// a failed attempt also burns the code
	expect((await exchange(wrongVerifier, { client_secret: SECRET })).status).toBe(400);

	const reused = codeFrom(authorizeResponse(authorizeUrl(), CLAUDE));
	expect((await exchange(reused, { client_secret: SECRET })).status).toBe(200);
	expect((await exchange(reused, { client_secret: SECRET })).status).toBe(400);

	const otherRedirect = codeFrom(authorizeResponse(authorizeUrl(), CLAUDE));
	expect(
		(
			await exchange(otherRedirect, {
				client_secret: SECRET,
				redirect_uri: "https://claude.com/api/mcp/auth_callback",
			})
		).status,
	).toBe(400);

	const start = Date.now();
	try {
		setSystemTime(new Date(start));
		const stale = codeFrom(authorizeResponse(authorizeUrl(), CLAUDE));
		setSystemTime(new Date(start + 61_000));
		expect((await exchange(stale, { client_secret: SECRET })).status).toBe(400);
	} finally {
		setSystemTime();
	}
});

// AUTH-04
test("only Claude's exact callback addresses receive a code", () => {
	const refused = [
		"https://claude.ai/api/mcp/auth_callback/",
		"https://claude.ai/api/mcp/auth_callback?x=1",
		"https://CLAUDE.AI/api/mcp/auth_callback",
		"http://claude.ai/api/mcp/auth_callback",
		"https://claude.ai.evil.example/api/mcp/auth_callback",
		"https://evil@claude.ai/api/mcp/auth_callback",
		"https://claude.ai%2F@evil.example/api/mcp/auth_callback",
		"https://claude.ai/api/mcp/auth_callback#frag",
		"javascript:alert(1)",
	];
	for (const redirect_uri of refused) {
		const response = authorizeResponse(authorizeUrl({ redirect_uri }), CLAUDE);
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
	}
	for (const redirect_uri of [
		"https://claude.ai/api/mcp/auth_callback",
		"https://claude.com/api/mcp/auth_callback",
	]) {
		const response = authorizeResponse(authorizeUrl({ redirect_uri }), CLAUDE);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")?.startsWith(`${redirect_uri}?code=`)).toBe(true);
	}
});

// AUTH-06 (c)
test("one IPv6 network cannot dodge the limit by changing addresses", () => {
	for (let i = 1; i <= 10; i++) {
		authorizeResponse(authorizeUrl({ client_id: "made-up" }), `2001:db8:1:2::${i.toString(16)}`);
	}
	expect(authorizeResponse(authorizeUrl(), "2001:db8:1:2:ffff::99").status).toBe(429);
	// a different /64 is not affected
	expect(authorizeResponse(authorizeUrl(), "2001:db8:1:3::1").status).toBe(302);
});

// AUTH-09
test("changing the client secret revokes every token already issued", async () => {
	const tokens = await signIn();
	const script = `
		const { validateAccessToken, validateRefreshToken } = await import(${JSON.stringify(join(import.meta.dirname, "auth.ts"))});
		console.log(JSON.stringify({
			access: validateAccessToken(process.env.ACCESS ?? ""),
			refresh: validateRefreshToken(process.env.REFRESH ?? ""),
		}));`;
	const run = (secret: string) => {
		const result = Bun.spawnSync(["bun", "-e", script], {
			env: {
				...process.env,
				OAUTH_CLIENT_ID: "test-client-id",
				OAUTH_CLIENT_SECRET: secret,
				ACCESS: tokens.access_token,
				REFRESH: tokens.refresh_token,
				LOG_LEVEL: "silent",
			},
		});
		return z
			.object({ access: z.boolean(), refresh: z.number().nullable() })
			.parse(JSON.parse(result.stdout.toString()));
	};
	expect(run(SECRET).access).toBe(true);
	expect(run("a-brand-new-secret-value")).toEqual({ access: false, refresh: null });
});
