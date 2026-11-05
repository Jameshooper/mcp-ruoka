import { randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { validateAccessToken } from "./auth.ts";
import { logger } from "./logger.ts";
import { alert } from "./notify.ts";
import { authorizeResponse, tokenResponse } from "./oauth-routes.ts";
import { type Cidr, type ClientAddress, clientAddress, ipAllowed } from "./security.ts";

// JSON-RPC messages are small; the biggest real one (a 28-meal plan_meals call) is well under this.
// Bun's default of 128 MB would let anyone make the server buffer that much before /token answers.
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

export interface McpHttpOptions {
	createServer: () => McpServer;
	oauthEnabled: boolean;
	authToken?: string;
	allowedCidrs?: Cidr[];
	// Set from the Tailscale node name when published; the Host header is only a fallback for local
	// use, since a caller can put anything in it
	publicUrl?: string;
	port: number;
	logoPath: string;
	maxSessions?: number;
	sessionTtlMs?: number;
}

export interface McpHttpHandler {
	handle(req: Request, peer: string | null | undefined): Promise<Response>;
	expireIdleSessions(now?: number): void;
	sessionCount(): number;
}

// Serving /mcp with no credentials at all is only acceptable for local development, and only when
// asked for explicitly: a forgotten secret on a public host must not mean an open server
export function authConfigError(
	authToken: string | undefined,
	oauthEnabled: boolean,
	allowNoAuth = process.env.ALLOW_NO_AUTH === "1",
): string | null {
	if (authToken || oauthEnabled || allowNoAuth) return null;
	return "No authentication configured: set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET, or MCP_AUTH_TOKEN (or ALLOW_NO_AUTH=1 for local development only)";
}

const sessionNotFound = (status: number) =>
	Response.json(
		{ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
		{ status },
	);

export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
	const {
		createServer,
		oauthEnabled,
		authToken,
		allowedCidrs = [],
		port,
		logoPath,
		maxSessions = DEFAULT_MAX_SESSIONS,
		sessionTtlMs = DEFAULT_SESSION_TTL_MS,
	} = options;
	const publicUrl = options.publicUrl?.replace(/\/+$/, "");

	interface TrackedTransport {
		transport: WebStandardStreamableHTTPServerTransport;
		lastActivity: number;
	}
	const transports = new Map<string, TrackedTransport>();

	function closeSession(id: string, reason: string): void {
		const entry = transports.get(id);
		if (!entry) return;
		logger.info({ sessionId: id }, reason);
		transports.delete(id);
		entry.transport.close?.();
	}

	function getTransport(
		sessionId: string | null,
	): WebStandardStreamableHTTPServerTransport | undefined {
		if (!sessionId) return undefined;
		const entry = transports.get(sessionId);
		if (!entry) return undefined;
		entry.lastActivity = Date.now();
		return entry.transport;
	}

	// Each session holds its own McpServer, so an unbounded count is a memory leak a single token
	// can drive. The quietest session goes first; its client re-initializes on the 404 (MCP spec).
	function makeRoom(): void {
		while (transports.size >= maxSessions) {
			let oldest: [string, number] | null = null;
			for (const [id, entry] of transports) {
				if (!oldest || entry.lastActivity < oldest[1]) oldest = [id, entry.lastActivity];
			}
			if (!oldest) return;
			closeSession(oldest[0], "Closing the least recently used MCP session to stay under the cap");
		}
	}

	function checkAuth(req: Request, client: ClientAddress): boolean {
		if (!authToken && !oauthEnabled) return true;

		const header = req.headers.get("authorization");
		if (!header?.startsWith("Bearer ")) return false;
		const token = header.slice(7);

		// The static token never expires, so it is for local clients only: requests that came
		// through Funnel (they carry a forwarded address) must use OAuth
		if (
			authToken &&
			client.source !== "x-forwarded-for" &&
			token.length === authToken.length &&
			timingSafeEqual(Buffer.from(token), Buffer.from(authToken))
		) {
			return true;
		}
		return oauthEnabled && validateAccessToken(token);
	}

	function getBaseUrl(req: Request): string {
		if (publicUrl) return publicUrl;
		const proto = req.headers.get("x-forwarded-proto") ?? "http";
		const host = req.headers.get("host") ?? `localhost:${port}`;
		return `${proto}://${host}`;
	}

	function handleOAuthDiscovery(req: Request, url: URL): Response | null {
		const base = getBaseUrl(req);
		switch (url.pathname) {
			case "/.well-known/oauth-protected-resource":
				return Response.json({
					resource: `${base}/mcp`,
					authorization_servers: [base],
					bearer_methods_supported: ["header"],
				});
			case "/.well-known/oauth-authorization-server":
				return Response.json({
					issuer: base,
					authorization_endpoint: `${base}/authorize`,
					token_endpoint: `${base}/token`,
					token_endpoint_auth_methods_supported: ["client_secret_post"],
					grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
			default:
				return null;
		}
	}

	async function handleOAuthRoutes(
		req: Request,
		url: URL,
		client: ClientAddress,
	): Promise<Response | null> {
		if (req.method === "GET") {
			const discovery = handleOAuthDiscovery(req, url);
			if (discovery) return discovery;
			if (url.pathname === "/authorize") return authorizeResponse(url, client.ip);
		}
		if (req.method === "POST" && url.pathname === "/token") {
			return tokenResponse({
				body: await req.text(),
				ip: client.ip,
				authorization: req.headers.get("authorization"),
			});
		}
		return null;
	}

	async function handleMcp(req: Request, client: ClientAddress): Promise<Response> {
		const sessionId = req.headers.get("mcp-session-id");

		if (req.method === "POST") {
			const existing = getTransport(sessionId);
			if (existing) return existing.handleRequest(req);

			// Per MCP spec, 404 tells the client to re-initialize
			if (sessionId) return sessionNotFound(404);

			const body: unknown = await req.json().catch(() => undefined);
			if (!isInitializeRequest(body)) {
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: null },
					{ status: 400 },
				);
			}

			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sid) => {
					logger.info(
						{
							sessionId: sid,
							clientIp: client.ip,
							ipSource: client.source,
							forwarded: req.headers.has("x-forwarded-for"),
						},
						"New MCP session initialized",
					);
					makeRoom();
					transports.set(sid, { transport, lastActivity: Date.now() });
				},
			});
			transport.onclose = () => {
				if (transport.sessionId) transports.delete(transport.sessionId);
			};

			const server = createServer();
			await server.connect(transport);

			return transport.handleRequest(
				new Request(req.url, {
					method: req.method,
					headers: req.headers,
					body: JSON.stringify(body),
				}),
			);
		}

		if (req.method === "GET" || req.method === "DELETE") {
			const transport = getTransport(sessionId);
			if (transport) return transport.handleRequest(req);
			return sessionNotFound(sessionId ? 404 : 400);
		}

		return new Response("Method Not Allowed", { status: 405 });
	}

	async function handle(req: Request, peer: string | null | undefined): Promise<Response> {
		const url = new URL(req.url);
		logger.debug({ method: req.method, path: url.pathname }, "Incoming request");

		const client = clientAddress(req.headers, peer);
		// /authorize is opened by the user's own browser, so it cannot be limited to Claude's servers
		const restricted =
			url.pathname === "/mcp" ||
			url.pathname === "/token" ||
			url.pathname.startsWith("/.well-known/");
		if (allowedCidrs.length > 0 && restricted && !ipAllowed(client.ip, allowedCidrs)) {
			logger.warn(
				{ clientIp: client.ip, ipSource: client.source, path: url.pathname },
				"Refused a request from outside the IP allowlist",
			);
			// The path is chosen by the caller, so only its category goes into the notification
			const target = url.pathname.startsWith("/.well-known/") ? "discovery" : url.pathname.slice(1);
			alert(
				"ip-refused",
				"Ruoka: request refused",
				`A ${target} request from ${client.ip ?? "an unknown address"} was refused by the IP allowlist.`,
			);
			return new Response("Forbidden", { status: 403 });
		}

		if (oauthEnabled) {
			const oauthResponse = await handleOAuthRoutes(req, url, client);
			if (oauthResponse) return oauthResponse;
		}

		if (url.pathname === "/logo.png") return new Response(Bun.file(logoPath));
		if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });

		if (!checkAuth(req, client)) {
			logger.warn(
				{ method: req.method, path: url.pathname, clientIp: client.ip, ipSource: client.source },
				"Auth rejected",
			);
			const headers: Record<string, string> = {};
			if (oauthEnabled) {
				headers["WWW-Authenticate"] =
					`Bearer resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource"`;
			}
			return new Response(null, { status: 401, headers });
		}

		return handleMcp(req, client);
	}

	return {
		handle,
		expireIdleSessions(now = Date.now()) {
			const cutoff = now - sessionTtlMs;
			for (const [id, entry] of transports) {
				if (entry.lastActivity < cutoff) closeSession(id, "Expiring idle MCP session");
			}
		},
		sessionCount: () => transports.size,
	};
}
