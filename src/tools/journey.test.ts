import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

// One whole conversation as Claude would hold it, through the real MCP tools: check a recipe's
// ingredients, save it, plan the week with it, then rate and tidy up. Only the retailer search is
// replaced, with a small fixed catalogue; everything else (pricing, pooling, saving, the files the
// recipe screens read) is the real code.

const CATALOGUE: Record<
	string,
	Array<{ name: string; price: number; unitPrice: string; id: string }>
> = {
	broileri: [
		{ name: "Broilerin fileesuikale 400 g", price: 4.99, unitPrice: "12,48 €/kg", id: "111" },
	],
	riisi: [{ name: "Jasmiiniriisi 1 kg", price: 2.75, unitPrice: "2,75 €/kg", id: "211" }],
	porkkana: [{ name: "Porkkana 1 kg", price: 1.29, unitPrice: "1,29 €/kg", id: "311" }],
	suola: [{ name: "Merisuola 1 kg", price: 0.89, unitPrice: "0,89 €/kg", id: "411" }],
	lohi: [{ name: "Lohifilee 400 g", price: 7.49, unitPrice: "18,73 €/kg", id: "511" }],
};

mock.module("./search.ts", () => ({
	registerSearchTool: () => {},
	runSearch: async (chain: string, query: string, storeId: string) => ({
		products: (CATALOGUE[query] ?? []).map((p) => ({
			...p,
			imageUrl: null,
			brand: null,
			category: null,
			url: null,
		})),
		totalCount: CATALOGUE[query]?.length ?? 0,
		query,
		storeId,
		chain,
	}),
}));

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerRecipeTool } = await import("./recipe.ts");
const { registerRecipeBookTools } = await import("./recipe-book.ts");
const { registerMealPlanTool } = await import("./meal-plan.ts");
const { registerPlanBookTools } = await import("./plan-book.ts");
const { handleUiRequest } = await import("../ui-server.ts");

let dir = "";
let client: InstanceType<typeof Client>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-journey-"));
	process.env.RUOKA_DATA_DIR = dir;
	// No product-detail lookups are asked for; any that slipped out would fail here, not go online
	globalThis.fetch = Object.assign(
		async () => {
			throw new Error("network disabled in tests");
		},
		{ preconnect: () => {} },
	);
	const server = new McpServer({ name: "test", version: "1" });
	registerRecipeTool(server);
	registerRecipeBookTools(server);
	registerMealPlanTool(server);
	registerPlanBookTools(server);
	const [a, b] = InMemoryTransport.createLinkedPair();
	client = new Client({ name: "test", version: "1" });
	await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
	globalThis.fetch = realFetch;
	await client.close();
	await rm(dir, { recursive: true, force: true });
});

const ToolResult = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
});

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
	const result = ToolResult.parse(await client.callTool({ name, arguments: args }));
	const text = result.content[0]?.text ?? "";
	if (result.isError) throw new Error(`${name} failed: ${text}`);
	return JSON.parse(text);
}

const ui = async (path: string): Promise<unknown> =>
	(await handleUiRequest(new Request(`http://x/${path}`))).json();

const store = { chain: "s-kaupat", storeId: "613756972", storeName: "Prisma Linnainmaa" };
const curry = [
	{ english: "chicken strips", finnish: ["broileri"], quantity: { amount: 400, unit: "g" } },
	{ english: "jasmine rice", finnish: ["riisi"], quantity: { amount: 300, unit: "g" } },
	{ english: "carrots", finnish: ["porkkana"], quantity: { amount: 300, unit: "g" } },
	{ english: "salt", finnish: ["suola"], pantry: true, quantity: { amount: 5, unit: "g" } },
];

test("check ingredients → save recipe → plan the week → rate → tidy up", async () => {
	// 1. Price the recipe at the store
	const checked = z
		.object({
			cost: z.object({ topMatch: z.object({ basketTotal: z.number(), usedTotal: z.number() }) }),
			pantryCost: z.object({ topMatch: z.object({ basketTotal: z.number() }) }),
			// passed on to save_recipe unchanged, as the tool asks, so every field is kept
			estimatedCost: z.looseObject({
				total: z.number(),
				perPortion: z.number(),
				storeName: z.string(),
				complete: z.boolean(),
			}),
			results: z.array(z.object({ english: z.string(), status: z.string() })),
		})
		.parse(await call("find_recipe_ingredients", { ...store, servings: 4, ingredients: curry }));
	expect(checked.results.map((r) => r.status)).toEqual(["found", "found", "found", "found"]);
	// to buy: chicken + rice + carrots, whole packs; salt is pantry and costed apart
	expect(checked.cost.topMatch.basketTotal).toBeCloseTo(4.99 + 2.75 + 1.29, 2);
	// pro rata: all the chicken, 300 g of 1 kg rice, 300 g of 1 kg carrots
	expect(checked.cost.topMatch.usedTotal).toBeCloseTo(4.99 + 0.83 + 0.39, 2);
	expect(checked.pantryCost.topMatch.basketTotal).toBeCloseTo(0.89, 2);
	expect(checked.estimatedCost).toMatchObject({
		storeName: "Prisma Linnainmaa",
		complete: true,
		perPortion: 1.55,
	});

	// 2. Save it with its method, tags and the price it had
	const saved = z.object({ saved: z.string(), replaced: z.boolean() }).parse(
		await call("save_recipe", {
			name: "Broileri-riisipata",
			servings: 4,
			ingredients: curry,
			steps: ["Brown the chicken", "Add rice, carrots and water", "Simmer 20 minutes"],
			tags: ["dinner"],
			prepMinutes: 15,
			cookMinutes: 25,
			protein: "white_meat",
			vegetables: true,
			estimatedCost: checked.estimatedCost,
		}),
	);
	expect(saved).toEqual({ saved: "broileri-riisipata", replaced: false });

	// it is now in the recipe book Claude reads and in the Recipes screen
	const listed = z
		.object({ count: z.number(), recipes: z.array(z.object({ id: z.string() })) })
		.parse(await call("list_recipes", {}));
	expect(listed.recipes.map((r) => r.id)).toContain("broileri-riisipata");
	const scaled = z
		.object({
			servings: z.number(),
			ingredients: z.array(z.object({ quantity: z.object({ amount: z.number() }) })),
		})
		.parse(await call("get_recipe", { recipe: "Broileri-riisipata", servings: 8 }));
	expect([scaled.servings, scaled.ingredients[0]?.quantity.amount]).toEqual([8, 800]);
	expect(await ui("api/recipes/broileri-riisipata")).toMatchObject({
		estimatedCost: { storeName: "Prisma Linnainmaa" },
		cookMinutes: 25,
	});

	// 3. Plan two dinners: the saved recipe and an inline fish meal sharing the carrots, then save
	const planned = z
		.object({
			saved: z.object({ id: z.string(), name: z.string(), replaced: z.boolean() }),
			toBuy: z.object({
				total: z.number(),
				lines: z.array(z.object({ productId: z.string(), usedIn: z.array(z.string()) })),
			}),
			pantry: z.object({ lines: z.array(z.object({ productId: z.string() })) }),
			// only present when something could not be priced
			missing: z.array(z.unknown()).optional(),
		})
		.parse(
			await call("plan_meals", {
				...store,
				meals: [
					{
						name: "Wed dinner",
						dish: "Broileri-riisipata",
						recipe: "broileri-riisipata",
						servings: 5,
					},
					{
						name: "Thu dinner",
						dish: "Uunilohi",
						servings: 5,
						protein: "fish",
						vegetables: true,
						steps: ["Bake the salmon with carrots"],
						ingredients: [
							{ english: "salmon", finnish: ["lohi"], quantity: { amount: 600, unit: "g" } },
							{ english: "carrots", finnish: ["porkkana"], quantity: { amount: 400, unit: "g" } },
						],
					},
				],
				saveAs: "Family plan test week",
			}),
		);
	expect(planned.saved).toEqual({
		id: "family-plan-test-week",
		name: "Family plan test week",
		replaced: false,
	});
	expect(planned.missing).toBeUndefined();
	// one bag of carrots serves both dinners
	const carrots = planned.toBuy.lines.filter((l) => l.productId === "311");
	expect(carrots).toHaveLength(1);
	expect(carrots[0]?.usedIn).toHaveLength(2);
	expect(planned.pantry.lines.map((l) => l.productId)).toEqual(["411"]);

	// the saved plan is what Claude and the Meal plans screen both see
	const plans = z
		.object({ plans: z.array(z.object({ id: z.string() })) })
		.parse(await call("list_meal_plans", {}));
	expect(plans.plans.map((p) => p.id)).toEqual(["family-plan-test-week"]);
	const fromTool = z
		.object({
			meals: z.array(z.object({ dish: z.string().optional(), steps: z.array(z.string()) })),
		})
		.parse(await call("get_meal_plan", { plan: "Family plan test week" }));
	expect(fromTool.meals.map((m) => m.dish)).toEqual(["Broileri-riisipata", "Uunilohi"]);
	expect(fromTool.meals[0]?.steps).toHaveLength(3);
	expect(await ui("api/plans/family-plan-test-week")).toMatchObject({
		store: { name: "Prisma Linnainmaa" },
		toBuy: { total: planned.toBuy.total },
	});

	// 4. After the week: rate the recipe and the plan; the screens show it
	await call("rate_recipe", { recipe: "broileri-riisipata", rating: 5, review: "Kids loved it" });
	await call("rate_meal_plan", { plan: "family-plan-test-week", rating: 4, review: "Good week" });
	expect(await ui("api/recipes/broileri-riisipata")).toMatchObject({
		rating: 5,
		review: "Kids loved it",
	});
	expect(await ui("api/plans/family-plan-test-week")).toMatchObject({
		rating: 4,
		review: "Good week",
	});

	// re-saving a tweaked recipe keeps its rating
	await call("save_recipe", {
		name: "Broileri-riisipata",
		servings: 4,
		ingredients: curry,
		steps: ["Brown the chicken", "Simmer"],
	});
	expect(await ui("api/recipes/broileri-riisipata")).toMatchObject({
		rating: 5,
		steps: ["Brown the chicken", "Simmer"],
	});

	// 5. Tidy up
	await call("delete_meal_plan", { plan: "family-plan-test-week" });
	await call("delete_recipe", { recipe: "broileri-riisipata" });
	expect(z.object({ count: z.number() }).parse(await call("list_recipes", {})).count).toBe(0);
	expect(
		(await handleUiRequest(new Request("http://x/api/plans/family-plan-test-week"))).status,
	).toBe(404);
});

test("an unknown recipe and a store with nothing are reported, not guessed", async () => {
	const unknownRecipe = await client.callTool({
		name: "plan_meals",
		arguments: { ...store, meals: [{ name: "Fri", recipe: "never-saved", servings: 2 }] },
	});
	expect(JSON.stringify(unknownRecipe)).toContain("never-saved");

	const nothing = z
		.object({
			summary: z.object({ storeNote: z.string().optional() }),
			results: z.array(z.object({ status: z.string() })),
			estimatedCost: z.object({ complete: z.boolean() }),
		})
		.parse(
			await call("find_recipe_ingredients", {
				...store,
				servings: 2,
				ingredients: [
					{ english: "unicorn", finnish: ["yksisarvinen"], quantity: { amount: 1, unit: "pcs" } },
				],
			}),
		);
	expect(nothing.results[0]?.status).toBe("not_found");
	expect(nothing.summary.storeNote).toContain("try another store");
	// a price missing ingredients is never presented as complete
	expect(nothing.estimatedCost.complete).toBe(false);
});
