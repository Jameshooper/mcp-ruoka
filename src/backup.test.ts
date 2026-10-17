import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipFiles } from "./zip.ts";

let dir = "";
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-backup-"));
	process.env.RUOKA_DATA_DIR = dir;
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const recipe = (name: string, notes?: string) => ({
	name,
	servings: 4,
	steps: ["Cook"],
	tags: [],
	ingredients: [
		{ english: "rice", finnish: ["riisi"], quantity: { amount: 400, unit: "g" as const } },
	],
	...(notes && { notes }),
});

const enc = new TextEncoder();

test("export then import restores everything, with a safety copy", async () => {
	const { saveRecipe, rateRecipe, listRecipes, deleteRecipe } = await import("./recipe-book.ts");
	const { buildBackup, applyBackup, previewBackup } = await import("./backup.ts");
	await saveRecipe(recipe("Kanacurry"));
	await saveRecipe(recipe("Lohikeitto"));
	await rateRecipe("kanacurry", 5, "Great");

	const { bytes, counts } = await buildBackup();
	expect(counts).toEqual({ recipes: 2, plans: 0 });

	await deleteRecipe("kanacurry");
	await deleteRecipe("lohikeitto");
	await saveRecipe(recipe("Uusi"));

	const preview = await previewBackup(bytes);
	expect(preview.recipes).toEqual({ total: 2, existing: 0, new: 2 });

	const result = await applyBackup(bytes, "add");
	expect(result.recipes).toEqual({ added: 2, updated: 0, skipped: 0 });
	const names = (await listRecipes()).map((r) => r.id).sort();
	expect(names).toEqual(["kanacurry", "lohikeitto", "uusi"]);
	expect((await listRecipes()).find((r) => r.id === "kanacurry")?.rating).toBe(5);
	expect((await readdir(join(dir, "backups"))).length).toBe(1);
});

test("the three modes treat existing items differently", async () => {
	const { saveRecipe, listRecipes, findRecipe } = await import("./recipe-book.ts");
	const { buildBackup, applyBackup } = await import("./backup.ts");
	await saveRecipe(recipe("Mode test", "from backup"));
	const { bytes } = await buildBackup();
	await saveRecipe(recipe("Mode test", "edited since"));

	expect((await applyBackup(bytes, "add")).recipes?.skipped).toBeGreaterThan(0);
	expect((await findRecipe("mode-test"))?.notes).toBe("edited since");

	expect((await applyBackup(bytes, "update")).recipes?.updated).toBeGreaterThan(0);
	expect((await findRecipe("mode-test"))?.notes).toBe("from backup");

	await saveRecipe(recipe("Only in current"));
	await applyBackup(bytes, "replace");
	expect((await listRecipes()).some((r) => r.id === "only-in-current")).toBe(false);
	expect(await findRecipe("mode-test")).toBeDefined();
});

test("an invalid or foreign zip is refused before anything changes", async () => {
	const { saveRecipe, listRecipes } = await import("./recipe-book.ts");
	const { applyBackup, BackupError } = await import("./backup.ts");
	await saveRecipe(recipe("Keep me"));
	const before = (await listRecipes()).length;

	const bad = zipFiles([{ name: "recipes.json", data: enc.encode('{"recipes":[{"name":"x"}]}') }]);
	await expect(applyBackup(bad, "replace")).rejects.toThrow(BackupError);
	await expect(applyBackup(bad, "replace")).rejects.toThrow("recipes.json is not valid");

	const foreign = zipFiles([{ name: "notes.txt", data: enc.encode("hi") }]);
	await expect(applyBackup(foreign, "replace")).rejects.toThrow(
		"does not look like a Ruoka backup",
	);
	await expect(applyBackup(enc.encode("not a zip"), "add")).rejects.toThrow(BackupError);

	expect((await listRecipes()).length).toBe(before);
});

test("only the newest safety copies are kept", async () => {
	const { buildBackup, applyBackup } = await import("./backup.ts");
	const { bytes } = await buildBackup();
	for (let i = 0; i < 7; i++) await applyBackup(bytes, "add", new Date(2026, 0, 1, 0, 0, i));
	const copies = (await readdir(join(dir, "backups"))).filter((f) => f.endsWith(".zip"));
	expect(copies.length).toBe(5);
});
