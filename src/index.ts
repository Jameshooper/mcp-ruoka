import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { oauthEnabled, validateAccessToken } from "./auth.ts";
import { startDailyBackups } from "./backup.ts";
import { warmup as warmupAlko } from "./browser/alko.ts";
import { warmup as warmupSKaupat } from "./browser/s-kaupat.ts";
import { getPage } from "./browser/session.ts";
import { logger } from "./logger.ts";
import { alert } from "./notify.ts";
import { authorizeResponse, tokenResponse } from "./oauth-routes.ts";
import { type ClientAddress, clientAddress, ipAllowed, parseCidrs } from "./security.ts";
import { registerMealPlanTool } from "./tools/meal-plan.ts";
import { registerPlanBookTools } from "./tools/plan-book.ts";
import { registerRecipeTool } from "./tools/recipe.ts";
import { registerRecipeBookTools } from "./tools/recipe-book.ts";
import { registerSearchTool } from "./tools/search.ts";
import { registerStoresTool } from "./tools/stores.ts";
import { startStandaloneUi, startUiServer } from "./ui-server.ts";

const logoPath = join(import.meta.dirname, "..", "logo.png");
const logoDataUri = `data:image/png;base64,${Buffer.from(await Bun.file(logoPath).arrayBuffer()).toString("base64")}`;

function createServer(): McpServer {
	const server = new McpServer({
		name: "mcp-ruoka",
		version: "0.2.0",
		icons: [{ src: logoDataUri, mimeType: "image/png", sizes: ["512x512"] }],
	});
	registerSearchTool(server);
	registerStoresTool(server);
	registerRecipeTool(server);
	registerRecipeBookTools(server);
	registerMealPlanTool(server);
	registerPlanBookTools(server);
	return server;
}

if (process.argv.includes("--stdio")) {
	logger.info("Starting in stdio mode");
	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	getPage().catch((err) => {
		logger.warn({ err }, "K-Ruoka pre-init failed (will retry on first request)");
	});
	warmupSKaupat().catch((err) => {
		logger.warn({ err }, "S-Kaupat pre-init failed (will retry on first request)");
	});
	warmupAlko().catch((err) => {
		logger.warn({ err }, "Alko pre-init failed (will retry on first request)");
	});
} else {
	startHttpServer();
}

function startHttpServer() {
	const uiPort = Number(process.env.RUOKA_UI_PORT);
	if (uiPort > 0) {
		startUiServer(uiPort);
		startDailyBackups((err) => logger.warn({ err }, "Daily backup failed"));
	}
	const standalonePort = Number(process.env.RUOKA_UI_STANDALONE_PORT);
	if (standalonePort > 0) {
		startStandaloneUi(standalonePort, (process.env.RUOKA_UI_ALLOWED_LOGINS ?? "").split(","));
	}

	interface TrackedTransport {
		transport: WebStandardStreamableHTTPServerTransport;
		lastActivity: number;
	}

	const transports = new Map<string, TrackedTransport>();
	const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

	function getTransport(
		sessionId: string | null,
	): WebStandardStreamableHTTPServerTransport | undefined {
		if (!sessionId) return undefined;
		const entry = transports.get(sessionId);
		if (!entry) return undefined;
		entry.lastActivity = Date.now();
		return entry.transport;
	}

	setInterval(() => {
		const cutoff = Date.now() - SESSION_TTL;
		for (const [id, entry] of transports) {
			if (entry.lastActivity < cutoff) {
				logger.info({ sessionId: id }, "Expiring idle MCP session");
				entry.transport.close?.();
				transports.delete(id);
			}
		}
	}, 60_000);

	const port = Number(process.env.PORT) || 3001;
	const authToken = process.env.MCP_AUTH_TOKEN;
	// Optional: only these addresses (e.g. Anthropic's published outbound range) may use /mcp, /token
	// and the discovery documents. Empty means no restriction.
	const allowedCidrs = parseCidrs(process.env.MCP_ALLOWED_IPS);
	if (allowedCidrs.length > 0) logger.info({ ranges: allowedCidrs.length }, "IP allowlist enabled");

	if (!authToken && !oauthEnabled) {
		logger.warn("No authentication configured — running without auth");
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

	// Set from the Tailscale node name when published; the Host header is only a fallback for local
	// use, since a caller can put anything in it
	const publicUrl = process.env.RUOKA_PUBLIC_URL?.replace(/\/+$/, "");

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
			if (sessionId) {
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
					{ status: 404 },
				);
			}

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
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
				{ status: sessionId ? 404 : 400 },
			);
		}

		return new Response("Method Not Allowed", { status: 405 });
	}

	// 127.0.0.2 when published through Tailscale: its userspace networking forwards direct tailnet
	// connections to 127.0.0.1, which would otherwise look like trusted Funnel traffic
	const hostname = process.env.MCP_HOST || "0.0.0.0";

	Bun.serve({
		hostname,
		port,
		idleTimeout: 120,
		// Development mode answers crashes with a debug page showing paths and error details
		development: false,
		error(error) {
			logger.error({ err: error }, "MCP request failed");
			return new Response("Internal Server Error", { status: 500 });
		},
		async fetch(req: Request, server): Promise<Response> {
			const url = new URL(req.url);
			logger.debug({ method: req.method, path: url.pathname }, "Incoming request");

			const client = clientAddress(req.headers, server.requestIP(req)?.address);
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
				const target = url.pathname.startsWith("/.well-known/")
					? "discovery"
					: url.pathname.slice(1);
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
					const base = getBaseUrl(req);
					headers["WWW-Authenticate"] =
						`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
				}
				return new Response(null, { status: 401, headers });
			}

			return handleMcp(req, client);
		},
	});

	logger.info({ hostname, port }, "Ruoka MCP server listening");

	// Pre-warm so the first request isn't slow
	getPage().catch((err) => {
		logger.warn({ err }, "K-Ruoka pre-init failed (will retry on first request)");
	});
	warmupSKaupat().catch((err) => {
		logger.warn({ err }, "S-Kaupat pre-init failed (will retry on first request)");
	});
	warmupAlko().catch((err) => {
		logger.warn({ err }, "Alko pre-init failed (will retry on first request)");
	});
}
