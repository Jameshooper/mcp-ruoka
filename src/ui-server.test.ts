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

const SNAPSHOT = {
	store: { chain: "s-kaupat" as const, storeId: "1", name: "Prisma Linnainmaa" },
	budget: 30,
	meals: [
		{
			name: "Mon",
			dish: "Rice bowl",
			servings: 2,
			steps: ["Cook"],
			cost: { total: 1.6, perPortion: 0.8, complete: true },
			ingredients: [
				{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" as const } },
			],
		},
	],
	toBuy: {
		total: 2.75,
		lines: [
			{
				ingredient: "rice",
				needed: "200 g",
				product: "Rice 1 kg",
				productId: "211",
				url: null,
				packSize: "1 kg",
				packages: 1,
				unitPrice: "2,75 €/kg",
				cost: 2.75,
				leftover: "800 g",
				leftoverValue: 2.2,
				usedIn: ["Mon: 200 g"],
				location: { aisle: "45", floor: 1 },
			},
		],
	},
	pantry: { total: 0, lines: [] },
	balance: { balanced: true, issues: [], counts: { fish: 1 } },
	nutrition: { average: null, missing: ["Mon"] },
	missing: [],
	unquantified: [],
	waste: { leftoverValue: 2.2 },
	pooling: { saved: 0 },
};

test("meal plans can be listed, ticked off and deleted", async () => {
	const { savePlan } = await import("./plan-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await savePlan("Week 42", SNAPSHOT);

	const PlansJson = z.object({
		plans: z.array(z.object({ id: z.string(), checked: z.array(z.string()) })),
	});
	const list = PlansJson.parse(
		await (await handleUiRequest(new Request("http://x/api/plans"))).json(),
	);
	expect(list.plans.map((p) => p.id)).toContain("week-42");

	const ticked = z
		.object({ checked: z.array(z.string()) })
		.parse(
			await (
				await handleUiRequest(put("/api/plans/week-42/checked", { checked: ["211", "x"] }))
			).json(),
		);
	expect(ticked.checked).toEqual(["211"]);

	expect(
		(await handleUiRequest(put("/api/plans/week-42/checked", { checked: [] }, "text/plain")))
			.status,
	).toBe(415);
	expect((await handleUiRequest(put("/api/plans/nope/checked", { checked: [] }))).status).toBe(404);

	const del = await handleUiRequest(
		new Request("http://x/api/plans/week-42", { method: "DELETE" }),
	);
	expect(del.status).toBe(200);
	expect((await handleUiRequest(new Request("http://x/api/plans/week-42"))).status).toBe(404);
});

test("a plan can be rated, and a meal saved as a recipe and linked", async () => {
	const { savePlan, findPlan } = await import("./plan-book.ts");
	const { findRecipe, deleteRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await savePlan("Rate me", SNAPSHOT);

	const rated = z
		.object({ rating: z.number().optional(), review: z.string().optional() })
		.parse(
			await (
				await handleUiRequest(put("/api/plans/rate-me/rating", { rating: 5, review: "Great week" }))
			).json(),
		);
	expect(rated).toEqual({ rating: 5, review: "Great week" });
	expect((await handleUiRequest(put("/api/plans/rate-me/rating", { rating: 7 }))).status).toBe(400);

	// re-saving the plan keeps the rating
	await savePlan("Rate me", SNAPSHOT);
	expect((await findPlan("rate-me"))?.rating).toBe(5);

	const post = (body: unknown) =>
		handleUiRequest(
			new Request("http://x/api/plans/rate-me/meals/0/recipe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	const saved = await post({ name: "Rice bowl special" });
	expect(saved.status).toBe(200);
	const recipe = await findRecipe("rice-bowl-special");
	expect(recipe?.servings).toBe(2);
	expect(recipe?.steps).toEqual(["Cook"]);
	expect(recipe?.ingredients[0]?.finnish).toEqual(["riisi"]);
	// the price at the time of the plan stays with the recipe
	expect(recipe?.estimatedCost).toMatchObject({
		total: 1.6,
		perPortion: 0.8,
		chain: "s-kaupat",
		storeId: "1",
		storeName: "Prisma Linnainmaa",
		complete: true,
	});
	expect(recipe?.estimatedCost?.pricedAt).toBe((await findPlan("rate-me"))?.updatedAt);
	expect((await findPlan("rate-me"))?.meals[0]?.recipe).toBe("rice-bowl-special");

	// a name that already exists is not replaced unless asked
	const clash = await post({ name: "Rice bowl special" });
	expect(clash.status).toBe(409);
	expect((await post({ name: "Rice bowl special", replace: true })).status).toBe(200);
	expect(
		(
			await handleUiRequest(
				new Request("http://x/api/plans/rate-me/meals/9/recipe", { method: "POST" }),
			)
		).status,
	).toBe(404);

	await deleteRecipe("rice-bowl-special");
});

test("remembered store names are served for display", async () => {
	const { rememberStores } = await import("./store-names.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await rememberStores([{ chain: "s-kaupat", id: "613756972", name: "Prisma Linnainmaa" }]);
	const body = z
		.object({ names: z.record(z.string(), z.string()) })
		.parse(await (await handleUiRequest(new Request("http://x/api/stores"))).json());
	expect(body.names["s-kaupat:613756972"]).toBe("Prisma Linnainmaa");
});

test("serves the app manifest and only the listed icons", async () => {
	const { handleUiRequest } = await import("./ui-server.ts");
	const manifest = z
		.object({
			display: z.string(),
			start_url: z.string(),
			icons: z.array(z.object({ src: z.string() })),
		})
		.parse(await (await handleUiRequest(new Request("http://x/manifest.webmanifest"))).json());
	expect(manifest.display).toBe("standalone");
	expect(manifest.start_url).toBe("./");

	const icon = await handleUiRequest(new Request("http://x/icons/apple-touch-icon.png"));
	expect(icon.status).toBe(200);
	expect(icon.headers.get("content-type")).toContain("image/png");
	for (const bad of ["/icons/secret.png", "/icons/..%2findex.html", "/icons/icon-192.png/extra"]) {
		expect((await handleUiRequest(new Request(`http://x${bad}`))).status).toBe(404);
	}
});

test("the standalone listener only admits allowed Tailscale logins", async () => {
	const { isAllowedTailnetUser } = await import("./ui-server.ts");
	const allowed = ["james@example.com"];
	expect(
		isAllowedTailnetUser(new Headers({ "Tailscale-User-Login": "James@Example.com" }), allowed),
	).toBe(true);
	expect(
		isAllowedTailnetUser(new Headers({ "Tailscale-User-Login": "other@example.com" }), allowed),
	).toBe(false);
	expect(isAllowedTailnetUser(new Headers(), allowed)).toBe(false);
	expect(isAllowedTailnetUser(new Headers({ "Tailscale-User-Login": "" }), allowed)).toBe(false);
});

test("the config endpoint gives the buttons that open Claude their defaults", async () => {
	const { handleUiRequest } = await import("./ui-server.ts");
	const Config = z.object({
		defaultStore: z
			.object({ chain: z.string(), id: z.string(), name: z.string().nullable() })
			.nullable(),
		promptNote: z.string(),
	});
	delete process.env.RUOKA_DEFAULT_STORE_ID;
	expect(
		Config.parse(await (await handleUiRequest(new Request("http://x/api/config"))).json())
			.defaultStore,
	).toBeNull();

	process.env.RUOKA_DEFAULT_STORE_ID = "613756972";
	process.env.RUOKA_DEFAULT_STORE_NAME = "Prisma Linnainmaa";
	process.env.RUOKA_CLAUDE_NOTE = "Avoid cashew.";
	const config = Config.parse(
		await (await handleUiRequest(new Request("http://x/api/config"))).json(),
	);
	expect(config.defaultStore).toEqual({
		chain: "s-kaupat",
		id: "613756972",
		name: "Prisma Linnainmaa",
	});
	expect(config.promptNote).toBe("Avoid cashew.");
	delete process.env.RUOKA_DEFAULT_STORE_ID;
	delete process.env.RUOKA_DEFAULT_STORE_NAME;
	delete process.env.RUOKA_CLAUDE_NOTE;
});
