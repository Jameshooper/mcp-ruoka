import * as z from "zod/v4";
import { logger } from "../logger.ts";
import { type Per100, parseNutrients } from "../nutrition.ts";
import { fetchProductFields, isValidId, memoizedLookup } from "./s-kaupat-api.ts";

export interface NutritionResult {
	// none: the store lists no usable per-100 g/ml table for this product
	status: "ok" | "none" | "unknown";
	per100: Per100 | null;
}

// Label values only change with a new product version
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ProductResponseSchema = z.object({
	data: z.object({
		product: z
			.object({
				ean: z.string(),
				storeId: z.string(),
				productDetails: z
					.object({
						nutrients: z
							.array(
								z.object({
									nutrients: z
										.array(z.object({ name: z.string(), value: z.string().nullish() }))
										.nullish(),
									referenceQuantity: z.string().nullish(),
								}),
							)
							.nullish(),
					})
					.nullish(),
			})
			.nullable(),
	}),
});

const UNKNOWN: NutritionResult = { status: "unknown", per100: null };

async function resolveNutrition(ean: string, storeId: string): Promise<NutritionResult> {
	try {
		const body = await fetchProductFields(
			"productDetails { nutrients { nutrients { name value } referenceQuantity } }",
			ean,
			storeId,
		);
		const parsed = ProductResponseSchema.safeParse(body);
		const product = parsed.success ? parsed.data.data.product : null;
		if (!product || product.ean !== ean || product.storeId !== storeId) {
			logger.warn({ ean, storeId, body }, "Unexpected nutrition response");
			return UNKNOWN;
		}

		for (const table of product.productDetails?.nutrients ?? []) {
			const rows = (table.nutrients ?? []).flatMap((n) =>
				n.value ? [{ name: n.name, value: n.value }] : [],
			);
			const per100 = parseNutrients(rows, table.referenceQuantity);
			if (per100) return { status: "ok", per100 };
		}
		return { status: "none", per100: null };
	} catch (err) {
		logger.warn({ err, ean, storeId }, "Nutrition lookup failed");
		return UNKNOWN;
	}
}

const lookup = memoizedLookup<NutritionResult>(CACHE_TTL_MS, (r) => r.status !== "unknown");

export function getProductNutrition(ean: string, storeId: string): Promise<NutritionResult> {
	if (!isValidId(ean) || !isValidId(storeId)) return Promise.resolve(UNKNOWN);
	return lookup(`${storeId}:${ean}`, () => resolveNutrition(ean, storeId));
}
