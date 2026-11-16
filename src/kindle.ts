import { buildCookbook, buildRecipeBook } from "./cookbook.ts";
import { logger } from "./logger.ts";
import { listPlans } from "./plan-book.ts";
import { findRecipe, listRecipes, scaleRecipe } from "./recipe-book.ts";

// The Kindle side of the app. A KOReader plugin on the Kindle asks this server, every few seconds
// while KOReader is open, whether a recipe should be shown, and keeps the cookbook up to date.
// Nothing connects into the Kindle, so the app holds no keys to it and a sleeping Kindle simply
// picks the request up when it wakes (within REQUEST_TTL_MS).
//
// The Kindle cannot log in to Home Assistant, so this listener is open to the home network. It
// only serves the cookbook, single recipes and the pending request; it changes nothing except
// marking a request it was handed as opened.

const REQUEST_TTL_MS = 10 * 60_000;
// The Kindle counts as reachable when it asked this recently
const SEEN_RECENTLY_MS = 2 * 60_000;
const MAX_SERVINGS = 100;

export interface KindleRequest {
	id: string;
	recipe: string;
	name: string;
	servings: number;
	requestedAt: number;
	openedAt: number | null;
}

let pending: KindleRequest | null = null;
let lastSeen: number | null = null;

export function resetKindleState(): void {
	pending = null;
	lastSeen = null;
}

export async function requestOpenOnKindle(
	recipeId: string,
	servings: number | undefined,
	now = Date.now(),
): Promise<KindleRequest | null> {
	const recipe = await findRecipe(recipeId);
	if (!recipe) return null;
	const wanted =
		servings !== undefined && Number.isInteger(servings) && servings > 0 && servings <= MAX_SERVINGS
			? servings
			: recipe.servings;
	pending = {
		id: crypto.randomUUID(),
		recipe: recipe.id,
		name: recipe.name,
		servings: wanted,
		requestedAt: now,
		openedAt: null,
	};
	logger.info({ recipe: recipe.id, servings: wanted }, "Recipe requested on the Kindle");
	return pending;
}

function live(now: number): KindleRequest | null {
	if (pending && now - pending.requestedAt > REQUEST_TTL_MS && !pending.openedAt) pending = null;
	return pending;
}

export function kindleStatus(now = Date.now()) {
	const request = live(now);
	return {
		request: request
			? {
					id: request.id,
					recipe: request.recipe,
					name: request.name,
					servings: request.servings,
					status: request.openedAt ? "opened" : "waiting",
				}
			: null,
		lastSeenSecondsAgo: lastSeen === null ? null : Math.round((now - lastSeen) / 1000),
		seenRecently: lastSeen !== null && now - lastSeen < SEEN_RECENTLY_MS,
	};
}

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
	const url = new URL(req.url);
	const path = url.pathname;
	const read = req.method === "GET" || req.method === "HEAD";

	if (path === "/cookbook.epub" && read) {
		lastSeen = now;
		const bytes = buildCookbook(await listRecipes(), await listPlans(), new Date(now));
		return epubResponse(req, bytes, "Ruoka-Cookbook.epub");
	}

	if (path === "/kindle/request" && req.method === "GET") {
		lastSeen = now;
		const request = live(now);
		if (!request || request.openedAt) return new Response(null, { status: 204 });
		return Response.json(
			{
				id: request.id,
				recipe: request.recipe,
				name: request.name,
				servings: request.servings,
				url: `/kindle/recipe/${encodeURIComponent(request.id)}.epub`,
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}

	// Recipes are fetched by request id, so this listener never serves an arbitrary recipe on demand
	const recipeMatch = /^\/kindle\/recipe\/([0-9a-f-]{36})\.epub$/.exec(path);
	if (recipeMatch && read) {
		const request = live(now);
		if (!request || request.id !== recipeMatch[1]) return plain(404, "No such request");
		const recipe = await findRecipe(request.recipe);
		if (!recipe) return plain(404, "Recipe not found");
		const scaled =
			request.servings === recipe.servings ? recipe : scaleRecipe(recipe, request.servings);
		return epubResponse(req, buildRecipeBook(scaled), "Now cooking.epub");
	}

	const openedMatch = /^\/kindle\/opened\/([0-9a-f-]{36})$/.exec(path);
	if (openedMatch && req.method === "POST") {
		const request = live(now);
		if (!request || request.id !== openedMatch[1]) return plain(404, "No such request");
		request.openedAt = now;
		lastSeen = now;
		logger.info({ recipe: request.recipe }, "Recipe opened on the Kindle");
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
