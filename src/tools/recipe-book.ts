import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { deleteDraft, listDrafts } from "../draft-book.ts";
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
				"Save a recipe to the personal recipe book so it can be reused later, scaled to any number of servings, and combined into a meal plan. Saving with the same name replaces the earlier version. Ingredient quantities are the TOTAL for the given servings count; include the Finnish search terms so the recipe can be priced without translating again. Always also set `prepMinutes` (hands-on preparation) and `cookMinutes` (cooking time) so the recipe list can show how long it takes. Always also set `protein` (white_meat, red_meat, fish, vegetarian or other), `vegetables` (true when the meal includes vegetables or a salad) and `nutrition` per portion (kcal and grams of protein, estimated from the ingredients) so weekly plans can be balanced and checked. Also pass estimatedCost exactly as returned by find_recipe_ingredients, so the recipe keeps the price it had when it was created. For a dish cooked sous vide (in the water bath), also set `sousVide` (protein type, core temperature, thickness, offset, finishing step), starting from a preset in list_sous_vide_presets, so it can be started from the Recipes panel or start_sous_vide.",
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			inputSchema: RecipeInputSchema.extend({
				fromDraft: z
					.string()
					.max(100)
					.optional()
					.describe(
						"When this recipe was made from an inbox draft (list_recipe_drafts), its id: the draft is removed once the recipe is saved",
					),
			}),
		},
		async ({ fromDraft, ...input }) => {
			const { recipe, replaced } = await saveRecipe(input);
			const draftRemoved = fromDraft ? (await deleteDraft(fromDraft)) !== undefined : undefined;
			return text({
				saved: recipe.id,
				replaced,
				name: recipe.name,
				servings: recipe.servings,
				...(draftRemoved !== undefined && { draftRemoved }),
			});
		},
	);

	server.registerTool(
		"list_recipe_drafts",
		{
			description:
				"List the recipe inbox: posts the user shared from Instagram to Ruoka, kept as their caption text because they carry no recipe data. Call this when the user asks about the inbox, shared or Instagram recipes, or to tidy imported recipes. For each draft, read the caption and save a proper recipe with save_recipe (the dish name, servings, ingredients with total quantities and Finnish base-form search terms, steps, times, protein, vegetables and nutrition; put the source link in notes) passing fromDraft with the draft's id. If a caption has no actual recipe (e.g. 'comment for the recipe'), tell the user and ask before deleting it with delete_recipe_draft. Recipes saved from recipe websites are tagged from-web and may still need Finnish search terms: list_recipes with tag from-web finds them.",
			annotations: { readOnlyHint: true },
			inputSchema: z.object({}),
		},
		async () => {
			const drafts = await listDrafts();
			return text({ count: drafts.length, drafts });
		},
	);

	server.registerTool(
		"delete_recipe_draft",
		{
			description:
				"Remove a draft from the recipe inbox without saving it, e.g. when its caption has no recipe. Only when the user agrees.",
			annotations: { readOnlyHint: false, destructiveHint: true },
			inputSchema: z.object({ draft: z.string().min(1).max(100).describe("Draft id") }),
		},
		async ({ draft }) => {
			const removed = await deleteDraft(draft);
			return removed
				? text({ deleted: removed.id })
				: {
						isError: true,
						content: [{ type: "text" as const, text: `No draft "${draft}" in the inbox.` }],
					};
		},
	);

	server.registerTool(
		"list_recipes",
		{
			description:
				"List the saved recipes (id, name, servings, tags, rating out of 5, prep and cook minutes, protein type, vegetables, nutrition per portion, ingredient count). Prefer well-rated recipes when planning meals. Use get_recipe for the full contents.",
			annotations: { readOnlyHint: true },
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
					prepMinutes: r.prepMinutes ?? null,
					cookMinutes: r.cookMinutes ?? null,
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
			annotations: { readOnlyHint: true },
			inputSchema: z.object({
				recipe: z.string().min(1).max(120).describe("Recipe id or name"),
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
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			inputSchema: z.object({
				recipe: z.string().min(1).max(120).describe("Recipe id or name"),
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
			annotations: { readOnlyHint: false, destructiveHint: true },
			inputSchema: z.object({ recipe: z.string().min(1).max(120).describe("Recipe id or name") }),
		},
		async ({ recipe }) => {
			const removed = await deleteRecipe(recipe);
			return removed ? text({ deleted: removed.id }) : notFound(recipe);
		},
	);
}
