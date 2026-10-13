import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

const RecipeJson = z.object({
	rating: z.number().optional(),
	review: z.string().optional(),
	ingredients: z.array(z.object({ quantity: z.object({ amount: z.number() }).optional() })),
});
const ListJson = z.object({ recipes: z.array(RecipeJson) });

let dir = "";

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-ui-"));
	process.env.RUOKA_DATA_DIR = dir;
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const recipe = {
	name: "Kanacurry",
	servings: 4,
	ingredients: [
		{ english: "rice", finnish: ["riisi"], quantity: { amount: 400, unit: "g" as const } },
	],
	steps: ["Cook"],
	tags: ["dinner"],
};

function put(path: string, body: unknown, contentType = "application/json") {
	return new Request(`http://x${path}`, {
		method: "PUT",
		headers: { "Content-Type": contentType },
		body: JSON.stringify(body),
	});
}

test("serves the page, lists, rates, scales and deletes", async () => {
	const { saveRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await saveRecipe(recipe);

	const page = await handleUiRequest(new Request("http://x/"));
	expect(page.headers.get("content-type")).toContain("text/html");
	expect(await page.text()).toContain("<title>Recipes</title>");

	const list = ListJson.parse(
		await (await handleUiRequest(new Request("http://x/api/recipes"))).json(),
	);
	expect(list.recipes).toHaveLength(1);

	const rated = await handleUiRequest(
		put("/api/recipes/kanacurry/rating", { rating: 4, review: "Good" }),
	);
	expect(rated.status).toBe(200);
	expect(RecipeJson.parse(await rated.json()).rating).toBe(4);

	const scaled = RecipeJson.parse(
		await (await handleUiRequest(new Request("http://x/api/recipes/kanacurry?servings=8"))).json(),
	);
	expect(scaled.ingredients[0]?.quantity?.amount).toBe(800);
	expect(scaled.rating).toBe(4);

	const cleared = RecipeJson.parse(
		await (await handleUiRequest(put("/api/recipes/kanacurry/rating", { rating: null }))).json(),
	);
	expect(cleared.rating).toBeUndefined();
	expect(cleared.review).toBe("Good");

	const del = await handleUiRequest(
		new Request("http://x/api/recipes/kanacurry", { method: "DELETE" }),
	);
	expect(del.status).toBe(200);
	expect((await handleUiRequest(new Request("http://x/api/recipes/kanacurry"))).status).toBe(404);
});

test("rejects bad ratings, non-JSON bodies and unknown paths", async () => {
	const { saveRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await saveRecipe(recipe);

	expect((await handleUiRequest(put("/api/recipes/kanacurry/rating", { rating: 9 }))).status).toBe(
		400,
	);
	expect(
		(await handleUiRequest(put("/api/recipes/kanacurry/rating", { rating: 3 }, "text/plain")))
			.status,
	).toBe(415);
	expect((await handleUiRequest(put("/api/recipes/nope/rating", { rating: 3 }))).status).toBe(404);
	expect((await handleUiRequest(new Request("http://x/elsewhere"))).status).toBe(404);
});

test("re-saving a recipe keeps its rating", async () => {
	const { saveRecipe, rateRecipe, findRecipe } = await import("./recipe-book.ts");
	await saveRecipe(recipe);
	await rateRecipe("kanacurry", 5, "Great");
	await saveRecipe({ ...recipe, notes: "tweaked" });
	const again = await findRecipe("kanacurry");
	expect(again?.rating).toBe(5);
	expect(again?.review).toBe("Great");
	expect(again?.notes).toBe("tweaked");
});
