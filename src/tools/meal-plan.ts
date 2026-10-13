import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { getProductAllergens, matchAvoidTerms } from "../browser/s-kaupat-allergens.ts";
import { getProductLocation } from "../browser/s-kaupat-location.ts";
import { choosePack, formatAmount, mergeIngredients } from "../planner.ts";
import { findRecipe, scaleRecipe } from "../recipe-book.ts";
import { type Ingredient, IngredientSchema } from "../schemas.ts";
import type { Product, ProductLocation } from "../types.ts";
import { CALL_BUDGET_MS, mapPool, resolveIngredient } from "./recipe.ts";

const MealSchema = z.object({
	name: z.string().min(1).describe("Label for the meal, e.g. 'Mon dinner'"),
	servings: z.number().int().positive().max(100).describe("How many portions this meal makes"),
	recipe: z
		.string()
		.optional()
		.describe("Id or name of a saved recipe; its quantities are scaled to `servings`"),
	ingredients: z
		.array(IngredientSchema)
		.max(40)
		.optional()
		.describe(
			"Instead of `recipe`: the meal's ingredients with quantities already totalled for `servings`",
		),
});

type Meal = z.infer<typeof MealSchema>;

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

async function mealIngredients(meal: Meal): Promise<Ingredient[] | string> {
	if (meal.recipe) {
		const recipe = await findRecipe(meal.recipe);
		if (!recipe) return `No saved recipe matches "${meal.recipe}"`;
		return scaleRecipe(recipe, meal.servings).ingredients;
	}
	if (meal.ingredients && meal.ingredients.length > 0) return meal.ingredients;
	return "Give either a saved `recipe` or `ingredients`";
}

function isFlagged(product: Product): boolean {
	return product.allergenCheck?.status === "flagged";
}

async function shelfLocation(ean: string, storeId: string): Promise<ProductLocation | null> {
	try {
		return (await getProductLocation(ean, storeId)).location;
	} catch {
		return null;
	}
}

export function registerMealPlanTool(server: McpServer): void {
	server.registerTool(
		"plan_meals",
		{
			description:
				"Price a whole week's meals at one store as a single shopping list, to plan within a budget and cut food waste. Needs from every meal are pooled per ingredient, so one bag of carrots can serve several dinners; for each ingredient the tool picks the pack combination that covers the total, and reports what is left over and what it is worth. It also reports how much pooling saved compared to buying for each meal separately. You design the menu: call this, then read `wasteAlerts` (leftovers worth using up), `costDrivers` and the budget result, swap or add meals so leftovers get used (e.g. put leftover carrots into another dish), and call it again until the plan fits. Meals come from saved recipes (`recipe`) or inline `ingredients`. Mark staples with pantry: true; the budget covers only items to buy. Pass avoidAllergens to keep flagged products out. Prices are for the chosen store's online selection; stock is not exposed.",
			inputSchema: z.object({
				chain: z.enum(["k-ruoka", "s-kaupat"]),
				storeId: z.string().min(1).describe("Store ID from get_stores"),
				meals: z.array(MealSchema).min(1).max(28),
				budget: z
					.number()
					.positive()
					.optional()
					.describe("Budget in EUR for the items to buy (pantry staples excluded)"),
				preference: z
					.enum(["cheapest", "least_waste"])
					.optional()
					.default("cheapest")
					.describe("How to choose between pack sizes: lowest price, or least value left over"),
				avoidAllergens: z
					.array(z.string().min(2))
					.max(15)
					.optional()
					.describe("Finnish and English terms to keep out, as in find_recipe_ingredients"),
				includeLocation: z
					.boolean()
					.optional()
					.default(false)
					.describe("S-Kaupat only: add the aisle for each chosen product"),
			}),
		},
		async ({ chain, storeId, meals, budget, preference, avoidAllergens, includeLocation }) => {
			const deadline = Date.now() + CALL_BUDGET_MS;

			const resolved = await Promise.all(
				meals.map(async (meal) => ({ meal, content: await mealIngredients(meal) })),
			);
			const problems = resolved.flatMap(({ meal, content }) =>
				typeof content === "string" ? [{ meal: meal.name, problem: content }] : [],
			);
			if (problems.length > 0) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: JSON.stringify({ problems }, null, 2) }],
				};
			}
			const inputs = resolved.flatMap(({ meal, content }) =>
				typeof content === "string" ? [] : [{ meal: meal.name, ingredients: content }],
			);

			const { merged, unquantified } = mergeIngredients(inputs);
			const searched = await mapPool(merged, chain === "s-kaupat" ? 4 : 1, (item) =>
				resolveIngredient({ english: item.english, finnish: item.finnish }, chain, storeId, 5).then(
					(result) => ({ item, result }),
				),
			);

			const avoidTerms = avoidAllergens ?? [];
			if (chain === "s-kaupat" && avoidTerms.length > 0) {
				const pending: Promise<void>[] = [];
				for (const { result } of searched) {
					for (const product of result.products) {
						pending.push(
							getProductAllergens(product.id, storeId).then(
								(details) => {
									product.allergenCheck = matchAvoidTerms(details, avoidTerms);
								},
								() => {
									product.allergenCheck = { status: "unknown", flags: [] };
								},
							),
						);
					}
				}
				await Promise.race([
					Promise.all(pending),
					new Promise<void>((resolve) =>
						setTimeout(resolve, Math.max(deadline - Date.now(), 1_000)),
					),
				]);
			}

			const lines = searched.map(({ item, result }) => {
				const candidates = result.products.filter((p) => !isFlagged(p));
				const choice = choosePack(candidates, item, preference);
				return {
					item,
					result,
					choice,
					excludedByAllergen: result.products.length - candidates.length,
				};
			});

			if (chain === "s-kaupat" && includeLocation) {
				const locations = new Map<string, ProductLocation | null>();
				const lookups = lines.flatMap((l) =>
					l.choice
						? [
								shelfLocation(l.choice.product.id, storeId).then((loc) => {
									locations.set(l.choice?.product.id ?? "", loc);
								}),
							]
						: [],
				);
				await Promise.race([
					Promise.all(lookups),
					new Promise<void>((resolve) =>
						setTimeout(resolve, Math.max(deadline - Date.now(), 1_000)),
					),
				]);
				for (const l of lines) {
					if (l.choice) l.choice.product.location = locations.get(l.choice.product.id) ?? null;
				}
			}

			const shopping = lines.flatMap((l) => (l.choice ? [{ ...l, choice: l.choice }] : []));
			const buy = shopping.filter((l) => !l.item.pantry);
			const pantry = shopping.filter((l) => l.item.pantry);

			const lineOutput = (l: (typeof shopping)[number]) => ({
				ingredient: l.item.english,
				needed: formatAmount(l.item.dimension, l.item.need),
				product: l.choice.product.name,
				productId: l.choice.product.id,
				url: l.choice.product.url ?? null,
				packSize: l.choice.packSize,
				packages: l.choice.packages,
				unitPrice: l.choice.product.unitPrice,
				cost: l.choice.cost,
				leftover: formatAmount(l.item.dimension, l.choice.leftover),
				leftoverValue: l.choice.leftoverValue,
				usedIn: l.item.uses.map((u) => `${u.meal}: ${u.quantity.amount} ${u.quantity.unit}`),
				...(l.choice.product.location !== undefined && { location: l.choice.product.location }),
			});

			const sum = (rows: typeof shopping, pick: (r: (typeof shopping)[number]) => number) =>
				round2(rows.reduce((total, r) => total + pick(r), 0));
			const buyTotal = sum(buy, (r) => r.choice.cost);
			const separateTotal = sum(buy, (r) => r.choice.separateCost);
			const wasteValue = sum(buy, (r) => r.choice.leftoverValue);

			const wasteAlerts = buy
				.filter((r) => r.choice.leftoverValue >= 0.5)
				.sort((a, b) => b.choice.leftoverValue - a.choice.leftoverValue)
				.map(
					(r) =>
						`${formatAmount(r.item.dimension, r.choice.leftover)} of ${r.item.english} left over (about ${r.choice.leftoverValue.toFixed(2)} EUR): use it in another meal`,
				);

			const costDrivers = [...buy]
				.sort((a, b) => b.choice.cost - a.choice.cost)
				.slice(0, 5)
				.map((r) => ({ ingredient: r.item.english, cost: r.choice.cost }));

			const missing = lines
				.filter((l) => !l.choice)
				.map((l) => ({
					ingredient: l.item.english,
					reason:
						l.result.status === "error"
							? "lookup failed"
							: l.result.products.length === 0
								? "not found in this store"
								: l.excludedByAllergen === l.result.products.length
									? "every candidate matches an avoided allergen"
									: "price or unit not comparable",
				}));

			const output = {
				store: { chain, storeId },
				meals: inputs.map((m) => m.meal),
				toBuy: {
					total: buyTotal,
					lines: buy.map(lineOutput),
				},
				pantry: {
					total: sum(pantry, (r) => r.choice.cost),
					lines: pantry.map(lineOutput),
				},
				...(budget !== undefined && {
					budget: {
						limit: budget,
						status: buyTotal <= budget ? "within" : "over",
						difference: round2(Math.abs(budget - buyTotal)),
					},
				}),
				pooling: {
					boughtSeparately: separateTotal,
					pooled: buyTotal,
					saved: round2(separateTotal - buyTotal),
				},
				waste: { leftoverValue: wasteValue, alerts: wasteAlerts },
				costDrivers,
				...(missing.length > 0 && { missing }),
				...(unquantified.length > 0 && { unquantified }),
				note: "Totals are whole packs. leftoverValue prices the unused part at the product's unit price. no_match on allergens is not a safety guarantee: check labels.",
			};

			return {
				content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
			};
		},
	);
}
