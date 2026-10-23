import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-book-"));
	process.env.RUOKA_DATA_DIR = dir;
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const base = {
	name: "Kanacurry",
	servings: 4,
	ingredients: [
		{ english: "rice", finnish: ["riisi"], quantity: { amount: 400, unit: "g" as const } },
		{ english: "salt", finnish: ["suola"], pantry: true },
	],
	steps: ["Cook"],
	tags: ["dinner"],
};

test("save, list, get, replace, delete", async () => {
	const book = await import("./recipe-book.ts");
	expect((await book.saveRecipe(base)).replaced).toBe(false);
	expect((await book.saveRecipe({ ...base, notes: "v2" })).replaced).toBe(true);

	const list = await book.listRecipes();
	expect(list).toHaveLength(1);
	expect(list[0]?.id).toBe("kanacurry");
	expect((await book.findRecipe("KANACURRY"))?.notes).toBe("v2");

	const scaled = book.scaleRecipe(list[0] as (typeof list)[number], 8);
	expect(scaled.ingredients[0]?.quantity?.amount).toBe(800);
	expect(scaled.ingredients[1]?.quantity).toBeUndefined();

	expect((await book.deleteRecipe("kanacurry"))?.id).toBe("kanacurry");
	expect(await book.listRecipes()).toHaveLength(0);
});

test("slugify strips diacritics", async () => {
	const { slugify } = await import("./recipe-book.ts");
	expect(slugify("Hernekeitto & Pääsiäislaatikko!")).toBe("hernekeitto-paasiaislaatikko");
	expect(slugify("???")).toBe("recipe");
});

test("a corrupt file is an error, not an empty book", async () => {
	const book = await import("./recipe-book.ts");
	await writeFile(join(dir, "recipes.json"), "{not json");
	await expect(book.listRecipes()).rejects.toThrow();
	await expect(book.saveRecipe(base)).rejects.toThrow();
});

test("concurrent saves are all kept", async () => {
	const book = await import("./recipe-book.ts");
	await rm(join(dir, "recipes.json"), { force: true });
	await Promise.all(["a", "b", "c", "d"].map((name) => book.saveRecipe({ ...base, name })));
	expect(await book.listRecipes()).toHaveLength(4);
});

test("different names that slugify alike do not replace each other", async () => {
	const { saveRecipe, listRecipes, findRecipe, uniqueId } = await import("./recipe-book.ts");
	const first = await saveRecipe({ ...base, name: "Chicken curry" });
	const second = await saveRecipe({ ...base, name: "Chicken Curry!" });
	expect(second.replaced).toBe(false);
	expect([first.recipe.id, second.recipe.id]).toEqual(["chicken-curry", "chicken-curry-2"]);
	// the same name (in any case) still updates in place
	const again = await saveRecipe({ ...base, name: "CHICKEN CURRY", servings: 6 });
	expect(again.replaced).toBe(true);
	expect(again.recipe.id).toBe("chicken-curry");
	expect((await findRecipe("chicken-curry-2"))?.name).toBe("Chicken Curry!");

	await saveRecipe({ ...base, name: "Борщ" });
	const shchi = await saveRecipe({ ...base, name: "Щи" });
	expect(shchi.replaced).toBe(false);
	const names = (await listRecipes()).map((r) => r.name);
	expect(names).toContain("Борщ");
	expect(names).toContain("Щи");

	expect(
		uniqueId("Soup", [
			{ id: "soup", name: "Other" },
			{ id: "soup-2", name: "More" },
		]),
	).toBe("soup-3");
});
