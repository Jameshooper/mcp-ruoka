import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { getProductLocation } from "../browser/s-kaupat.ts";
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
});

interface IngredientResult {
	english: string;
	status: "found" | "not_found" | "error";
	matchedTerm: string | null;
	triedTerms: string[];
	products: Product[];
	error?: string;
}

async function attachLocations(products: Product[], storeId: string): Promise<Product[]> {
	return Promise.all(
		products.map(async (product) => {
			if (!product.url) return product;
			try {
				return { ...product, location: await getProductLocation(product.url, product.id, storeId) };
			} catch (error) {
				logger.warn({ err: error, ean: product.id }, "Shelf location lookup failed");
				return product;
			}
		}),
	);
}

async function resolveIngredient(
	ingredient: z.infer<typeof IngredientSchema>,
	chain: "k-ruoka" | "s-kaupat",
	storeId: string,
	limit: number,
	includeLocation: boolean,
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
					products:
						includeLocation && chain === "s-kaupat"
							? await attachLocations(result.products, storeId)
							: result.products,
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

export function registerRecipeTool(server: McpServer): void {
	server.registerTool(
		"find_recipe_ingredients",
		{
			description:
				"Check a recipe's ingredients against one K-Ruoka or S-Kaupat store. You (the caller) translate each English ingredient into Finnish store terms; this tool searches each ingredient's terms in order against the store's selection and reports the first term that matches, with candidate products and prices. To pick the store for a requested location, call get_stores with the city first. A product appearing here means it is in that store's selection as listed on the chain's site; real-time shelf stock is not exposed. With includeLocation (S-Kaupat only) each candidate also gets its in-store aisle and floor when the store is known to the site.",
			inputSchema: z.object({
				chain: z.enum(["k-ruoka", "s-kaupat"]).describe("Which chain's store to check"),
				storeId: z.string().min(1).describe("Store ID from get_stores"),
				ingredients: z.array(IngredientSchema).min(1).max(40),
				includeLocation: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"S-Kaupat only: also look up each candidate's aisle ('Hyllyväli') and floor in the store. Adds one page fetch per candidate.",
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
		async ({ chain, storeId, ingredients, limitPerIngredient, includeLocation }) => {
			// Sequential: K-Ruoka shares a single browser page, and recipes are short.
			const results: IngredientResult[] = [];
			for (const ingredient of ingredients) {
				results.push(
					await resolveIngredient(ingredient, chain, storeId, limitPerIngredient, includeLocation),
				);
			}

			const summary = {
				chain,
				storeId,
				found: results.filter((r) => r.status === "found").length,
				notFound: results.filter((r) => r.status === "not_found").map((r) => r.english),
				errors: results.filter((r) => r.status === "error").map((r) => r.english),
			};

			return {
				content: [{ type: "text" as const, text: JSON.stringify({ summary, results }, null, 2) }],
			};
		},
	);
}
