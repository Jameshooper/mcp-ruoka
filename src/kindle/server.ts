import { logger } from "../logger.ts";
import { listPlans } from "../plan-book.ts";
import { listRecipes } from "../recipe-book.ts";
import { buildCookbook } from "./cookbook.ts";
import { outbox } from "./outbox.ts";
import { sendTonightIfDue } from "./send.ts";

// The Kindle's own listener. The Kindle cannot log in to Home Assistant, so this is open to the
// home network; it only serves the cookbook and the book that was sent, and changes nothing except
// marking that book as opened.
//
// These routes and their answers are a contract with the KOReader plugin, which is updated by
// copying files to the Kindle by hand. Keep them working for old plugins; kindle.test.ts pins them.

function etagOf(bytes: Uint8Array): string {
	return `"${new Bun.CryptoHasher("sha1").update(bytes).digest("hex")}"`;
}

function epubResponse(req: Request, bytes: Uint8Array, filename: string): Response {
	const etag = etagOf(bytes);
	const headers = {
		"Content-Type": "application/epub+zip",
		"Content-Disposition": `attachment; filename="${filename}"`,
		"Cache-Control": "no-cache",
		ETag: etag,
	};
	if (req.headers.get("if-none-match") === etag)
		return new Response(null, { status: 304, headers });
	if (req.method === "HEAD") {
		return new Response(null, { headers: { ...headers, "Content-Length": String(bytes.length) } });
	}
	return new Response(bytes, { headers });
}

function plain(status: number, text: string): Response {
	return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function handleKindleRequest(req: Request, now = Date.now()): Promise<Response> {
	const path = new URL(req.url).pathname;
	const read = req.method === "GET" || req.method === "HEAD";
	const userAgent = req.headers.get("user-agent");

	if (path === "/cookbook.epub" && read) {
		outbox.seen(now, userAgent);
		const bytes = buildCookbook(await listRecipes(), await listPlans(), new Date(now));
		return epubResponse(req, bytes, "Ruoka-Cookbook.epub");
	}

	if (path === "/kindle/request" && req.method === "GET") {
		outbox.seen(now, userAgent);
		try {
			await sendTonightIfDue(now);
		} catch (err) {
			// The poll still answers; a broken plan file must not stop "Open on Kindle" working
			logger.warn({ err }, "Could not send tonight's dinner to the Kindle");
		}
		const request = outbox.current(now);
		if (!request || request.openedAt) return new Response(null, { status: 204 });
		return Response.json(
			{
				id: request.id,
				recipe: request.key,
				name: request.name,
				servings: request.servings,
				url: `/kindle/recipe/${encodeURIComponent(request.id)}.epub`,
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}

	// Books are fetched by request id, so this listener never serves an arbitrary recipe on demand
	const recipeMatch = /^\/kindle\/recipe\/([0-9a-f-]{36})\.epub$/.exec(path);
	if (recipeMatch && read) {
		const request = outbox.current(now);
		if (!request || request.id !== recipeMatch[1]) return plain(404, "No such request");
		return epubResponse(req, request.book, "Now cooking.epub");
	}

	const openedMatch = /^\/kindle\/opened\/([0-9a-f-]{36})$/.exec(path);
	if (openedMatch && req.method === "POST") {
		if (!outbox.markOpened(openedMatch[1] ?? "", now)) return plain(404, "No such request");
		return new Response(null, { status: 204 });
	}

	return plain(404, "Not found");
}

export function startKindleServer(port: number): void {
	Bun.serve({
		hostname: "0.0.0.0",
		port,
		// Nothing here takes a body worth more than a few bytes
		maxRequestBodySize: 1024,
		development: false,
		fetch: async (req) => {
			try {
				const response = await handleKindleRequest(req);
				response.headers.set("X-Content-Type-Options", "nosniff");
				return response;
			} catch (error) {
				logger.error({ err: error }, "Kindle request failed");
				return plain(500, "Server error");
			}
		},
	});
	logger.info({ port }, "Kindle cookbook server listening (home network)");
}
