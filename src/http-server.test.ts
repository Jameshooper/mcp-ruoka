import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

// Same credentials as oauth-routes.test.ts: auth.ts reads them once, at first import
process.env.OAUTH_CLIENT_ID = "test-client-id";
process.env.OAUTH_CLIENT_SECRET = "test-client-secret-value";
const { authConfigError, createMcpHttpHandler, MAX_REQUEST_BODY_BYTES } = await import(
	"./http-server.ts"
);
const { limiter } = await import("./oauth-routes.ts");
const { parseCidrs } = await import("./security.ts");
const { resetNotifyCooldowns } = await import("./notify.ts");

const SECRET = "test-client-secret-value";
const STATIC_TOKEN = "static-token-0123456789abcdef";
const CLAUDE_IP = "160.79.106.22";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const logoPath = join(import.meta.dirname, "..", "logo.png");

function tinyServer(): McpServer {
	const server = new McpServer({ name: "test", version: "1" });
	server.registerTool("ping", { description: "ping" }, async () => ({
		content: [{ type: "text", text: "pong" }],
	}));
	return server;
}

type Handler = ReturnType<typeof createMcpHttpHandler>;

function makeHandler(overrides: Partial<Parameters<typeof createMcpHttpHandler>[0]> = {}): Handler {
	return createMcpHttpHandler({
		createServer: tinyServer,
		oauthEnabled: true,
		port: 3001,
		logoPath,
		...overrides,
	});
}

interface CallOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	// The socket peer: 127.0.0.1 with X-Forwarded-For is how Funnel traffic arrives
	peer?: string;
	forwardedFor?: string;
}

function call(handler: Handler, path: string, options: CallOptions = {}): Promise<Response> {
	const headers: Record<string, string> = { ...options.headers };
	if (options.forwardedFor) headers["X-Forwarded-For"] = options.forwardedFor;
	return handler.handle(
		new Request(`http://localhost:3001${path}`, {
			method: options.method ?? "GET",
			headers,
			...(options.body !== undefined && { body: options.body }),
		}),
		options.peer ?? "127.0.0.1",
	);
}

const INITIALIZE = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "t", version: "1" },
	},
});

const mcpHeaders = (token?: string, sessionId?: string): Record<string, string> => ({
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
	...(token && { Authorization: `Bearer ${token}` }),
	...(sessionId && { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" }),
});

async function signIn(handler: Handler): Promise<{ access: string; refresh: string }> {
	const authorize = await call(
		handler,
		`/authorize?${new URLSearchParams({
			response_type: "code",
			client_id: "test-client-id",
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			code_challenge_method: "S256",
		})}`,
		{ forwardedFor: CLAUDE_IP },
	);
	const code = new URL(authorize.headers.get("location") ?? "").searchParams.get("code") ?? "";
	const token = await call(handler, "/token", {
		method: "POST",
		forwardedFor: CLAUDE_IP,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT,
			client_id: "test-client-id",
			client_secret: SECRET,
		}).toString(),
	});
	const parsed = z
		.object({ access_token: z.string(), refresh_token: z.string() })
		.parse(await token.json());
	return { access: parsed.access_token, refresh: parsed.refresh_token };
}

async function openSession(handler: Handler, token: string): Promise<string> {
	const response = await call(handler, "/mcp", {
		method: "POST",
		forwardedFor: CLAUDE_IP,
		headers: mcpHeaders(token),
		body: INITIALIZE,
	});
	expect(response.status).toBe(200);
	const id = response.headers.get("mcp-session-id");
	if (!id) throw new Error("no session id");
	await response.body?.cancel();
	return id;
}

const toolsList = (handler: Handler, token: string, sessionId: string) =>
	call(handler, "/mcp", {
		method: "POST",
		forwardedFor: CLAUDE_IP,
		headers: mcpHeaders(token, sessionId),
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
	});

beforeEach(() => {
	limiter.reset();
	resetNotifyCooldowns();
});
afterEach(() => setSystemTime());

// AUTH-01
test("/mcp refuses every request without a valid access token", async () => {
	const handler = makeHandler();
	const { access, refresh } = await signIn(handler);
	const [header, payload, signature] = access.split(".");
	const flip = (part = "") => `${part.slice(0, -1)}${part.endsWith("A") ? "B" : "A"}`;
	const attempts: Array<Record<string, string>> = [
		{},
		{ Authorization: "Bearer " },
		{ Authorization: `Basic ${Buffer.from(`test-client-id:${SECRET}`).toString("base64")}` },
		{ Authorization: "Bearer not-a-token" },
		{ Authorization: `Bearer ${refresh}` },
		{ Authorization: `Bearer ${flip(header)}.${payload}.${signature}` },
		{ Authorization: `Bearer ${header}.${flip(payload)}.${signature}` },
		{ Authorization: `Bearer ${header}.${payload}.${flip(signature)}` },
		{ Authorization: `bearer ${access}` },
	];
	for (const extra of attempts) {
		const response = await call(handler, "/mcp", {
			method: "POST",
			forwardedFor: CLAUDE_IP,
			headers: { ...mcpHeaders(), ...extra },
			body: INITIALIZE,
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("mcp-session-id")).toBeNull();
		expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
	}
	expect(handler.sessionCount()).toBe(0);
	// the real token still works
	await openSession(handler, access);
	expect(handler.sessionCount()).toBe(1);
});

// AUTH-01, SESS-01
test("an expired access token is refused", async () => {
	const start = Date.now();
	setSystemTime(new Date(start));
	const handler = makeHandler();
	const { access } = await signIn(handler);
	setSystemTime(new Date(start + 3601_000));
	const response = await call(handler, "/mcp", {
		method: "POST",
		forwardedFor: CLAUDE_IP,
		headers: mcpHeaders(access),
		body: INITIALIZE,
	});
	expect(response.status).toBe(401);
});

// SESS-02
test("an open session does not outlive its token", async () => {
	const start = Date.now();
	setSystemTime(new Date(start));
	const handler = makeHandler();
	const first = await signIn(handler);
	const sessionId = await openSession(handler, first.access);
	expect((await toolsList(handler, first.access, sessionId)).status).toBe(200);

	setSystemTime(new Date(start + 3601_000));
	expect((await toolsList(handler, first.access, sessionId)).status).toBe(401);
	// the session id alone is not a credential, with or without any token
	const bare = await call(handler, "/mcp", {
		method: "POST",
		forwardedFor: CLAUDE_IP,
		headers: { ...mcpHeaders(undefined, sessionId) },
		body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
	});
	expect(bare.status).toBe(401);

	const renewed = await signIn(handler);
	expect((await toolsList(handler, renewed.access, sessionId)).status).toBe(200);
});

// SESS-03
test("sessions end on DELETE and after 30 idle minutes", async () => {
	const handler = makeHandler();
	const { access } = await signIn(handler);
	const ended = await openSession(handler, access);
	const deleted = await call(handler, "/mcp", {
		method: "DELETE",
		forwardedFor: CLAUDE_IP,
		headers: mcpHeaders(access, ended),
	});
	expect(deleted.status).toBe(200);
	expect((await toolsList(handler, access, ended)).status).toBe(404);

	const idle = await openSession(handler, access);
	handler.expireIdleSessions(Date.now() + 31 * 60_000);
	expect((await toolsList(handler, access, idle)).status).toBe(404);
	expect(handler.sessionCount()).toBe(0);
});

// API-03
test("one token cannot open unlimited sessions", async () => {
	const handler = makeHandler({ maxSessions: 3 });
	const { access } = await signIn(handler);
	const ids: string[] = [];
	for (let i = 0; i < 5; i++) ids.push(await openSession(handler, access));
	expect(handler.sessionCount()).toBe(3);
	// the oldest were closed and their client is told to re-initialize; the newest still work
	expect((await toolsList(handler, access, ids[0] ?? "")).status).toBe(404);
	expect((await toolsList(handler, access, ids[4] ?? "")).status).toBe(200);
});

// AUTH-07
test("the static token works locally but never through Funnel", async () => {
	const handler = makeHandler({ authToken: STATIC_TOKEN });
	const init = (token: string, forwardedFor?: string) =>
		call(handler, "/mcp", {
			method: "POST",
			headers: mcpHeaders(token),
			body: INITIALIZE,
			...(forwardedFor && { forwardedFor }),
		});
	const local = await init(STATIC_TOKEN);
	expect(local.status).toBe(200);
	await local.body?.cancel();
	expect((await init(STATIC_TOKEN, CLAUDE_IP)).status).toBe(401);
	expect((await init(`${STATIC_TOKEN}x`)).status).toBe(401);
	expect((await init(`${STATIC_TOKEN.slice(0, -1)}0`)).status).toBe(401);
});

// AZ-06
test("path variants cannot slip past the IP allowlist", async () => {
	const handler = makeHandler({ allowedCidrs: parseCidrs("160.79.104.0/21") });
	const { access } = await signIn(handler);
	const outsider = "198.51.100.7";
	const variants = [
		"/mcp",
		"/mcp/",
		"/MCP",
		"//mcp",
		"/mcp?x=1",
		"/%6Dcp",
		"/./mcp",
		"/.well-known/../mcp",
		"/token",
		"/token/",
		"/.well-known/oauth-authorization-server",
	];
	for (const path of variants) {
		const response = await call(handler, path, {
			method: "POST",
			forwardedFor: outsider,
			headers: mcpHeaders(access),
			body: INITIALIZE,
		});
		expect([401, 403, 404, 405]).toContain(response.status);
		expect(response.headers.get("mcp-session-id")).toBeNull();
		await response.body?.cancel();
	}
	expect(handler.sessionCount()).toBe(0);
	// no address at all is refused, not waved through
	const unknown = await handler.handle(
		new Request("http://localhost:3001/mcp", { method: "POST", headers: mcpHeaders(access) }),
		undefined,
	);
	expect(unknown.status).toBe(403);
});

// API-01, API-02
test("odd methods and malformed requests change nothing and never crash", async () => {
	const handler = makeHandler();
	const { access } = await signIn(handler);
	const statusOf = async (path: string, options: CallOptions) => {
		const response = await call(handler, path, { forwardedFor: CLAUDE_IP, ...options });
		await response.body?.cancel();
		return response.status;
	};
	expect(await statusOf("/mcp", { method: "PUT", headers: mcpHeaders(access) })).toBe(405);
	expect(await statusOf("/mcp", { method: "PATCH", headers: mcpHeaders(access) })).toBe(405);
	expect(await statusOf("/token", { method: "GET" })).toBe(404);
	expect(await statusOf("/authorize", { method: "POST" })).toBe(404);
	expect(await statusOf("/mcp", { method: "GET", headers: mcpHeaders(access) })).toBe(400);
	for (const body of [
		"{bad",
		"[]",
		"null",
		'"text"',
		JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	]) {
		expect(await statusOf("/mcp", { method: "POST", headers: mcpHeaders(access), body })).toBe(400);
	}
	expect(
		await statusOf("/mcp", {
			method: "POST",
			headers: mcpHeaders(access, "00000000-0000-0000-0000-000000000000"),
			body: INITIALIZE,
		}),
	).toBe(404);
	expect(handler.sessionCount()).toBe(0);
});

// CONF-02
test("discovery advertises the configured address, not the Host header", async () => {
	const handler = makeHandler({ publicUrl: "https://ruoka.example.ts.net/" });
	const response = await call(handler, "/.well-known/oauth-authorization-server", {
		headers: { Host: "evil.example", "X-Forwarded-Proto": "https" },
	});
	const doc = z
		.object({ issuer: z.string(), token_endpoint: z.string() })
		.parse(await response.json());
	expect(doc.issuer).toBe("https://ruoka.example.ts.net");
	expect(doc.token_endpoint).toBe("https://ruoka.example.ts.net/token");
	const challengeHeader = (
		await call(handler, "/mcp", { method: "POST", headers: { Host: "evil.example" } })
	).headers.get("www-authenticate");
	expect(challengeHeader).toContain("https://ruoka.example.ts.net/.well-known/");
	expect(challengeHeader).not.toContain("evil.example");
});

// INP-09
test("the allowlist alert names the request type, never the caller's text", async () => {
	process.env.RUOKA_NOTIFY_SERVICE = "notify.mobile_app_phone";
	process.env.SUPERVISOR_TOKEN = "supervisor-token-canary";
	const sent: Array<{ url: string; body: string }> = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (input: Request | URL | string, init?: RequestInit) => {
			sent.push({ url: String(input), body: String(init?.body) });
			return new Response("{}");
		},
		{ preconnect: () => {} },
	);
	try {
		const handler = makeHandler({ allowedCidrs: parseCidrs("160.79.104.0/21") });
		await call(handler, "/.well-known/URGENT-call-0800-123-to-unlock", {
			forwardedFor: "198.51.100.7",
		});
		await Bun.sleep(10);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe("http://supervisor/core/api/services/notify/mobile_app_phone");
		const body = z
			.object({ title: z.string(), message: z.string() })
			.parse(JSON.parse(sent[0]?.body ?? ""));
		expect(body.message).toContain("discovery request from 198.51.100.7");
		expect(body.message).not.toContain("URGENT");
		expect(Object.keys(JSON.parse(sent[0]?.body ?? "{}")).sort()).toEqual(["message", "title"]);
	} finally {
		globalThis.fetch = realFetch;
		delete process.env.RUOKA_NOTIFY_SERVICE;
		delete process.env.SUPERVISOR_TOKEN;
	}
});

// API-04
test("the public listener refuses oversized bodies before reading them", async () => {
	const handler = makeHandler();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
		development: false,
		fetch: (req, srv) => handler.handle(req, srv.requestIP(req)?.address),
	});
	try {
		const big = "a".repeat(MAX_REQUEST_BODY_BYTES + 1024);
		const refused = await fetch(`http://127.0.0.1:${server.port}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: big,
		}).catch(() => null);
		// Bun answers 413, or drops the connection mid-upload; either way nothing is processed
		expect(refused === null || refused.status === 413).toBe(true);
		const normal = await fetch(`http://127.0.0.1:${server.port}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "grant_type=nope",
		});
		expect(normal.status).toBe(400);
	} finally {
		server.stop(true);
	}
});

// CONF-03
test("logs never contain the client secret, tokens or codes", async () => {
	const lines: string[] = [];
	const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
		lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	let tokens: { access: string; refresh: string };
	try {
		const handler = makeHandler({ authToken: STATIC_TOKEN });
		tokens = await signIn(handler);
		await openSession(handler, tokens.access);
		// failures that log
		await call(handler, "/mcp", {
			method: "POST",
			forwardedFor: CLAUDE_IP,
			headers: mcpHeaders(`${tokens.access}x`),
			body: INITIALIZE,
		});
		await call(handler, "/token", {
			method: "POST",
			forwardedFor: CLAUDE_IP,
			body: `grant_type=refresh_token&refresh_token=${tokens.refresh}`,
		});
		await call(handler, "/mcp", {
			method: "POST",
			forwardedFor: CLAUDE_IP,
			headers: mcpHeaders(STATIC_TOKEN),
			body: INITIALIZE,
		});
	} finally {
		stderr.mockRestore();
	}
	const log = lines.join("");
	expect(log.length).toBeGreaterThan(0);
	for (const secret of [SECRET, STATIC_TOKEN, tokens.access, tokens.refresh]) {
		expect(log).not.toContain(secret);
	}
	expect(log).not.toMatch(/"code":"[0-9a-f]{64}"/);
});

// AUTH-11
test("serving with no credentials needs an explicit opt-in", () => {
	expect(authConfigError(undefined, false, false)).toContain("No authentication configured");
	expect(authConfigError(undefined, false, true)).toBeNull();
	expect(authConfigError("token", false, false)).toBeNull();
	expect(authConfigError(undefined, true, false)).toBeNull();
});
