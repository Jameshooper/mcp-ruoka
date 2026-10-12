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
const MAX_SNIPPET = 200;
// Finnish and English precautionary phrasing found in ingredient texts
const MAY_CONTAIN_RE =
	/(voi|voivat|saattaa|saattavat) sisältää|pieniä määriä|jälkiä|may contain|traces/i;

// The sentence holding the match, so a "may contain ..." lead-in is not cut off
function sentenceAround(text: string, at: number, length: number): string {
	const before = text.lastIndexOf(". ", at);
	const start = before === -1 ? 0 : before + 2;
	const after = text.indexOf(". ", at + length);
	const end = after === -1 ? text.length : after + 1;
	const sentence = text.slice(start, end).trim();
	return sentence.length > MAX_SNIPPET ? `${sentence.slice(0, MAX_SNIPPET)}…` : sentence;
}

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
					kind: allergen.level === "MAY_CONTAIN" ? "may_contain" : "contains",
				});
			}
		}

		const ingredients = details.ingredients;
		const at = ingredients?.toLowerCase().indexOf(term) ?? -1;
		if (ingredients && at >= 0) {
			const sentence = sentenceAround(ingredients, at, term.length);
			flags.push({
				term,
				source: "ingredients",
				text: sentence,
				level: null,
				kind: MAY_CONTAIN_RE.test(sentence) ? "may_contain" : "contains",
			});
		}
	}

	return { status: flags.length > 0 ? "flagged" : "no_match", flags };
}
