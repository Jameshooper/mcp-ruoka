import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { RecipeInputSchema } from "./recipe-book.ts";
import { parseIngredient, webRecipeToInput } from "./web-import.ts";
import type { WebRecipe } from "./web-recipe.ts";

let dir = "";
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-import-"));
	process.env.RUOKA_DATA_DIR = dir;
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("ingredient lines become amounts in the recipe book's units", () => {
	expect(parseIngredient("500 g beef mince")).toMatchObject({
		english: "500 g beef mince",
		finnish: ["beef mince"],
		quantity: { amount: 500, unit: "g" },
	});
	expect(parseIngredient("500g beef mince").quantity).toEqual({ amount: 500, unit: "g" });
	expect(parseIngredient("1 1/2 cups milk").quantity).toEqual({ amount: 360, unit: "ml" });
	expect(parseIngredient("2 tbsp olive oil")).toMatchObject({
		finnish: ["olive oil"],
		pantry: true,
		quantity: { amount: 30, unit: "ml" },
	});
	expect(parseIngredient("2 dl kuohukermaa").quantity).toEqual({ amount: 200, unit: "ml" });
	expect(parseIngredient("1 prk ruokakermaa")).toMatchObject({ finnish: ["ruokakermaa"] });
	expect(parseIngredient("1 tl suolaa").pantry).toBe(true);
	expect(parseIngredient("1,5 kg perunoita").quantity).toEqual({ amount: 1.5, unit: "kg" });
	expect(parseIngredient("½ tsp salt")).toMatchObject({
		pantry: true,
		quantity: { amount: 2.5, unit: "ml" },
	});
	expect(parseIngredient("2-3 cloves garlic (crushed)").quantity).toEqual({
		amount: 2,
		unit: "pcs",
	});
	expect(parseIngredient("1 onion, finely chopped")).toMatchObject({
		finnish: ["onion"],
		quantity: { amount: 1, unit: "pcs" },
	});
	const unmeasured = parseIngredient("Salt and pepper to taste");
	expect(unmeasured.quantity).toBeUndefined();
	expect(unmeasured.finnish).toEqual(["Salt and pepper to taste"]);
});

const WEB: WebRecipe = {
	name: "Lohikeitto",
	source: "https://www.example.fi/lohikeitto",
	site: "example.fi",
	description: "Creamy salmon soup.",
	prepMinutes: 15,
	totalMinutes: 45,
	ingredients: ["400 g lohta", "6 perunaa", "2 dl kermaa"],
	steps: [
		{ section: "Soup", text: "Boil the potatoes." },
		{ section: "Soup", text: "Add the salmon." },
		{ text: "Serve with rye bread." },
	],
};

test("a web recipe becomes a valid recipe book entry, tagged for tidying", () => {
	const input = webRecipeToInput(WEB);
	expect(RecipeInputSchema.parse(input)).toBeTruthy();
	expect(input).toMatchObject({
		name: "Lohikeitto",
		servings: 4,
		tags: ["from-web"],
		prepMinutes: 15,
		steps: ["Soup: Boil the potatoes.", "Add the salmon.", "Serve with rye bread."],
	});
	expect(input.cookMinutes).toBeUndefined();
	expect(input.notes).toContain("https://www.example.fi/lohikeitto");
	expect(input.notes).toContain("saved as 4");

	const long = webRecipeToInput({
		...WEB,
		servings: 6,
		steps: Array.from({ length: 90 }, (_, i) => ({ text: `Step ${i + 1}.` })),
	});
	expect(long.steps.length).toBeLessThanOrEqual(40);
	expect(long.steps.join(" ")).toContain("Step 90.");
	expect(long.servings).toBe(6);

	expect(() =>
		webRecipeToInput({ ...WEB, ingredients: Array.from({ length: 41 }, () => "1 egg") }),
	).toThrow("41 ingredients");
	expect(() => webRecipeToInput({ ...WEB, steps: [] })).toThrow("no method");
});

const PAGE = `<script type="application/ld+json">${JSON.stringify({
	"@type": "Recipe",
	name: "Shared Pancakes",
	recipeYield: "4 servings",
	recipeIngredient: ["2 eggs", "3 dl milk", "1 dl flour"],
	recipeInstructions: [{ "@type": "HowToStep", text: "Whisk and fry." }],
})}</script>`;

const Reply = z.object({ message: z.string(), id: z.string().optional() });

test("share sheet to Ruoka: saved once, then reported as already there", async () => {
	const { handleUiRequest, setWebFetchForTests } = await import("./ui-server.ts");
	const { findRecipe } = await import("./recipe-book.ts");
	setWebFetchForTests(async () => new Response(PAGE, { headers: { "Content-Type": "text/html" } }));
	const send = () =>
		handleUiRequest(
			new Request("http://x/api/recipes/import-url", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: "https://www.example.com/pancakes" }),
			}),
		);

	const first = await send();
	expect(first.status).toBe(200);
	expect(Reply.parse(await first.json()).message).toBe('Saved "Shared Pancakes" to Ruoka');
	const saved = await findRecipe("Shared Pancakes");
	expect(saved?.tags).toEqual(["from-web"]);
	expect(saved?.ingredients[1]?.quantity).toEqual({ amount: 300, unit: "ml" });

	const again = await send();
	expect(again.status).toBe(409);
	expect(Reply.parse(await again.json()).message).toBe('"Shared Pancakes" is already in Ruoka');

	setWebFetchForTests(async () => new Response("<html>No recipe</html>"));
	const none = await send();
	expect(none.status).toBe(422);
	expect(Reply.parse(await none.json()).message).toBe("No recipe found on that page");
	setWebFetchForTests(fetch);
});
