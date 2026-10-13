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
	runSearch: async (_chain: string, query: string) => ({
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
	}),
}));

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerMealPlanTool } = await import("./meal-plan.ts");
const { registerRecipeBookTools } = await import("./recipe-book.ts");

async function connect() {
	const server = new McpServer({ name: "t", version: "1" });
	registerMealPlanTool(server);
	registerRecipeBookTools(server);
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
