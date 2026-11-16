import { isIP } from "node:net";

// Reads a recipe from a web page by its schema.org Recipe data (JSON-LD), which nearly every recipe
// site publishes for search engines. No scraping of page layouts: a page without that data is
// reported as having no recipe.

export interface WebRecipe {
	name: string;
	source: string;
	site: string;
	description?: string;
	yieldText?: string;
	servings?: number;
	prepMinutes?: number;
	cookMinutes?: number;
	totalMinutes?: number;
	kcal?: number;
	ingredients: string[];
	steps: Array<{ section?: string; text: string }>;
}

export class WebRecipeError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS = 200;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	frac12: "½",
	frac14: "¼",
	frac34: "¾",
	deg: "°",
};

// JSON-LD strings often still carry HTML: entities, <br>, the odd <a> or <strong>
export function cleanText(value: string): string {
	return value
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, code: string) => {
			if (code.startsWith("#x") || code.startsWith("#X")) {
				return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
			}
			if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
			return ENTITIES[code.toLowerCase()] ?? whole;
		})
		.replace(/\s+/g, " ")
		.trim();
}

function text(value: unknown): string | undefined {
	if (typeof value === "string") return cleanText(value) || undefined;
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return text(value[0]);
	if (isRecord(value)) return text(value.name ?? value.text ?? value["@value"]);
	return undefined;
}

// ISO 8601 durations as recipe sites write them: PT1H30M, PT45M, P0DT2H
export function durationMinutes(value: unknown): number | undefined {
	const s = text(value);
	if (!s) return undefined;
	const m =
		/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
			s,
		);
	if (!m) return undefined;
	const minutes =
		Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60;
	return minutes > 0 ? Math.round(minutes) : undefined;
}

function isRecipe(node: Json): boolean {
	const type = node["@type"];
	const types = Array.isArray(type) ? type : [type];
	return types.some((t) => typeof t === "string" && t.toLowerCase() === "recipe");
}

// Recipes sit at the top level, inside @graph, or in a list; walk a bounded depth to find one
function findRecipe(node: unknown, depth = 0): Json | undefined {
	if (depth > 6) return undefined;
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findRecipe(item, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	if (!isRecord(node)) return undefined;
	if (isRecipe(node)) return node;
	for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
		const found = findRecipe(node[key], depth + 1);
		if (found) return found;
	}
	return undefined;
}

function steps(value: unknown, section?: string, out: WebRecipe["steps"] = []): WebRecipe["steps"] {
	if (out.length >= MAX_ITEMS) return out;
	if (typeof value === "string") {
		// Some sites put the whole method in one string, one step per line
		for (const line of value.split(/\r?\n+/)) {
			const t = cleanText(line);
			if (t) out.push(section ? { section, text: t } : { text: t });
		}
	} else if (Array.isArray(value)) {
		for (const item of value) steps(item, section, out);
	} else if (isRecord(value)) {
		const type = text(value["@type"])?.toLowerCase();
		if (type === "howtosection" || value.itemListElement) {
			steps(value.itemListElement, text(value.name) ?? section, out);
		} else {
			const t = text(value.text ?? value.name ?? value.description);
			if (t) out.push(section ? { section, text: t } : { text: t });
		}
	}
	return out;
}

function servingsOf(yieldText: string | undefined): number | undefined {
	const n = yieldText ? Number(/\d+/.exec(yieldText)?.[0]) : Number.NaN;
	return Number.isInteger(n) && n > 0 && n <= 100 ? n : undefined;
}

export function extractRecipe(html: string, source: string): WebRecipe | null {
	const blocks = html.matchAll(
		/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
	);
	for (const [, body] of blocks) {
		let data: unknown;
		try {
			data = JSON.parse((body ?? "").trim());
		} catch {
			continue;
		}
		const node = findRecipe(data);
		if (!node) continue;
		const name = text(node.name) ?? text(node.headline);
		const rawIngredients = node.recipeIngredient ?? node.ingredients;
		const ingredients = (Array.isArray(rawIngredients) ? rawIngredients : [rawIngredients])
			.map((i) => text(i))
			.filter((i): i is string => !!i)
			.slice(0, MAX_ITEMS);
		if (!name || ingredients.length === 0) continue;
		const yieldText = text(node.recipeYield);
		const nutrition = isRecord(node.nutrition) ? text(node.nutrition.calories) : undefined;
		const kcal = nutrition ? Number(/\d+(?:\.\d+)?/.exec(nutrition)?.[0]) : Number.NaN;
		const description = text(node.description);
		return {
			name,
			source,
			site: new URL(source).hostname.replace(/^www\./, ""),
			...(description && { description }),
			...(yieldText && { yieldText }),
			...(servingsOf(yieldText) !== undefined && { servings: servingsOf(yieldText) }),
			...(durationMinutes(node.prepTime) !== undefined && {
				prepMinutes: durationMinutes(node.prepTime),
			}),
			...(durationMinutes(node.cookTime) !== undefined && {
				cookMinutes: durationMinutes(node.cookTime),
			}),
			...(durationMinutes(node.totalTime) !== undefined && {
				totalMinutes: durationMinutes(node.totalTime),
			}),
			...(Number.isFinite(kcal) && kcal > 0 && { kcal: Math.round(kcal) }),
			ingredients,
			steps: steps(node.recipeInstructions),
		};
	}
	return null;
}

function isPrivateAddress(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		h === "localhost" ||
		h.endsWith(".localhost") ||
		h.endsWith(".local") ||
		h.endsWith(".internal")
	) {
		return true;
	}
	if (h === "supervisor" || h === "homeassistant" || !h.includes(".")) return true;
	const kind = isIP(h);
	if (kind === 4) {
		const [a = 0, b = 0] = h.split(".").map(Number);
		return (
			a === 10 ||
			a === 127 ||
			a === 0 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	if (kind === 6)
		return (
			h === "::1" ||
			h.startsWith("fc") ||
			h.startsWith("fd") ||
			h.startsWith("fe80") ||
			h.startsWith("::ffff:")
		);
	return false;
}

// Only public http(s) pages: the server runs next to Home Assistant, so a link must never make it
// fetch something on the home network or inside the Supervisor
export function checkUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new WebRecipeError("That is not a web address", 400);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new WebRecipeError("Only http and https links can be sent", 400);
	}
	if (url.username || url.password || isPrivateAddress(url.hostname)) {
		throw new WebRecipeError("Only public web pages can be sent", 400);
	}
	return url;
}

async function readCapped(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_PAGE_BYTES) {
			await reader.cancel();
			throw new WebRecipeError("That page is too large", 502);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export type WebFetch = (url: URL, init: RequestInit) => Promise<Response>;
export type BrowserFetch = (url: URL) => Promise<string | null>;

const BLOCKED_STATUSES = new Set([401, 402, 403, 429, 503]);

// Opens the page in a new tab of the app's shared browser. Every request the page makes is checked
// too, so neither a redirect nor anything the page loads can reach a private address.
export const loadWithBrowser: BrowserFetch = async (url) => {
	const { getContext } = await import("./browser/session.ts");
	const context = await getContext().catch(() => null);
	if (!context) return null;
	const page = await context.newPage();
	try {
		await page.route("**/*", (route) => {
			let blocked = true;
			try {
				const target = new URL(route.request().url());
				blocked =
					(target.protocol !== "https:" && target.protocol !== "http:") ||
					isPrivateAddress(target.hostname);
			} catch {}
			return blocked ? route.abort() : route.continue();
		});
		await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: FETCH_TIMEOUT_MS });
		const html = await page.content();
		return html.length > MAX_PAGE_BYTES ? null : html;
	} catch {
		return null;
	} finally {
		await page.close().catch(() => {});
	}
};

export async function fetchWebRecipe(
	raw: string,
	fetchFn: WebFetch = fetch,
	browserFallback: BrowserFetch | null = loadWithBrowser,
): Promise<WebRecipe> {
	let url = checkUrl(raw);
	let response: Response | undefined;
	// Redirects are followed by hand so each hop is checked like the first link
	for (let hop = 0; hop < 5; hop++) {
		try {
			response = await fetchFn(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: {
					"User-Agent":
						"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "en,fi;q=0.8",
				},
			});
		} catch {
			throw new WebRecipeError("Could not load that page", 502);
		}
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			url = checkUrl(new URL(location, url).toString());
			continue;
		}
		break;
	}
	// Bot protection (K-Ruoka, Allrecipes) refuses plain requests; the app's browser gets through
	if (response && BLOCKED_STATUSES.has(response.status) && browserFallback) {
		const html = await browserFallback(url);
		const recipe = html ? extractRecipe(html, url.toString()) : null;
		if (recipe) return recipe;
		if (html) throw new WebRecipeError("No recipe found on that page", 422);
	}
	if (!response?.ok) {
		throw new WebRecipeError(`The site answered HTTP ${response?.status ?? "?"}`, 502);
	}
	const recipe = extractRecipe(await readCapped(response), url.toString());
	if (!recipe) throw new WebRecipeError("No recipe found on that page", 422);
	return recipe;
}
