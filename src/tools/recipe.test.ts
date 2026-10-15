import { expect, mock, test } from "bun:test";

mock.module("./search.ts", () => ({
	registerSearchTool: () => {},
	runSearch: async (_chain: string, query: string) => ({
		products: [
			{
				name: `${query} product`,
				price: 2,
				unitPrice: "4,00 €/kg",
				id: query === "riisi" ? "211" : query === "voi" ? "311" : "411",
				imageUrl: null,
				brand: null,
				category: null,
				url: null,
			},
		],
		totalCount: 1,
		query,
		storeId: "S",
		chain: "s-kaupat",
	}),
}));

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerRecipeTool } = await import("./recipe.ts");

const TABLES: Record<string, Array<{ name: string; value: string }>> = {
	"211": [
		{ name: "Energia", value: "1 500 kJ / 358 kcal" },
		{ name: "Rasvaa", value: "1 g" },
		{ name: "Hiilihydraattia", value: "79 g" },
		{ name: "Proteiinia", value: "7 g" },
	],
	"311": [
		{ name: "Energia", value: "2 984 kJ / 713 kcal" },
		{ name: "Rasvaa", value: "80 g" },
		{ name: "Hiilihydraattia", value: "0,8 g" },
		{ name: "Proteiinia", value: "0,6 g" },
	],
};

test("includeNutrition totals the labels of the chosen products per portion", async () => {
	globalThis.fetch = (async (input: Request | URL | string) => {
		const q =
			new URL(
				typeof input === "string" ? input : input instanceof URL ? input : input.url,
			).searchParams.get("query") ?? "";
		const id = /id: "(\d+)"/.exec(q)?.[1] ?? "";
		const table = TABLES[id];
		return new Response(
			JSON.stringify({
				data: {
					product: {
						ean: id,
						storeId: "777",
						productDetails: {
							nutrients: table ? [{ nutrients: table, referenceQuantity: "100 g" }] : [],
						},
					},
				},
			}),
		);
	}) as typeof fetch;

	const server = new McpServer({ name: "t", version: "1" });
	registerRecipeTool(server);
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "c", version: "1" });
	await Promise.all([server.connect(a), client.connect(b)]);

	const res = await client.callTool({
		name: "find_recipe_ingredients",
		arguments: {
			chain: "s-kaupat",
			storeId: "777",
			storeName: "Prisma Linnainmaa",
			servings: 2,
			includeNutrition: true,
			ingredients: [
				{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" } },
				{ english: "butter", finnish: ["voi"], pantry: true, quantity: { amount: 20, unit: "g" } },
				{ english: "mystery", finnish: ["outo"], quantity: { amount: 100, unit: "g" } },
				{ english: "eggs", finnish: ["kananmuna"], quantity: { amount: 2, unit: "pcs" } },
			],
		},
	});
	const content = (res as { content: Array<{ text: string }> }).content;
	const out = JSON.parse(content[0]?.text ?? "");

	// rice 200 g = 716 kcal + butter 20 g = 142.6 kcal
	expect(out.nutrition.total.kcal).toBe(859);
	expect(out.nutrition.perPortion).toEqual({ kcal: 430, proteinG: 7.1, carbsG: 79.1, fatG: 9 });
	// rice 0.8 + mystery 0.4 pro-rata, butter 0.08 pantry; eggs (pieces) cannot be priced
	expect(out.estimatedCost).toMatchObject({
		total: 1.28,
		perPortion: 0.64,
		basketTotal: 4,
		chain: "s-kaupat",
		storeId: "777",
		storeName: "Prisma Linnainmaa",
		complete: false,
	});
	expect(out.nutrition.notCounted).toEqual([
		{ ingredient: "mystery", reason: "no nutrition table on the candidates" },
		{ ingredient: "eggs", reason: "quantity in pieces: give grams to count it" },
	]);
});
