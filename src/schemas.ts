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
