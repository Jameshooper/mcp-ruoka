import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	deleteRecipe,
	findRecipe,
	listRecipes,
	RecipeInputSchema,
	rateRecipe,
	saveRecipe,
	scaleRecipe,
} from "../recipe-book.ts";

function text(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function notFound(idOrName: string) {
	return {
		isError: true,
		content: [
			{
				type: "text" as const,
				text: `No saved recipe matches "${idOrName}". Call list_recipes to see what is saved.`,
			},
		],
	};
}

export function registerRecipeBookTools(server: McpServer): void {
	server.registerTool(
		"save_recipe",
		{
			description:
				"Save a recipe to the personal recipe book so it can be reused later, scaled to any number of servings, and combined into a meal plan. Saving with the same name replaces the earlier version. Ingredient quantities are the TOTAL for the given servings count; include the Finnish search terms so the recipe can be priced without translating again. Always also set `protein` (white_meat, red_meat, fish, vegetarian or other), `vegetables` (true when the meal includes vegetables or a salad) and `nutrition` per portion (kcal and grams of protein, estimated from the ingredients) so weekly plans can be balanced and checked. Also pass estimatedCost exactly as returned by find_recipe_ingredients, so the recipe keeps the price it had when it was created.",
			inputSchema: RecipeInputSchema,
		},
		async (input) => {
			const { recipe, replaced } = await saveRecipe(input);
			return text({ saved: recipe.id, replaced, name: recipe.name, servings: recipe.servings });
		},
	);

	server.registerTool(
		"list_recipes",
		{
			description:
				"List the saved recipes (id, name, servings, tags, rating out of 5, protein type, vegetables, nutrition per portion, ingredient count). Prefer well-rated recipes when planning meals. Use get_recipe for the full contents.",
			inputSchema: z.object({
				tag: z.string().optional().describe("Only recipes carrying this tag"),
			}),
		},
		async ({ tag }) => {
			const wanted = tag?.toLowerCase();
			const recipes = (await listRecipes()).filter(
				(r) => !wanted || r.tags.some((t) => t.toLowerCase() === wanted),
			);
			return text({
				count: recipes.length,
				recipes: recipes.map((r) => ({
					id: r.id,
					name: r.name,
					servings: r.servings,
					tags: r.tags,
					rating: r.rating ?? null,
					protein: r.protein ?? null,
					vegetables: r.vegetables ?? null,
					nutrition: r.nutrition ?? null,
					ingredients: r.ingredients.length,
				})),
			});
		},
	);

	server.registerTool(
		"get_recipe",
		{
			description:
				"Get one saved recipe by id or name, optionally with the quantities scaled to a different number of servings.",
			inputSchema: z.object({
				recipe: z.string().min(1).describe("Recipe id or name"),
				servings: z.number().int().positive().max(100).optional().describe("Scale to this many"),
			}),
		},
		async ({ recipe, servings }) => {
			const found = await findRecipe(recipe);
			if (!found) return notFound(recipe);
			return text(servings ? scaleRecipe(found, servings) : found);
		},
	);

	server.registerTool(
		"rate_recipe",
		{
			description:
				"Rate a saved recipe 1-5 stars, with an optional short review, when the user says how a meal turned out. The same rating can be set in the Recipes panel.",
			inputSchema: z.object({
				recipe: z.string().min(1).describe("Recipe id or name"),
				rating: z.number().int().min(1).max(5),
				review: z.string().max(2000).optional().describe("What worked or what to change"),
			}),
		},
		async ({ recipe, rating, review }) => {
			const updated = await rateRecipe(recipe, rating, review);
			return updated
				? text({ rated: updated.id, rating, review: updated.review ?? null })
				: notFound(recipe);
		},
	);

	server.registerTool(
		"delete_recipe",
		{
			description: "Delete a saved recipe by id or name. Only do this when the user asks.",
			inputSchema: z.object({ recipe: z.string().min(1).describe("Recipe id or name") }),
		},
		async ({ recipe }) => {
			const removed = await deleteRecipe(recipe);
			return removed ? text({ deleted: removed.id }) : notFound(recipe);
		},
	);
}
