import { beforeEach, expect, test } from "bun:test";
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
	tokenResponse(
		new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT,
			client_id: "test-client-id",
			...extra,
		}).toString(),
	);

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

test("repeated failures lock the OAuth endpoints for a while", () => {
	for (let i = 0; i < 10; i++) {
		tokenResponse(
			new URLSearchParams({
				grant_type: "client_credentials",
				client_id: "test-client-id",
				client_secret: "guess",
			}).toString(),
		);
	}
	const blocked = tokenResponse(
		new URLSearchParams({
			grant_type: "client_credentials",
			client_id: "test-client-id",
			client_secret: "test-client-secret-value",
		}).toString(),
	);
	expect(blocked.status).toBe(429);
	expect(authorizeResponse(authorizeUrl()).status).toBe(429);
});
