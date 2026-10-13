import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { IngredientSchema } from "./schemas.ts";

export const RecipeInputSchema = z.object({
	name: z.string().min(1).max(120),
	servings: z.number().int().positive().max(100),
	ingredients: z.array(IngredientSchema).min(1).max(40),
	steps: z.array(z.string().min(1)).max(40).default([]),
	tags: z.array(z.string().min(1).max(40)).max(10).default([]),
	notes: z.string().max(2000).optional(),
});

const RecipeSchema = RecipeInputSchema.extend({
	id: z.string().min(1),
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
		const recipe: Recipe = { ...input, id, createdAt: previous?.createdAt ?? now, updatedAt: now };
		if (previous) recipes[index] = recipe;
		else recipes.push(recipe);
		await writeBook(recipes);
		return { recipe, replaced: previous !== undefined };
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
