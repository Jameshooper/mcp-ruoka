import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { oauthEnabled } from "./auth.ts";
import { startDailyBackups } from "./backup.ts";
import { warmup as warmupAlko } from "./browser/alko.ts";
import { warmup as warmupSKaupat } from "./browser/s-kaupat.ts";
import { getPage } from "./browser/session.ts";
import { authConfigError, createMcpHttpHandler, MAX_REQUEST_BODY_BYTES } from "./http-server.ts";
import { logger } from "./logger.ts";
import { parseCidrs } from "./security.ts";
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
	const authToken = process.env.MCP_AUTH_TOKEN || undefined;
	const configError = authConfigError(authToken, oauthEnabled);
	if (configError) {
		logger.error(configError);
		process.exit(1);
	}
	if (!authToken && !oauthEnabled) {
		logger.warn("ALLOW_NO_AUTH=1: serving /mcp without authentication (local development only)");
	}

	const uiPort = Number(process.env.RUOKA_UI_PORT);
	if (uiPort > 0) {
		startUiServer(uiPort);
		startDailyBackups((err) => logger.warn({ err }, "Daily backup failed"));
	}
	const standalonePort = Number(process.env.RUOKA_UI_STANDALONE_PORT);
	if (standalonePort > 0) {
		startStandaloneUi(standalonePort, (process.env.RUOKA_UI_ALLOWED_LOGINS ?? "").split(","));
	}

	const port = Number(process.env.PORT) || 3001;
	// Optional: only these addresses (e.g. Anthropic's published outbound range) may use /mcp, /token
	// and the discovery documents. Empty means no restriction.
	const allowedCidrs = parseCidrs(process.env.MCP_ALLOWED_IPS);
	if (allowedCidrs.length > 0) logger.info({ ranges: allowedCidrs.length }, "IP allowlist enabled");

	const handler = createMcpHttpHandler({
		createServer,
		oauthEnabled,
		authToken,
		allowedCidrs,
		publicUrl: process.env.RUOKA_PUBLIC_URL,
		port,
		logoPath,
	});
	setInterval(() => handler.expireIdleSessions(), 60_000).unref();

	// 127.0.0.2 when published through Tailscale: its userspace networking forwards direct tailnet
	// connections to 127.0.0.1, which would otherwise look like trusted Funnel traffic
	const hostname = process.env.MCP_HOST || "0.0.0.0";

	Bun.serve({
		hostname,
		port,
		idleTimeout: 120,
		maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
		// Development mode answers crashes with a debug page showing paths and error details
		development: false,
		error(error) {
			logger.error({ err: error }, "MCP request failed");
			return new Response("Internal Server Error", { status: 500 });
		},
		fetch: (req, server) => handler.handle(req, server.requestIP(req)?.address),
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
