import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { registerMealPlanTool } from "./meal-plan.ts";
import { registerPlanBookTools } from "./plan-book.ts";
import { registerRecipeTool } from "./recipe.ts";
import { registerRecipeBookTools } from "./recipe-book.ts";
import { registerStoresTool } from "./stores.ts";

let dir = "";
let client: Client;
const realFetch = globalThis.fetch;
let upstreamCalls = 0;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-tools-"));
	process.env.RUOKA_DATA_DIR = dir;
	// Nothing in these tests may reach a retailer: any outbound call is counted and refused
	globalThis.fetch = Object.assign(
		async () => {
			upstreamCalls++;
			throw new Error("network disabled in tests");
		},
		{ preconnect: () => {} },
	);
	const server = new McpServer({ name: "test", version: "1" });
	// recipe.test.ts and meal-plan.test.ts replace ./search.ts with a stub for the whole test
	// process; the query string gives this file the real module
	const search: unknown = await import(`./search.ts?${"real"}`);
	if (
		typeof search !== "object" ||
		search === null ||
		!("registerSearchTool" in search) ||
		typeof search.registerSearchTool !== "function"
	) {
		throw new Error("search tool module not found");
	}
	search.registerSearchTool(server);
	registerStoresTool(server);
	registerRecipeTool(server);
	registerRecipeBookTools(server);
	registerMealPlanTool(server);
	registerPlanBookTools(server);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	client = new Client({ name: "test", version: "1" });
	await client.connect(clientSide);
});

afterAll(async () => {
	globalThis.fetch = realFetch;
	await client.close();
	await rm(dir, { recursive: true, force: true });
});

// AZ-01, AZ-07
test("every tool says whether it changes data, deletes are marked destructive, and there is no backup tool", async () => {
	const { tools } = await client.listTools();
	const byName = new Map(tools.map((t) => [t.name, t.annotations]));
	expect([...byName.keys()].sort()).toEqual(
		[
			"delete_meal_plan",
			"delete_recipe",
			"find_recipe_ingredients",
			"get_meal_plan",
			"get_recipe",
			"get_stores",
			"list_meal_plans",
			"list_recipes",
			"plan_meals",
			"rate_meal_plan",
			"rate_recipe",
			"save_recipe",
			"search_products",
		].sort(),
	);
	for (const [name, annotations] of byName) {
		expect(typeof annotations?.readOnlyHint).toBe("boolean");
		if (name.startsWith("delete_")) {
			expect(annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		}
		if (/^(list|get|search)_/.test(name)) expect(annotations?.readOnlyHint).toBe(true);
	}
});

const ResultSchema = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

async function rejected(name: string, args: Record<string, unknown>): Promise<boolean> {
	try {
		const result = ResultSchema.parse(await client.callTool({ name, arguments: args }));
		return result.isError === true;
	} catch {
		return true;
	}
}

const ingredient = { english: "rice", finnish: ["riisi"], quantity: { amount: 400, unit: "g" } };
const recipeArgs = {
	name: "Rice",
	servings: 2,
	steps: ["Cook"],
	tags: [],
	ingredients: [ingredient],
};

// API-08
test("oversized free text is refused before anything is saved or looked up", async () => {
	upstreamCalls = 0;
	const huge = "x".repeat(2001);
	expect(
		await rejected("search_products", { query: "q".repeat(201), chain: "s-kaupat", storeId: "1" }),
	).toBe(true);
	expect(
		await rejected("search_products", {
			query: "maito",
			chain: "s-kaupat",
			storeId: "9".repeat(65),
		}),
	).toBe(true);
	expect(await rejected("get_stores", { city: "c".repeat(101) })).toBe(true);
	expect(
		await rejected("find_recipe_ingredients", {
			chain: "s-kaupat",
			storeId: "1",
			ingredients: [{ ...ingredient, english: "e".repeat(301) }],
		}),
	).toBe(true);
	expect(
		await rejected("find_recipe_ingredients", {
			chain: "s-kaupat",
			storeId: "1",
			ingredients: [ingredient],
			avoidAllergens: ["a".repeat(61)],
		}),
	).toBe(true);
	expect(await rejected("save_recipe", { ...recipeArgs, steps: [huge] })).toBe(true);
	expect(
		await rejected("save_recipe", {
			...recipeArgs,
			ingredients: [{ ...ingredient, finnish: ["f".repeat(101)] }],
		}),
	).toBe(true);
	expect(
		await rejected("plan_meals", {
			chain: "s-kaupat",
			storeId: "1",
			meals: [{ name: "n".repeat(121), servings: 2, ingredients: [ingredient] }],
		}),
	).toBe(true);
	expect(await rejected("get_recipe", { recipe: "r".repeat(121) })).toBe(true);
	expect(await rejected("delete_meal_plan", { plan: "p".repeat(121) })).toBe(true);
	// numbers JSON can carry but no recipe can use
	expect(await rejected("save_recipe", { ...recipeArgs, servings: 1e308 })).toBe(true);
	expect(
		await rejected("save_recipe", {
			...recipeArgs,
			ingredients: [{ ...ingredient, quantity: { amount: -5, unit: "g" } }],
		}),
	).toBe(true);
	expect(upstreamCalls).toBe(0);

	const list = ResultSchema.parse(await client.callTool({ name: "list_recipes", arguments: {} }));
	expect(list.content[0]?.text).toContain('"count": 0');

	// the limits leave normal use alone
	expect(await rejected("save_recipe", recipeArgs)).toBe(false);
});
