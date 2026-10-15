import * as z from "zod/v4";

export const IngredientSchema = z.object({
	english: z.string().min(1).describe("Ingredient as written in the recipe (e.g., 'heavy cream')"),
	finnish: z
		.array(z.string().min(1))
		.min(1)
		.max(5)
		.describe(
			"Finnish search terms for this ingredient, best guess first, then alternatives or synonyms (e.g., ['kuohukerma', 'ruokakerma']). Use the base/singular store-style name, not an inflected form.",
		),
	pantry: z
		.boolean()
		.optional()
		.describe(
			"True for staples the cook probably already has (oil, salt, sugar, common dried spices, flour, stock cubes). They are still looked up and priced, but listed and costed separately from what must be bought.",
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

export type Ingredient = z.infer<typeof IngredientSchema>;

export const PROTEIN_CATEGORIES = [
	"white_meat",
	"red_meat",
	"fish",
	"vegetarian",
	"other",
] as const;

export const ProteinSchema = z
	.enum(PROTEIN_CATEGORIES)
	.describe(
		"Main protein of the meal: white_meat (chicken, turkey), red_meat (beef, pork, lamb, game, sausage), fish (fish and seafood), vegetarian (egg, dairy, legumes, tofu) or other",
	);

export type Protein = z.infer<typeof ProteinSchema>;

export const NutritionSchema = z
	.object({
		kcal: z.number().positive().max(5000),
		proteinG: z.number().nonnegative().max(500),
		carbsG: z.number().nonnegative().max(1000),
		fatG: z.number().nonnegative().max(500),
		source: z
			.enum(["store_data", "estimate"])
			.optional()
			.describe("store_data when calculated from the store's nutrition labels, otherwise estimate"),
	})
	.describe(
		"Nutrition PER PORTION (not per recipe): kcal, protein, carbs and fat in grams. Always give all four. Prefer the figures calculated by find_recipe_ingredients (includeNutrition) from the store's labels; estimate from the ingredients only when those are unavailable",
	);

// Recipes saved before carbs and fat were required stay readable
export const StoredNutritionSchema = NutritionSchema.extend({
	carbsG: z.number().nonnegative().max(1000).optional(),
	fatG: z.number().nonnegative().max(500).optional(),
});

export type Nutrition = z.infer<typeof NutritionSchema>;

export const EstimatedCostSchema = z
	.object({
		total: z
			.number()
			.nonnegative()
			.describe("EUR for the recipe's servings, pro-rata: only the amounts the recipe uses"),
		perPortion: z.number().nonnegative(),
		basketTotal: z
			.number()
			.nonnegative()
			.optional()
			.describe("EUR for the whole packs to buy, pantry staples excluded"),
		chain: z.enum(["k-ruoka", "s-kaupat"]),
		storeId: z.string(),
		pricedAt: z.string().describe("When the prices were looked up (ISO date)"),
		complete: z
			.boolean()
			.optional()
			.describe("False when some ingredients could not be priced, so the figure is a lower bound"),
	})
	.describe(
		"Price of the meal when it was created, as returned by find_recipe_ingredients (estimatedCost): pass it through unchanged",
	);

export type EstimatedCost = z.infer<typeof EstimatedCostSchema>;
