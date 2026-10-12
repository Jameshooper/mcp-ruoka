import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { getProductLocation } from "../browser/s-kaupat-location.ts";
import { type CostResult, type CostTotals, costProduct, sumCosts } from "../costing.ts";
import { logger } from "../logger.ts";
import type { Product } from "../types.ts";
import { runSearch } from "./search.ts";

const IngredientSchema = z.object({
	english: z.string().min(1).describe("Ingredient as written in the recipe (e.g., 'heavy cream')"),
	finnish: z
		.array(z.string().min(1))
		.min(1)
		.max(5)
		.describe(
			"Finnish search terms for this ingredient, best guess first, then alternatives or synonyms (e.g., ['kuohukerma', 'ruokakerma']). Use the base/singular store-style name, not an inflected form.",
		),
	quantity: z
		.object({
			amount: z.number().positive(),
			unit: z.enum(["g", "kg", "ml", "l", "pcs"]),
		})
		.optional()
		.describe(
			"TOTAL amount needed for everyone being served (already scaled to the number of servings). Convert spoons and cups to g or ml. Use grams for loose produce sold by weight (onion, garlic, peppers) and pcs only for items priced per piece. Enables costing.",
		),
});

interface CostedProduct extends Product {
	costing?: CostResult;
}

interface IngredientResult {
	english: string;
	status: "found" | "not_found" | "error";
	matchedTerm: string | null;
	triedTerms: string[];
	products: CostedProduct[];
	error?: string;
}

// Stays under the ~60s limit MCP clients commonly apply to a tool call
const CALL_BUDGET_MS = 50_000;

async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			const item = items[index];
			if (item !== undefined) results[index] = await fn(item);
		}
	});
	await Promise.all(workers);
	return results;
}

interface LocationTally {
	found: number;
	none: number;
	unknown: number;
	pending: number;
}

async function attachLocations(
	results: IngredientResult[],
	storeId: string,
	topN: number,
	deadline: number,
): Promise<LocationTally> {
	const lookups: Promise<void>[] = [];
	const targets: CostedProduct[] = [];

	for (const result of results) {
		for (const product of result.products.slice(0, topN)) {
			if (!product.url) continue;
			targets.push(product);
			// Lookups that miss the deadline keep running and fill the cache for the next call
			lookups.push(
				getProductLocation(product.url, product.id, storeId).then(
					(r) => {
						product.location = r.location;
						product.locationStatus = r.status;
					},
					(error) => {
						logger.warn({ err: error, ean: product.id }, "Shelf location lookup failed");
						product.locationStatus = "unknown";
					},
				),
			);
		}
	}

	const remaining = Math.max(deadline - Date.now(), 1_000);
	await Promise.race([
		Promise.all(lookups),
		new Promise<void>((resolve) => setTimeout(resolve, remaining)),
	]);

	const tally: LocationTally = { found: 0, none: 0, unknown: 0, pending: 0 };
	for (const product of targets) {
		product.locationStatus ??= "pending";
		tally[product.locationStatus]++;
	}
	return tally;
}

async function resolveIngredient(
	ingredient: z.infer<typeof IngredientSchema>,
	chain: "k-ruoka" | "s-kaupat",
	storeId: string,
	limit: number,
): Promise<IngredientResult> {
	const triedTerms: string[] = [];
	try {
		// Stop at the first term with hits: later terms are lower-confidence fallbacks
		// and merging them would bury the best match in noise.
		for (const term of ingredient.finnish) {
			triedTerms.push(term);
			const result = await runSearch(chain, term, storeId, limit);
			if (result.products.length > 0) {
				return {
					english: ingredient.english,
					status: "found",
					matchedTerm: term,
					triedTerms,
					products: result.products,
				};
			}
		}
		return {
			english: ingredient.english,
			status: "not_found",
			matchedTerm: null,
			triedTerms,
			products: [],
		};
	} catch (error) {
		logger.error({ err: error, ingredient: ingredient.english, chain, storeId }, "Lookup failed");
		return {
			english: ingredient.english,
			status: "error",
			matchedTerm: null,
			triedTerms,
			products: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

type OkCost = Extract<CostResult, { status: "ok" }>;

interface CostSummary {
	servings?: number;
	currency: "EUR";
	topMatch: CostTotals;
	cheapest: CostTotals;
	uncosted: Array<{ ingredient: string; reason: string }>;
	explanation: string;
}

function okCost(product: CostedProduct): OkCost | null {
	return product.costing?.status === "ok" ? product.costing : null;
}

function summarizeCosts(
	results: IngredientResult[],
	ingredients: Array<z.infer<typeof IngredientSchema>>,
	servings: number | undefined,
): CostSummary | null {
	const top: OkCost[] = [];
	const cheapest: OkCost[] = [];
	const uncosted: CostSummary["uncosted"] = [];
	let anyQuantity = false;

	for (const [i, result] of results.entries()) {
		const quantity = ingredients[i]?.quantity;
		if (!quantity) {
			uncosted.push({ ingredient: result.english, reason: "no quantity given" });
			continue;
		}
		anyQuantity = true;

		const costed = result.products.flatMap((p) => okCost(p) ?? []);
		const first = result.products[0] && okCost(result.products[0]);
		const lowest = costed.reduce<OkCost | null>(
			(best, c) => (!best || c.basketCost < best.basketCost ? c : best),
			null,
		);
		if (first && lowest) {
			top.push(first);
			cheapest.push(lowest);
		} else {
			uncosted.push({
				ingredient: result.english,
				reason: result.status === "found" ? "price or unit not comparable" : result.status,
			});
		}
	}

	if (!anyQuantity) return null;
	return {
		...(servings && { servings }),
		currency: "EUR",
		topMatch: sumCosts(top, servings),
		cheapest: sumCosts(cheapest, servings),
		uncosted,
		explanation:
			"basketTotal = whole packs you must buy; usedTotal = pro-rata cost of just the amounts the recipe uses. topMatch uses each ingredient's first search result, cheapest the lowest basket cost among the candidates returned.",
	};
}

export function registerRecipeTool(server: McpServer): void {
	server.registerTool(
		"find_recipe_ingredients",
		{
			description:
				"Check a recipe's ingredients against one K-Ruoka or S-Kaupat store. You (the caller) translate each English ingredient into Finnish store terms; this tool searches each ingredient's terms in order against the store's selection and reports the first term that matches, with candidate products and prices. Give each ingredient's total quantity (scaled for the number of servings) and the servings count to also get costs: per product the packs needed and basket vs used cost, and recipe totals including per person. To pick the store for a requested location, call get_stores with the city first. A product appearing here means it is in that store's selection as listed on the chain's site; real-time shelf stock is not exposed. With includeLocation (S-Kaupat only) the top candidate(s) per ingredient also get their in-store aisle and floor. Each carries locationStatus: found, none (the store lists no aisle), unknown (lookup failed) or pending (still loading when the call's time budget ran out: repeat the same call shortly and it will be answered from cache).",
			inputSchema: z.object({
				chain: z.enum(["k-ruoka", "s-kaupat"]).describe("Which chain's store to check"),
				storeId: z.string().min(1).describe("Store ID from get_stores"),
				ingredients: z.array(IngredientSchema).min(1).max(40),
				servings: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("How many people the quantities feed; used for per-person cost."),
				includeLocation: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"S-Kaupat only: also look up the aisle ('Hyllyväli') and floor in the store for the top candidates of each ingredient.",
					),
				locationForTopN: z
					.number()
					.int()
					.min(1)
					.max(5)
					.optional()
					.default(1)
					.describe(
						"With includeLocation: how many of each ingredient's top candidates get a shelf lookup (default: 1).",
					),
				limitPerIngredient: z
					.number()
					.int()
					.min(1)
					.max(10)
					.optional()
					.default(3)
					.describe("Candidate products per ingredient (default: 3)"),
			}),
		},
		async ({
			chain,
			storeId,
			ingredients,
			servings,
			limitPerIngredient,
			includeLocation,
			locationForTopN,
		}) => {
			const deadline = Date.now() + CALL_BUDGET_MS;

			// K-Ruoka shares a single browser page, so only S-Kaupat searches run in parallel
			const results = await mapPool(ingredients, chain === "s-kaupat" ? 4 : 1, (ingredient) =>
				resolveIngredient(ingredient, chain, storeId, limitPerIngredient),
			);

			const locations =
				includeLocation && chain === "s-kaupat"
					? await attachLocations(results, storeId, locationForTopN, deadline)
					: null;

			for (const [i, result] of results.entries()) {
				const quantity = ingredients[i]?.quantity;
				if (!quantity) continue;
				for (const product of result.products) product.costing = costProduct(product, quantity);
			}
			const cost = summarizeCosts(results, ingredients, servings);

			const summary = {
				chain,
				storeId,
				found: results.filter((r) => r.status === "found").length,
				notFound: results.filter((r) => r.status === "not_found").map((r) => r.english),
				errors: results.filter((r) => r.status === "error").map((r) => r.english),
				...(locations && {
					locations,
					...(locations.pending > 0 && {
						note: "Some shelf locations were still loading; repeat the same call in a minute and they will be returned from cache.",
					}),
				}),
			};

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ summary, ...(cost && { cost }), results }, null, 2),
					},
				],
			};
		},
	);
}
