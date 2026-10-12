import * as z from "zod/v4";
import { logger } from "../logger.ts";
import type { AllergenCheck, AllergenFlag } from "../types.ts";
import { fetchProductFields, isValidId, memoizedLookup } from "./s-kaupat-api.ts";

export interface AllergenDetails {
	status: "ok" | "unknown";
	allergens: Array<{ text: string; level: string | null }>;
	ingredients: string | null;
}

// Declared allergens and ingredient lists change with recipe updates, but not within a day
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SNIPPET_RADIUS = 30;

const ProductResponseSchema = z.object({
	data: z.object({
		product: z
			.object({
				ean: z.string(),
				storeId: z.string(),
				allergens: z
					.array(
						z.object({
							allergenTypeText: z.string().nullish(),
							levelOfContainmentCode: z.string().nullish(),
						}),
					)
					.nullish(),
				ingredientStatement: z.string().nullish(),
			})
			.nullable(),
	}),
});

const UNKNOWN: AllergenDetails = { status: "unknown", allergens: [], ingredients: null };

async function resolveAllergens(ean: string, storeId: string): Promise<AllergenDetails> {
	try {
		const body = await fetchProductFields(
			"allergens { allergenTypeText levelOfContainmentCode } ingredientStatement",
			ean,
			storeId,
		);
		const parsed = ProductResponseSchema.safeParse(body);
		const product = parsed.success ? parsed.data.data.product : null;
		if (!product || product.ean !== ean || product.storeId !== storeId) {
			logger.warn({ ean, storeId, body }, "Unexpected allergen response");
			return UNKNOWN;
		}

		return {
			status: "ok",
			allergens: (product.allergens ?? []).flatMap((a) =>
				a.allergenTypeText
					? [{ text: a.allergenTypeText, level: a.levelOfContainmentCode ?? null }]
					: [],
			),
			ingredients: product.ingredientStatement ?? null,
		};
	} catch (err) {
		logger.warn({ err, ean, storeId }, "Allergen lookup failed");
		return UNKNOWN;
	}
}

const lookup = memoizedLookup<AllergenDetails>(CACHE_TTL_MS, (d) => d.status === "ok");

export function getProductAllergens(ean: string, storeId: string): Promise<AllergenDetails> {
	if (!isValidId(ean) || !isValidId(storeId)) return Promise.resolve(UNKNOWN);
	return lookup(`${storeId}:${ean}`, () => resolveAllergens(ean, storeId));
}

// "no_match" only means none of the terms appear in what the store declares: it is not a
// guarantee of safety, since traces and undeclared ingredients are invisible here
export function matchAvoidTerms(details: AllergenDetails, terms: readonly string[]): AllergenCheck {
	if (details.status !== "ok") return { status: "unknown", flags: [] };

	const normalized = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
	const flags: AllergenFlag[] = [];

	for (const term of normalized) {
		for (const allergen of details.allergens) {
			if (allergen.level === "FREE_FROM") continue;
			if (allergen.text.toLowerCase().includes(term)) {
				flags.push({
					term,
					source: "declared allergens",
					text: allergen.text,
					level: allergen.level,
				});
			}
		}

		const ingredients = details.ingredients;
		const at = ingredients?.toLowerCase().indexOf(term) ?? -1;
		if (ingredients && at >= 0) {
			const snippet = ingredients
				.slice(Math.max(0, at - SNIPPET_RADIUS), at + term.length + SNIPPET_RADIUS)
				.trim();
			flags.push({ term, source: "ingredients", text: snippet, level: null });
		}
	}

	return { status: flags.length > 0 ? "flagged" : "no_match", flags };
}
