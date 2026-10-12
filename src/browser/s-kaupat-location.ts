import type { Page } from "playwright";
import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { ProductLocation } from "../types.ts";
import { API_TIMEOUT, API_URL } from "./s-kaupat.ts";
import { getContext } from "./session.ts";

export interface LocationResult {
	// "none": the store answered but has no aisle for this product; "unknown": we could not tell
	status: "found" | "none" | "unknown";
	location: ProductLocation | null;
}

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BROWSER_LOCATION_TIMEOUT = 20_000;
const MAX_BROWSER_PAGES = 3;
// Shelf placement rarely changes, so repeated recipe checks can reuse answers for hours
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

const LocationSchema = z
	.object({
		aisle: z.union([z.string(), z.number()]).nullish(),
		floor: z.number().nullish(),
	})
	.nullish();

function toResult(raw: z.infer<typeof LocationSchema>): LocationResult {
	const aisle = raw?.aisle == null || raw.aisle === "" ? null : String(raw.aisle);
	const floor = raw?.floor ?? null;
	if (aisle === null && floor === null) return { status: "none", location: null };
	return { status: "found", location: { aisle, floor } };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

const NextDataSchema = z.object({
	props: z.object({
		pageProps: z.object({
			apolloState: z.record(z.string(), z.unknown()),
		}),
	}),
});

const RootQuerySchema = z.object({ currentStoreId: z.string().nullish() });

const PageProductSchema = z.object({
	ean: z.string(),
	storeId: z.string(),
	location: LocationSchema,
});

export interface ProductPageLocation {
	pageStoreId: string | null;
	result: LocationResult;
}

// The product page is server-rendered with the store's data embedded as Apollo cache JSON
export function parseProductPageLocation(html: string, ean: string): ProductPageLocation {
	const match = NEXT_DATA_RE.exec(html);
	if (!match?.[1]) throw new Error("S-Kaupat product page has no __NEXT_DATA__");

	const { apolloState } = NextDataSchema.parse(JSON.parse(match[1])).props.pageProps;
	const pageStoreId =
		RootQuerySchema.safeParse(apolloState.ROOT_QUERY).data?.currentStoreId ?? null;

	for (const [key, value] of Object.entries(apolloState)) {
		if (!key.startsWith("Product:")) continue;
		const product = PageProductSchema.safeParse(value);
		if (product.success && product.data.ean === ean) {
			return { pageStoreId: product.data.storeId, result: toResult(product.data.location) };
		}
	}
	return { pageStoreId, result: { status: "unknown", location: null } };
}

// The location itself is interpreted separately so an unexpected shape is reported as
// "unknown" with a log line instead of silently never matching
const ClientProductResponseSchema = z.object({
	data: z.object({
		product: z.object({
			ean: z.string(),
			storeId: z.string(),
			location: z.unknown().optional(),
		}),
	}),
});

function interpretLocation(raw: unknown, ean: string): LocationResult {
	const parsed = LocationSchema.safeParse(raw);
	if (parsed.success) return toResult(parsed.data);
	logger.warn({ ean, raw }, "Unrecognized product location shape");
	return { status: "unknown", location: null };
}

const ExtensionsSchema = z.object({
	persistedQuery: z.object({ sha256Hash: z.string() }),
});

// The page's own product request, with the EAN and store ID positions marked so the same
// persisted query can be replayed for any product and store without loading a page.
export interface ProductQueryTemplate {
	operationName: string;
	hash: string;
	variables: Record<string, unknown>;
	eanKeys: string[];
	storeKeys: string[];
}

export function buildProductQueryTemplate(
	requestUrl: string,
	ean: string,
	storeId: string,
): ProductQueryTemplate | null {
	const params = new URL(requestUrl).searchParams;
	const operationName = params.get("operationName");
	const variablesRaw = params.get("variables");
	const extensionsRaw = params.get("extensions");
	if (!operationName || !variablesRaw || !extensionsRaw) return null;

	const variables = z.record(z.string(), z.unknown()).safeParse(parseJson(variablesRaw));
	const extensions = ExtensionsSchema.safeParse(parseJson(extensionsRaw));
	if (!variables.success || !extensions.success) return null;

	const entries = Object.entries(variables.data);
	const eanKeys = entries.filter(([, v]) => v === ean).map(([k]) => k);
	const storeKeys = entries.filter(([, v]) => v === storeId).map(([k]) => k);
	if (eanKeys.length === 0 || storeKeys.length === 0) return null;

	return {
		operationName,
		hash: extensions.data.persistedQuery.sha256Hash,
		variables: variables.data,
		eanKeys,
		storeKeys,
	};
}

let productTemplate: ProductQueryTemplate | null = null;
// The site renders this store when none is selected; learning it lets us skip pointless page fetches
let defaultStoreId: string | null = null;

async function lookupViaServerRenderedPage(
	productUrl: string,
	ean: string,
	storeId: string,
): Promise<LocationResult | null> {
	if (defaultStoreId && defaultStoreId !== storeId) return null;

	const response = await fetch(productUrl, {
		headers: { "User-Agent": UA, Accept: "text/html" },
		signal: AbortSignal.timeout(API_TIMEOUT),
	});
	if (!response.ok) throw new Error(`S-Kaupat product page HTTP ${response.status}`);

	const { pageStoreId, result } = parseProductPageLocation(await response.text(), ean);
	if (pageStoreId) defaultStoreId = pageStoreId;
	return pageStoreId === storeId ? result : null;
}

async function lookupViaReplay(ean: string, storeId: string): Promise<LocationResult | null> {
	const template = productTemplate;
	if (!template) return null;

	const variables = { ...template.variables };
	for (const key of template.eanKeys) variables[key] = ean;
	for (const key of template.storeKeys) variables[key] = storeId;

	const url = new URL(API_URL);
	url.searchParams.set("operationName", template.operationName);
	url.searchParams.set("variables", JSON.stringify(variables));
	url.searchParams.set(
		"extensions",
		JSON.stringify({ persistedQuery: { version: 1, sha256Hash: template.hash } }),
	);

	const response = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "application/json" },
		signal: AbortSignal.timeout(API_TIMEOUT),
	});
	const body: unknown = response.ok ? await response.json().catch(() => null) : null;
	const parsed = ClientProductResponseSchema.safeParse(body);

	if (!parsed.success) {
		// An expired hash or changed shape: drop the template so the browser re-learns it
		logger.warn({ status: response.status }, "Product query replay failed, dropping template");
		productTemplate = null;
		return null;
	}
	const product = parsed.data.data.product;
	// Matching on storeId keeps another store's shelf from being reported
	if (product.ean !== ean || product.storeId !== storeId) return null;
	return interpretLocation(product.location, ean);
}

let activePages = 0;
const pageWaiters: Array<() => void> = [];

async function acquirePageSlot(): Promise<void> {
	if (activePages < MAX_BROWSER_PAGES) {
		activePages++;
		return;
	}
	await new Promise<void>((resolve) => pageWaiters.push(resolve));
}

function releasePageSlot(): void {
	const next = pageWaiters.shift();
	if (next) next();
	else activePages--;
}

async function lightenPage(page: Page): Promise<void> {
	// Only resources that cannot affect the app's data requests are dropped; blocking scripts
	// or third-party hosts risks breaking the app's startup
	await page.route("**/*", async (route) => {
		const type = route.request().resourceType();
		if (type === "image" || type === "media" || type === "font") {
			await route.abort();
		} else {
			await route.continue();
		}
	});
}

// The selected store lives only in the site's localStorage ("store-storage"), so for any store
// other than the site default the page must run in a browser for the app to request that
// store's product data itself.
async function lookupViaBrowser(
	productUrl: string,
	ean: string,
	storeId: string,
): Promise<LocationResult> {
	await acquirePageSlot();
	try {
		const ctx = await getContext();
		const page = await ctx.newPage();
		try {
			await lightenPage(page);
			const seed = JSON.stringify({ state: { storeId }, version: 0 });
			await page.addInitScript(`localStorage.setItem("store-storage", ${JSON.stringify(seed)})`);

			let timer: ReturnType<typeof setTimeout> | undefined;
			const operationsSeen = new Set<string>();
			const outcome = new Promise<LocationResult>((resolve) => {
				timer = setTimeout(() => {
					logger.warn(
						{ ean, storeId, operationsSeen: [...operationsSeen] },
						"Timed out waiting for store-specific product data",
					);
					resolve({ status: "unknown", location: null });
				}, BROWSER_LOCATION_TIMEOUT);

				page.on("request", (request) => {
					if (productTemplate || !request.url().startsWith(API_URL)) return;
					const template = buildProductQueryTemplate(request.url(), ean, storeId);
					if (template) {
						productTemplate = template;
						logger.info({ operation: template.operationName }, "Captured product query template");
					}
				});

				page.on("response", async (res) => {
					if (!res.url().startsWith(API_URL)) return;
					operationsSeen.add(new URL(res.url()).searchParams.get("operationName") ?? "?");
					const body: unknown = await res.json().catch(() => null);
					const parsed = ClientProductResponseSchema.safeParse(body);
					if (!parsed.success) return;
					const product = parsed.data.data.product;
					if (product.ean !== ean || product.storeId !== storeId) return;
					resolve(interpretLocation(product.location, ean));
				});
			});

			await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
			const result = await outcome;
			clearTimeout(timer);
			return result;
		} finally {
			await page.close().catch(() => {});
		}
	} finally {
		releasePageSlot();
	}
}

async function resolveLocation(
	productUrl: string,
	ean: string,
	storeId: string,
): Promise<LocationResult> {
	const started = Date.now();
	const steps: Array<[string, () => Promise<LocationResult | null>]> = [
		["page", () => lookupViaServerRenderedPage(productUrl, ean, storeId)],
		["replay", () => lookupViaReplay(ean, storeId)],
		["browser", () => lookupViaBrowser(productUrl, ean, storeId)],
	];

	for (const [via, step] of steps) {
		try {
			const result = await step();
			if (result) {
				logger.info(
					{ ean, storeId, via, status: result.status, ms: Date.now() - started },
					"Shelf location resolved",
				);
				return result;
			}
		} catch (err) {
			logger.warn({ err, ean, storeId, via }, "Shelf location step failed");
		}
	}
	return { status: "unknown", location: null };
}

const cache = new Map<string, { result: LocationResult; expiresAt: number }>();
const inflight = new Map<string, Promise<LocationResult>>();

export function getProductLocation(
	productUrl: string,
	ean: string,
	storeId: string,
): Promise<LocationResult> {
	const key = `${storeId}:${ean}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);

	const running = inflight.get(key);
	if (running) return running;

	const promise = resolveLocation(productUrl, ean, storeId)
		.then((result) => {
			// "unknown" is not cached so a retry actually retries
			if (result.status !== "unknown") {
				cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
			}
			return result;
		})
		.finally(() => inflight.delete(key));
	inflight.set(key, promise);
	return promise;
}
