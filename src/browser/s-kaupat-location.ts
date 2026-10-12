import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { ProductLocation } from "../types.ts";
import { fetchProductFields, isValidId, memoizedLookup } from "./s-kaupat-api.ts";

export interface LocationResult {
	// "none": the store answered but lists no aisle for this product; "unknown": we could not tell
	status: "found" | "none" | "unknown";
	location: ProductLocation | null;
}

// Shelf placement rarely changes, so repeated recipe checks can reuse answers for hours
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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

async function resolveLocation(ean: string, storeId: string): Promise<LocationResult> {
	const started = Date.now();
	try {
		const body = await fetchProductFields("location { aisle floor }", ean, storeId);
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

		const result = toResult(product.location);
		logger.info(
			{ ean, storeId, status: result.status, ms: Date.now() - started },
			"Shelf location resolved",
		);
		return result;
	} catch (err) {
		logger.warn({ err, ean, storeId }, "Shelf location lookup failed");
		return UNKNOWN;
	}
}

const lookup = memoizedLookup<LocationResult>(CACHE_TTL_MS, (r) => r.status !== "unknown");

export function getProductLocation(ean: string, storeId: string): Promise<LocationResult> {
	if (!isValidId(ean) || !isValidId(storeId)) return Promise.resolve(UNKNOWN);
	return lookup(`${storeId}:${ean}`, () => resolveLocation(ean, storeId));
}
