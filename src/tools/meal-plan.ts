import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { assessBalance, type PlannedMeal, summarizeNutrition } from "../balance.ts";
import { getProductAllergens, matchAvoidTerms } from "../browser/s-kaupat-allergens.ts";
import { getProductLocation } from "../browser/s-kaupat-location.ts";
import { getProductNutrition } from "../browser/s-kaupat-nutrition.ts";
import { costProduct, toBase } from "../costing.ts";
import {
	type Macros,
	macrosFor,
	type Per100,
	quantityAmount,
	roundMacros,
	sumMacros,
} from "../nutrition.ts";
import { type PlanSnapshot, savePlan } from "../plan-book.ts";
import {
	choosePack,
	formatAmount,
	type MergedIngredient,
	mergeIngredients,
	mergeKey,
	type PackChoice,
} from "../planner.ts";
import { findRecipe, scaleRecipe } from "../recipe-book.ts";
import {
	type Ingredient,
	IngredientSchema,
	NutritionSchema,
	PROTEIN_CATEGORIES,
	ProteinSchema,
} from "../schemas.ts";
import { resolveStoreName } from "../store-names.ts";
import type { AllergenCheck, ProductLocation } from "../types.ts";
import { CALL_BUDGET_MS, mapPool, resolveIngredient } from "./recipe.ts";

const MealSchema = z.object({
	name: z.string().min(1).describe("Label for the meal, e.g. 'Mon dinner'"),
	servings: z.number().int().positive().max(100).describe("How many portions this meal makes"),
	dish: z
		.string()
		.min(1)
		.optional()
		.describe("What the dish is called, e.g. 'Chicken curry' (the name is only the slot)"),
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
	protein: ProteinSchema.optional().describe(
		"Main protein of an inline meal (a saved recipe brings its own); needed for the balance check",
	),
	vegetables: z
		.boolean()
		.optional()
		.describe("True if the meal includes vegetables or a salad; a saved recipe brings its own"),
	nutrition: NutritionSchema.optional().describe(
		"Optional override; by default calories and macros are calculated from the store's nutrition labels for the chosen products",
	),
	steps: z
		.array(z.string().min(1))
		.max(40)
		.optional()
		.describe("The method for an inline meal as ordered steps (a saved recipe brings its own)"),
	prepMinutes: z
		.number()
		.int()
		.min(0)
		.max(1440)
		.optional()
		.describe("Preparation time of an inline meal"),
	cookMinutes: z
		.number()
		.int()
		.min(0)
		.max(1440)
		.optional()
		.describe("Cooking time of an inline meal"),
});

type Meal = z.infer<typeof MealSchema>;

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

type ResolvedMeal = Omit<PlannedMeal, "name"> & {
	ingredients: Ingredient[];
	steps: string[];
	dish?: string;
	prepMinutes?: number;
	cookMinutes?: number;
	recipeId?: string;
	// What this meal's ingredients cost at the chosen products, pro-rata (only the amounts used)
	cost?: { total: number; perPortion: number; complete: boolean };
};

// Explicit fields on the meal override what the saved recipe says
async function resolveMeal(meal: Meal): Promise<ResolvedMeal | string> {
	const base = { servings: meal.servings };
	if (meal.recipe) {
		const recipe = await findRecipe(meal.recipe);
		if (!recipe) return `No saved recipe matches "${meal.recipe}"`;
		const protein = meal.protein ?? recipe.protein;
		const vegetables = meal.vegetables ?? recipe.vegetables;
		const nutrition = meal.nutrition ?? recipe.nutrition;
		const prepMinutes = meal.prepMinutes ?? recipe.prepMinutes;
		const cookMinutes = meal.cookMinutes ?? recipe.cookMinutes;
		return {
			...(prepMinutes !== undefined && { prepMinutes }),
			...(cookMinutes !== undefined && { cookMinutes }),
			...base,
			ingredients: scaleRecipe(recipe, meal.servings).ingredients,
			recipeId: recipe.id,
			steps: recipe.steps,
			dish: meal.dish ?? recipe.name,
			...(protein && { protein }),
			...(vegetables !== undefined && { vegetables }),
			...(nutrition && { nutrition }),
		};
	}
	if (meal.ingredients && meal.ingredients.length > 0) {
		return {
			...base,
			ingredients: meal.ingredients,
			steps: meal.steps ?? [],
			...(meal.dish && { dish: meal.dish }),
			...(meal.prepMinutes !== undefined && { prepMinutes: meal.prepMinutes }),
			...(meal.cookMinutes !== undefined && { cookMinutes: meal.cookMinutes }),
			...(meal.protein && { protein: meal.protein }),
			...(meal.vegetables !== undefined && { vegetables: meal.vegetables }),
			...(meal.nutrition && { nutrition: meal.nutrition }),
		};
	}
	return "Give either a saved `recipe` or `ingredients`";
}

async function shelfLocation(ean: string, storeId: string): Promise<ProductLocation | null> {
	try {
		return (await getProductLocation(ean, storeId)).location;
	} catch {
		return null;
	}
}

// Calories and macros per portion from the chosen products' label values, for meals that did not
// bring their own figures. Pieces and products without a label cannot be counted, so such meals
// are marked partial (a lower bound).
async function fillMealNutrition(
	meals: Array<ResolvedMeal & { name: string }>,
	shopping: Array<{ item: MergedIngredient; choice: PackChoice }>,
	chain: "k-ruoka" | "s-kaupat",
	storeId: string,
	deadline: number,
): Promise<void> {
	const targets = meals.filter((m) => !m.nutrition);
	if (chain !== "s-kaupat" || targets.length === 0) return;

	const productByKey = new Map(shopping.map((l) => [l.item.key, l.choice.product.id]));
	const per100 = new Map<string, Per100 | null>();
	const wanted = new Set<string>();
	for (const meal of targets) {
		for (const ingredient of meal.ingredients) {
			if (!ingredient.quantity) continue;
			const id = productByKey.get(mergeKey(ingredient, toBase(ingredient.quantity).dimension));
			if (id) wanted.add(id);
		}
	}
	await Promise.race([
		Promise.all(
			[...wanted].map((id) =>
				getProductNutrition(id, storeId).then((r) => {
					per100.set(id, r.per100);
				}),
			),
		),
		new Promise<void>((resolve) => setTimeout(resolve, Math.max(deadline - Date.now(), 1_000))),
	]);

	for (const meal of targets) {
		const parts: Macros[] = [];
		let quantified = 0;
		for (const ingredient of meal.ingredients) {
			if (!ingredient.quantity) continue;
			quantified++;
			const amount = quantityAmount(ingredient.quantity);
			const id = productByKey.get(mergeKey(ingredient, toBase(ingredient.quantity).dimension));
			const label = id ? per100.get(id) : undefined;
			if (amount && label) parts.push(macrosFor(label, amount.amount));
		}
		if (parts.length === 0) continue;
		const total = sumMacros(parts);
		const perPortion = roundMacros({
			kcal: total.kcal / meal.servings,
			proteinG: total.proteinG / meal.servings,
			carbsG: total.carbsG / meal.servings,
			fatG: total.fatG / meal.servings,
		});
		meal.nutrition = {
			...perPortion,
			source: "store_data",
			...(parts.length < quantified && { partial: true }),
		};
	}
}

// Each meal's own price: its ingredient amounts at the unit prices of the products the plan buys.
// Pooling changes what is bought, not what a meal's food is worth, so this is pro-rata.
function fillMealCosts(
	meals: ResolvedMeal[],
	shopping: Array<{ item: MergedIngredient; choice: PackChoice }>,
): void {
	const productByKey = new Map(shopping.map((l) => [l.item.key, l.choice.product]));
	for (const meal of meals) {
		let total = 0;
		let complete = true;
		for (const ingredient of meal.ingredients) {
			if (!ingredient.quantity) continue;
			const product = productByKey.get(mergeKey(ingredient, toBase(ingredient.quantity).dimension));
			const cost = product ? costProduct(product, ingredient.quantity) : null;
			if (cost?.status === "ok") total += cost.usedCost;
			else complete = false;
		}
		meal.cost = {
			total: round2(total),
			perPortion: round2(total / meal.servings),
			complete,
		};
	}
}

export function registerMealPlanTool(server: McpServer): void {
	server.registerTool(
		"plan_meals",
		{
			description:
				"Price a whole week's meals at one store as a single shopping list, to plan within a budget and cut food waste. Needs from every meal are pooled per ingredient, so one bag of carrots can serve several dinners; for each ingredient the tool picks the pack combination that covers the total, and reports what is left over and what it is worth. It also reports how much pooling saved compared to buying for each meal separately. You design the menu: call this, then read `wasteAlerts` (leftovers worth using up), `costDrivers` and the budget result, swap or add meals so leftovers get used (e.g. put leftover carrots into another dish), and call it again until the plan fits. Meals come from saved recipes (`recipe`) or inline `ingredients`. Mark staples with pantry: true; the budget covers only items to buy. The plan must also be balanced: every meal needs a protein type (white_meat, red_meat, fish, vegetarian) and vegetables or a salad, and the week should include white meat, red meat and fish with red meat kept in check. Saved recipes carry these tags; for inline meals set `protein` and `vegetables`. Prefer saved recipes (save_recipe first, with the method) so the method and ratings are kept; an inline meal should still pass its `steps`. Read `balance.issues` and fix them (swap meals, add a salad) together with the budget and waste alerts, then call again until `balance.balanced` is true. `nutrition` reports per-portion calories and protein from the recipes' estimates. Pass avoidAllergens to keep flagged products out. Prices are for the chosen store's online selection; stock is not exposed.",
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
			inputSchema: z.object({
				chain: z.enum(["k-ruoka", "s-kaupat"]),
				storeId: z.string().min(1).describe("Store ID from get_stores"),
				storeName: z
					.string()
					.min(1)
					.max(120)
					.optional()
					.describe(
						"The store's name as listed by get_stores (e.g. 'Prisma Linnainmaa'), shown on the saved plan",
					),
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
				saveAs: z
					.string()
					.min(1)
					.max(120)
					.optional()
					.describe(
						"Save the finished plan under this name so it appears in the Meal plans panel (shopping list with tick boxes, meals, totals). Only pass it on the final call, once budget, waste and balance are fine. Using the same name replaces the earlier plan.",
					),
				requireProteins: z
					.array(z.enum(PROTEIN_CATEGORIES))
					.optional()
					.default(["white_meat", "red_meat", "fish"])
					.describe("Protein types the week must include (default: white meat, red meat and fish)"),
				maxRedMeatMeals: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.default(2)
					.describe("Most red meat meals allowed in the plan (default 2)"),
				minProteinPerPortionG: z
					.number()
					.positive()
					.optional()
					.describe("Flag meals with less protein per portion than this"),
			}),
		},
		async ({
			chain,
			storeId,
			storeName,
			meals,
			budget,
			preference,
			avoidAllergens,
			includeLocation,
			saveAs,
			requireProteins,
			maxRedMeatMeals,
			minProteinPerPortionG,
		}) => {
			const deadline = Date.now() + CALL_BUDGET_MS;

			const resolved = await Promise.all(
				meals.map(async (meal) => ({ meal, content: await resolveMeal(meal) })),
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
			const resolvedMeals = resolved.flatMap(({ meal, content }) =>
				typeof content === "string" ? [] : [{ name: meal.name, ...content }],
			);
			const inputs = resolvedMeals.map((m) => ({ meal: m.name, ingredients: m.ingredients }));

			const { merged, unquantified } = mergeIngredients(inputs);
			const searched = await mapPool(merged, chain === "s-kaupat" ? 4 : 1, (item) =>
				resolveIngredient({ english: item.english, finnish: item.finnish }, chain, storeId, 5).then(
					(result) => ({ item, result }),
				),
			);

			const avoidTerms = avoidAllergens ?? [];
			// Only the product that would be bought is checked, then the next best if it is flagged:
			// checking every candidate of every ingredient is ~5x the requests and trips the
			// chain's rate limit on big plans
			const lines = await mapPool(
				searched,
				chain === "s-kaupat" ? 4 : 1,
				async ({ item, result }) => {
					let candidates = [...result.products];
					let excludedByAllergen = 0;
					for (;;) {
						const choice = choosePack(candidates, item, preference);
						if (!choice || chain !== "s-kaupat" || avoidTerms.length === 0) {
							return { item, result, choice, excludedByAllergen };
						}
						if (Date.now() > deadline) {
							choice.product.allergenCheck = { status: "pending", flags: [] };
							return { item, result, choice, excludedByAllergen };
						}
						const check = await getProductAllergens(choice.product.id, storeId).then(
							(details) => matchAvoidTerms(details, avoidTerms),
							(): AllergenCheck => ({ status: "unknown", flags: [] }),
						);
						choice.product.allergenCheck = check;
						if (check.status !== "flagged") return { item, result, choice, excludedByAllergen };
						excludedByAllergen++;
						candidates = candidates.filter((p) => p !== choice.product);
					}
				},
			);

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
			await fillMealNutrition(resolvedMeals, shopping, chain, storeId, deadline);
			fillMealCosts(resolvedMeals, shopping);
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
							? `lookup failed: ${l.result.error ?? "unknown error"}`
							: l.result.products.length === 0
								? "not found in this store"
								: l.excludedByAllergen === l.result.products.length
									? "every candidate matches an avoided allergen"
									: "price or unit not comparable",
				}));

			const resolvedName = await resolveStoreName(chain, storeId, storeName);
			const output = {
				store: { chain, storeId, ...(resolvedName && { name: resolvedName }) },
				meals: inputs.map((m) => m.meal),
				mealCosts: resolvedMeals.map((m) => ({ meal: m.name, ...m.cost })),
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
				balance: assessBalance(resolvedMeals, {
					requireProteins,
					maxRedMeatMeals,
					...(minProteinPerPortionG !== undefined && { minProteinG: minProteinPerPortionG }),
				}),
				nutrition: summarizeNutrition(resolvedMeals),
				costDrivers,
				...(missing.length > 0 && { missing }),
				...(unquantified.length > 0 && { unquantified }),
				note: "Totals are whole packs. leftoverValue prices the unused part at the product's unit price. no_match on allergens is not a safety guarantee: check labels.",
			};

			// A plan priced from failed lookups would understate the shopping list, so it is not kept
			const lookupFailures = lines.filter((l) => l.result.status === "error").length;
			const saveBlocked =
				saveAs && (shopping.length === 0 || lookupFailures > 0)
					? shopping.length === 0
						? "Nothing could be priced, so the plan was not saved."
						: `${lookupFailures} ingredient lookups failed, so the totals are incomplete and the plan was not saved.`
					: null;

			let saved: { id: string; name: string; replaced: boolean } | undefined;
			if (saveAs && !saveBlocked) {
				const snapshot: PlanSnapshot = {
					store: output.store,
					...(budget !== undefined && { budget }),
					meals: resolvedMeals.map(({ recipeId, ...meal }) => ({
						...meal,
						...(recipeId && { recipe: recipeId }),
					})),
					toBuy: output.toBuy,
					pantry: output.pantry,
					missing,
					unquantified,
					balance: output.balance,
					nutrition: output.nutrition,
					waste: { leftoverValue: output.waste.leftoverValue },
					pooling: { saved: output.pooling.saved },
				};
				const { plan, replaced } = await savePlan(saveAs, snapshot);
				saved = { id: plan.id, name: plan.name, replaced };
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								...output,
								...(lookupFailures > 0 && {
									lookupFailures,
									retryAdvice:
										"Lookups failed (see missing). If the reason is HTTP 403 the chain is rate limiting this server: wait a few minutes and call again rather than retrying at once.",
								}),
								...(saved && { saved }),
								...(saveBlocked && { saved: { skipped: true, reason: saveBlocked } }),
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}
