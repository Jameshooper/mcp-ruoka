import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { ProductLocation } from "../types.ts";
import { API_TIMEOUT, API_URL, ORIGIN } from "./s-kaupat.ts";

export interface LocationResult {
	// "none": the store answered but lists no aisle for this product; "unknown": we could not tell
	status: "found" | "none" | "unknown";
	location: ProductLocation | null;
}

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_CONCURRENT = 6;
// Shelf placement rarely changes, so repeated recipe checks can reuse answers for hours
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Inserted into the query text, so only plain digits are allowed
const ID_RE = /^\d+$/;

const LocationSchema = z
	.object({
		aisle: z.union([z.string(), z.number()]).nullish(),
		floor: z.number().nullish(),
	})
	.nullish();

const ProductResponseSchema = z.object({
	data: z.object({
		product: z
			.object({
				ean: z.string(),
				storeId: z.string(),
				location: LocationSchema,
			})
			.nullable(),
	}),
});

const UNKNOWN: LocationResult = { status: "unknown", location: null };

function toResult(raw: z.infer<typeof LocationSchema>): LocationResult {
	const aisle = raw?.aisle == null || raw.aisle === "" ? null : String(raw.aisle);
	const floor = raw?.floor ?? null;
	if (aisle === null && floor === null) return { status: "none", location: null };
	return { status: "found", location: { aisle, floor } };
}

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
	if (active < MAX_CONCURRENT) {
		active++;
		return;
	}
	await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
	const next = waiters.shift();
	if (next) next();
	else active--;
}

// The site's own pages load this from the same GraphQL endpoint, which accepts plain queries
// (unlike a POST, which its CDN rejects). The persisted-query hashes used elsewhere are not
// needed because the fields requested here are spelled out.
async function queryLocation(ean: string, storeId: string): Promise<LocationResult> {
	const query = `{ product(id: "${ean}", storeId: "${storeId}", fallbackToGlobal: true, includeAgeLimitedByAlcohol: true) { ean storeId location { aisle floor } } }`;
	const url = new URL(API_URL);
	url.searchParams.set("query", query);

	const response = await fetch(url, {
		headers: {
			Origin: ORIGIN,
			Referer: `${ORIGIN}/`,
			"User-Agent": UA,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(API_TIMEOUT),
	});
	if (!response.ok) throw new Error(`S-Kaupat API HTTP ${response.status}`);

	const body: unknown = await response.json();
	const parsed = ProductResponseSchema.safeParse(body);
	if (!parsed.success) {
		logger.warn(
			{ ean, storeId, issues: parsed.error.issues, body },
			"Unexpected location response",
		);
		return UNKNOWN;
	}

	const product = parsed.data.data.product;
	// With fallbackToGlobal the API may answer for another store; its shelf would be wrong here
	if (!product || product.ean !== ean || product.storeId !== storeId) {
		logger.warn(
			{ ean, storeId, answeredFor: product?.storeId ?? null },
			"No product for this store",
		);
		return UNKNOWN;
	}
	return toResult(product.location);
}

async function resolveLocation(ean: string, storeId: string): Promise<LocationResult> {
	const started = Date.now();
	await acquire();
	try {
		const result = await queryLocation(ean, storeId);
		logger.info(
			{ ean, storeId, status: result.status, ms: Date.now() - started },
			"Shelf location resolved",
		);
		return result;
	} catch (err) {
		logger.warn({ err, ean, storeId }, "Shelf location lookup failed");
		return UNKNOWN;
	} finally {
		release();
	}
}

const cache = new Map<string, { result: LocationResult; expiresAt: number }>();
const inflight = new Map<string, Promise<LocationResult>>();

export function getProductLocation(ean: string, storeId: string): Promise<LocationResult> {
	if (!ID_RE.test(ean) || !ID_RE.test(storeId)) return Promise.resolve(UNKNOWN);

	const key = `${storeId}:${ean}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);

	const running = inflight.get(key);
	if (running) return running;

	const promise = resolveLocation(ean, storeId)
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
