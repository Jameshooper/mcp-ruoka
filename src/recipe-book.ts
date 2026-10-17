import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import {
	EstimatedCostSchema,
	type ImportMode,
	IngredientSchema,
	NutritionSchema,
	ProteinSchema,
	StoredNutritionSchema,
} from "./schemas.ts";

export const RecipeInputSchema = z.object({
	name: z.string().min(1).max(120),
	servings: z.number().int().positive().max(100),
	ingredients: z.array(IngredientSchema).min(1).max(40),
	steps: z
		.array(z.string().min(1))
		.min(1)
		.max(40)
		.describe(
			"The method as ordered steps (required: a saved recipe without its method is not usable)",
		),
	tags: z.array(z.string().min(1).max(40)).max(10).default([]),
	protein: ProteinSchema.optional(),
	vegetables: z
		.boolean()
		.optional()
		.describe("True when the meal includes vegetables or a salad (in the dish or as a side)"),
	nutrition: NutritionSchema.optional(),
	estimatedCost: EstimatedCostSchema.optional(),
	notes: z.string().max(2000).optional(),
});

const RecipeSchema = RecipeInputSchema.extend({
	id: z.string().min(1),
	// Recipes saved before the method was required may have none
	steps: z.array(z.string().min(1)).max(40).default([]),
	nutrition: StoredNutritionSchema.optional(),
	rating: z.number().int().min(1).max(5).optional(),
	review: z.string().max(2000).optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

const BookSchema = z.object({ recipes: z.array(RecipeSchema) });

export type Recipe = z.infer<typeof RecipeSchema>;
export type RecipeInput = z.infer<typeof RecipeInputSchema>;

// The directory must survive restarts (the Home Assistant app points it at /data)
function bookFile(): string {
	const dir = process.env.RUOKA_DATA_DIR ?? join(homedir(), ".mcp-ruoka");
	return join(dir, "recipes.json");
}

export function slugify(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "recipe";
}

async function readBook(): Promise<Recipe[]> {
	let text: string;
	try {
		text = await readFile(bookFile(), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	// A corrupt file must fail loudly: treating it as empty would overwrite the user's recipes
	return BookSchema.parse(JSON.parse(text)).recipes;
}

async function writeBook(recipes: Recipe[]): Promise<void> {
	const file = bookFile();
	await mkdir(join(file, ".."), { recursive: true });
	const temp = `${file}.tmp`;
	await writeFile(temp, JSON.stringify({ recipes }, null, 2));
	await rename(temp, file);
}

// Read-modify-write cycles run one at a time so concurrent saves cannot lose each other
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.catch(() => undefined);
	return run;
}

export function listRecipes(): Promise<Recipe[]> {
	return exclusive(readBook);
}

export function findRecipe(idOrName: string): Promise<Recipe | undefined> {
	const wanted = idOrName.trim().toLowerCase();
	return exclusive(async () =>
		(await readBook()).find((r) => r.id === wanted || r.name.toLowerCase() === wanted),
	);
}

export function saveRecipe(input: RecipeInput): Promise<{ recipe: Recipe; replaced: boolean }> {
	return exclusive(async () => {
		const recipes = await readBook();
		const id = slugify(input.name);
		const now = new Date().toISOString();
		const index = recipes.findIndex((r) => r.id === id);
		const previous = index >= 0 ? recipes[index] : undefined;
		// Re-saving a recipe (e.g. after tweaking it) must not wipe how the household rated it
		const recipe: Recipe = {
			...input,
			id,
			...(previous?.rating !== undefined && { rating: previous.rating }),
			...(previous?.review !== undefined && { review: previous.review }),
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
		};
		if (previous) recipes[index] = recipe;
		else recipes.push(recipe);
		await writeBook(recipes);
		return { recipe, replaced: previous !== undefined };
	});
}

// A null rating clears it; the review is replaced only when one is given
export function rateRecipe(
	idOrName: string,
	rating: number | null,
	review?: string,
): Promise<Recipe | undefined> {
	const wanted = idOrName.trim().toLowerCase();
	return exclusive(async () => {
		const recipes = await readBook();
		const index = recipes.findIndex((r) => r.id === wanted || r.name.toLowerCase() === wanted);
		const current = recipes[index];
		if (!current) return undefined;
		const { rating: _rating, review: previousReview, ...rest } = current;
		const nextReview = review ?? previousReview;
		const updated: Recipe = {
			...rest,
			...(rating !== null && { rating }),
			...(nextReview !== undefined && nextReview !== "" && { review: nextReview }),
		};
		recipes[index] = updated;
		await writeBook(recipes);
		return updated;
	});
}

export function deleteRecipe(idOrName: string): Promise<Recipe | undefined> {
	const wanted = idOrName.trim().toLowerCase();
	return exclusive(async () => {
		const recipes = await readBook();
		const index = recipes.findIndex((r) => r.id === wanted || r.name.toLowerCase() === wanted);
		const removed = recipes[index];
		if (!removed) return undefined;
		recipes.splice(index, 1);
		await writeBook(recipes);
		return removed;
	});
}

export function scaleRecipe(recipe: Recipe, servings: number): Recipe {
	const factor = servings / recipe.servings;
	return {
		...recipe,
		servings,
		ingredients: recipe.ingredients.map((ingredient) => {
			const { quantity } = ingredient;
			if (!quantity) return ingredient;
			return {
				...ingredient,
				quantity: { ...quantity, amount: Math.round(quantity.amount * factor * 100) / 100 },
			};
		}),
	};
}

export function parseRecipeBook(text: string): Recipe[] {
	return BookSchema.parse(JSON.parse(text)).recipes;
}

export interface ImportCounts {
	added: number;
	updated: number;
	skipped: number;
}

// Items match by id. "add" keeps what is already there, "update" lets the file win on a match,
// "replace" starts from an empty book.
export function mergeById<T extends { id: string }>(
	current: T[],
	incoming: T[],
	mode: ImportMode,
): { items: T[]; counts: ImportCounts } {
	const byId = new Map((mode === "replace" ? [] : current).map((item) => [item.id, item]));
	const counts: ImportCounts = { added: 0, updated: 0, skipped: 0 };
	for (const item of incoming) {
		if (!byId.has(item.id)) {
			byId.set(item.id, item);
			counts.added++;
		} else if (mode === "update") {
			byId.set(item.id, item);
			counts.updated++;
		} else {
			counts.skipped++;
		}
	}
	return { items: [...byId.values()], counts };
}

export function importRecipes(incoming: Recipe[], mode: ImportMode): Promise<ImportCounts> {
	return exclusive(async () => {
		const current = mode === "replace" ? [] : await readBook();
		const { items, counts } = mergeById(current, incoming, mode);
		await writeBook(items);
		return counts;
	});
}

// How many of the incoming recipes are new, without changing anything
export function previewRecipes(incoming: Recipe[]): Promise<{ total: number; existing: number }> {
	return exclusive(async () => {
		const ids = new Set((await readBook()).map((r) => r.id));
		return { total: incoming.length, existing: incoming.filter((r) => ids.has(r.id)).length };
	});
}
