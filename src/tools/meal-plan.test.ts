import { expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RUOKA_DATA_DIR = await mkdtemp(join(tmpdir(), "ruoka-plan-"));

const CARROTS = [
	{ name: "Carrots 1 kg", price: 1.19, unitPrice: "1,19 €/kg", id: "111" },
	{ name: "Carrots 500 g", price: 0.95, unitPrice: "1,90 €/kg", id: "112" },
];
const RICE = [{ name: "Rice 1 kg", price: 2.75, unitPrice: "2,75 €/kg", id: "211" }];

mock.module("./search.ts", () => ({
	registerSearchTool: () => {},
	runSearch: async (_chain: string, query: string) => {
		if (query === "rikki") throw new Error("S-Kaupat API HTTP 403");
		return {
			products: (query === "porkkana" ? CARROTS : query === "riisi" ? RICE : []).map((p) => ({
				...p,
				imageUrl: null,
				brand: null,
				category: null,
				url: null,
			})),
			totalCount: 1,
			query,
			storeId: "S",
			chain: "s-kaupat",
		};
	},
}));

// Every product lookup answers with an empty-but-valid body unless a test overrides fetch
function stubBody(input: Request | URL | string, extra: Record<string, unknown> = {}) {
	const q =
		new URL(
			typeof input === "string" ? input : input instanceof URL ? input : input.url,
		).searchParams.get("query") ?? "";
	const id = /id: "(\d+)"/.exec(q)?.[1] ?? "";
	const storeId = /storeId: "(\d+)"/.exec(q)?.[1] ?? "";
	return {
		q,
		id,
		body: {
			data: {
				product: {
					ean: id,
					storeId,
					location: null,
					allergens: [],
					ingredientStatement: null,
					productDetails: { nutrients: [] },
					...extra,
				},
			},
		},
	};
}

globalThis.fetch = (async (input: Request | URL | string) =>
	new Response(JSON.stringify(stubBody(input).body))) as typeof fetch;

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerMealPlanTool } = await import("./meal-plan.ts");
const { registerRecipeBookTools } = await import("./recipe-book.ts");
const { registerPlanBookTools } = await import("./plan-book.ts");

async function connect() {
	const server = new McpServer({ name: "t", version: "1" });
	registerMealPlanTool(server);
	registerRecipeBookTools(server);
	registerPlanBookTools(server);
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "1" });
	await Promise.all([server.connect(a), client.connect(b)]);
	return client;
}

function parse(res: unknown) {
	const content = (res as { content: Array<{ text: string }> }).content;
	return JSON.parse(content[0]?.text ?? "");
}

test("a saved recipe and an inline meal share one pack of carrots", async () => {
	const client = await connect();
	await client.callTool({
		name: "save_recipe",
		arguments: {
			name: "Carrot rice",
			servings: 2,
			steps: ["Boil the rice", "Roast the carrots"],
			ingredients: [
				{ english: "carrots", finnish: ["porkkana"], quantity: { amount: 300, unit: "g" } },
				{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" } },
			],
		},
	});

	const out = parse(
		await client.callTool({
			name: "plan_meals",
			arguments: {
				chain: "s-kaupat",
				storeId: "1",
				budget: 3,
				meals: [
					{ name: "Mon", recipe: "carrot-rice", servings: 4 },
					{
						name: "Wed",
						servings: 2,
						ingredients: [
							{ english: "carrots", finnish: ["porkkana"], quantity: { amount: 300, unit: "g" } },
							{ english: "mystery", finnish: ["tuntematon"], quantity: { amount: 1, unit: "pcs" } },
						],
					},
				],
			},
		}),
	);

	const carrots = out.toBuy.lines.find((l: { ingredient: string }) => l.ingredient === "carrots");
	// Mon scaled 2 -> 4 servings: 600 g, plus 300 g on Wed
	expect(carrots.needed).toBe("900 g");
	expect(carrots.product).toBe("Carrots 1 kg");
	expect(carrots.packages).toBe(1);
	expect(out.pooling.boughtSeparately).toBeGreaterThan(out.pooling.pooled);
	expect(out.toBuy.total).toBe(3.94);
	expect(out.budget).toEqual({ limit: 3, status: "over", difference: 0.94 });
	expect(out.missing).toEqual([{ ingredient: "mystery", reason: "not found in this store" }]);
	// 600 g of the 1 kg rice is unused; the 100 g of carrots left over is too small to flag
	expect(out.waste.alerts).toHaveLength(1);
	expect(out.waste.alerts[0]).toContain("rice");
});

test("an unknown recipe is reported, not guessed", async () => {
	const client = await connect();
	const res = await client.callTool({
		name: "plan_meals",
		arguments: {
			chain: "s-kaupat",
			storeId: "1",
			meals: [{ name: "X", servings: 2, recipe: "nope" }],
		},
	});
	expect((res as { isError?: boolean }).isError).toBe(true);
});

test("balance and nutrition come from recipe tags and inline overrides", async () => {
	const client = await connect();
	await client.callTool({
		name: "save_recipe",
		arguments: {
			name: "Salmon bake",
			servings: 2,
			steps: ["Bake the salmon"],
			protein: "fish",
			vegetables: true,
			nutrition: { kcal: 620, proteinG: 38, carbsG: 55, fatG: 22 },
			ingredients: [{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" } }],
		},
	});
	const out = parse(
		await client.callTool({
			name: "plan_meals",
			arguments: {
				chain: "s-kaupat",
				storeId: "1",
				meals: [
					{ name: "Mon", recipe: "salmon-bake", servings: 2 },
					{
						name: "Tue",
						servings: 2,
						protein: "white_meat",
						vegetables: false,
						nutrition: { kcal: 700, proteinG: 45, carbsG: 60, fatG: 25 },
						ingredients: [
							{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" } },
						],
					},
				],
			},
		}),
	);
	expect(out.balance.balanced).toBe(false);
	expect(out.balance.counts.fish).toBe(1);
	// two meals cannot cover three categories, so only the missing vegetables are reported
	expect(out.balance.issues).toHaveLength(1);
	expect(out.balance.issues[0]).toContain("Tue");
	expect(out.nutrition.average).toEqual({ kcalPerPortion: 660, proteinPerPortionG: 41.5 });
});

test("saveAs stores the plan and replacing it keeps still-valid ticks", async () => {
	const { findPlan, listPlans, setChecked } = await import("../plan-book.ts");
	const client = await connect();
	const args = {
		chain: "s-kaupat",
		storeId: "1",
		budget: 10,
		saveAs: "Week 42",
		meals: [
			{
				name: "Mon",
				servings: 2,
				protein: "fish",
				vegetables: true,
				ingredients: [
					{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" } },
				],
			},
		],
	};
	const first = parse(await client.callTool({ name: "plan_meals", arguments: args }));
	expect(first.saved).toEqual({ id: "week-42", name: "Week 42", replaced: false });

	const plan = await findPlan("WEEK 42");
	expect(plan?.toBuy.lines[0]?.productId).toBe("211");
	expect(plan?.budget).toBe(10);
	expect(plan?.meals[0]?.protein).toBe("fish");

	// unknown ids are dropped, known ones kept
	expect((await setChecked("week-42", ["211", "999"]))?.checked).toEqual(["211"]);
	const second = parse(await client.callTool({ name: "plan_meals", arguments: args }));
	expect(second.saved.replaced).toBe(true);
	expect((await findPlan("week-42"))?.checked).toEqual(["211"]);
	expect((await listPlans()).filter((p) => p.id === "week-42")).toHaveLength(1);

	const listed = parse(await client.callTool({ name: "list_meal_plans", arguments: {} }));
	expect(listed.plans.some((p: { id: string }) => p.id === "week-42")).toBe(true);
	const missing = await client.callTool({ name: "get_meal_plan", arguments: { plan: "nope" } });
	expect((missing as { isError?: boolean }).isError).toBe(true);
});

test("failed lookups are explained and an incomplete plan is not saved", async () => {
	const { findPlan } = await import("../plan-book.ts");
	const client = await connect();
	const out = parse(
		await client.callTool({
			name: "plan_meals",
			arguments: {
				chain: "s-kaupat",
				storeId: "1",
				saveAs: "Broken week",
				meals: [
					{
						name: "Mon",
						servings: 2,
						ingredients: [
							{ english: "broken", finnish: ["rikki"], quantity: { amount: 1, unit: "kg" } },
						],
					},
				],
			},
		}),
	);
	expect(out.missing).toEqual([
		{ ingredient: "broken", reason: "lookup failed: S-Kaupat API HTTP 403" },
	]);
	expect(out.lookupFailures).toBe(1);
	expect(out.saved.skipped).toBe(true);
	expect(await findPlan("broken-week")).toBeUndefined();
});

test("only the chosen product is allergen-checked, falling back when it is flagged", async () => {
	const seen: string[] = [];
	globalThis.fetch = (async (input: Request | URL | string) => {
		const { q, id, body } = stubBody(input, {
			ingredientStatement: input.toString().includes("111") ? "porkkana, pähkinä" : "porkkana",
		});
		if (q.includes("allergens")) seen.push(id);
		return new Response(JSON.stringify(body));
	}) as typeof fetch;
	const client = await connect();
	const out = parse(
		await client.callTool({
			name: "plan_meals",
			arguments: {
				chain: "s-kaupat",
				storeId: "1",
				avoidAllergens: ["pähkin"],
				meals: [
					{
						name: "Mon",
						servings: 2,
						ingredients: [
							{ english: "carrots", finnish: ["porkkana"], quantity: { amount: 700, unit: "g" } },
						],
					},
				],
			},
		}),
	);
	// the cheaper 1 kg bag (111) is flagged, so the 500 g bags (112) are used
	expect(seen).toEqual(["111", "112"]);
	expect(out.toBuy.lines[0].productId).toBe("112");
});

test("ingredients that could not be priced are saved with the plan", async () => {
	const { findPlan } = await import("../plan-book.ts");
	const client = await connect();
	const out = parse(
		await client.callTool({
			name: "plan_meals",
			arguments: {
				chain: "s-kaupat",
				storeId: "1",
				saveAs: "Gaps week",
				meals: [
					{
						name: "Mon",
						servings: 2,
						ingredients: [
							{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" } },
							{ english: "mystery", finnish: ["tuntematon"], quantity: { amount: 1, unit: "kg" } },
							{ english: "salt", finnish: ["suola"] },
						],
					},
				],
			},
		}),
	);
	expect(out.saved.id).toBe("gaps-week");
	const plan = await findPlan("gaps-week");
	expect(plan?.missing).toEqual([{ ingredient: "mystery", reason: "not found in this store" }]);
	expect(plan?.unquantified).toEqual([{ meal: "Mon", ingredient: "salt" }]);

	const listed = parse(await client.callTool({ name: "list_meal_plans", arguments: {} }));
	const entry = listed.plans.find((p: { id: string }) => p.id === "gaps-week");
	expect(entry.notPriced).toBe(2);
});

test("plans carry calories from the store labels and the method of each meal", async () => {
	const { findPlan } = await import("../plan-book.ts");
	globalThis.fetch = (async (input: Request | URL | string) => {
		const { id, body } = stubBody(
			input,
			id211(input)
				? {
						productDetails: {
							nutrients: [
								{
									referenceQuantity: "100 g",
									nutrients: [
										{ name: "Energia", value: "1 500 kJ / 358 kcal" },
										{ name: "Rasvaa", value: "1 g" },
										{ name: "Hiilihydraattia", value: "79 g" },
										{ name: "Proteiinia", value: "7 g" },
									],
								},
							],
						},
					}
				: {},
		);
		void id;
		return new Response(JSON.stringify(body));
	}) as typeof fetch;

	const client = await connect();
	const out = parse(
		await client.callTool({
			name: "plan_meals",
			arguments: {
				chain: "s-kaupat",
				storeId: "2", // a store no earlier test cached labels for
				saveAs: "Label week",
				meals: [
					{
						name: "Mon",
						servings: 2,
						steps: ["Boil the rice", "Serve"],
						ingredients: [
							{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" } },
							{ english: "eggs", finnish: ["kananmuna"], quantity: { amount: 2, unit: "pcs" } },
						],
					},
				],
			},
		}),
	);
	expect(out.nutrition.average).toEqual({ kcalPerPortion: 358, proteinPerPortionG: 7 });

	const meal = (await findPlan("label-week"))?.meals[0];
	expect(meal?.steps).toEqual(["Boil the rice", "Serve"]);
	// rice 200 g at 2.75 EUR/kg for 2 portions; the eggs are not in the store
	expect(meal?.cost).toEqual({ total: 0.55, perPortion: 0.28, complete: false });
	expect(out.mealCosts).toEqual([{ meal: "Mon", total: 0.55, perPortion: 0.28, complete: false }]);
	expect(meal?.nutrition).toEqual({
		kcal: 358,
		proteinG: 7,
		carbsG: 79,
		fatG: 1,
		source: "store_data",
		partial: true,
	});
});

function id211(input: Request | URL | string): boolean {
	return input.toString().includes("211");
}
