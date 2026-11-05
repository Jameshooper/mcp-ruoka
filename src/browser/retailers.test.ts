import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod/v4";
import * as alko from "./alko.ts";
import { resetGuardForTests, tuning } from "./http-retry.ts";
import * as kRuoka from "./k-ruoka.ts";
import * as sKaupat from "./s-kaupat.ts";
import { getProductAllergens, matchAvoidTerms } from "./s-kaupat-allergens.ts";
import { getProductLocation } from "./s-kaupat-location.ts";
import { getProductNutrition } from "./s-kaupat-nutrition.ts";

// Saved responses in each chain's own format (see fixtures/README.md): these tests check that the
// clients read them into the products, prices, stores and labels the tools rely on, offline

const fixture = async (name: string): Promise<unknown> =>
	JSON.parse(await readFile(join(import.meta.dirname, "fixtures", name), "utf8"));

const realFetch = globalThis.fetch;
const originalTuning = { ...tuning };
let requested: string[] = [];

// Product-detail lookups go through fetch; answer them from a fixture and record what was asked
function serve(body: unknown, status = 200): void {
	globalThis.fetch = Object.assign(
		async (input: Request | URL | string) => {
			requested.push(String(input));
			return new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		},
		{ preconnect: () => {} },
	);
}

beforeAll(() => {
	tuning.spacingMs = 0;
	tuning.backoffMs = [1, 1];
});
afterEach(() => {
	globalThis.fetch = realFetch;
	requested = [];
	resetGuardForTests();
});
afterAll(() => {
	Object.assign(tuning, originalTuning);
});

test("S-Kaupat: search results become products with the current price, unit price and links", async () => {
	const result = sKaupat.parseSearchResponse(
		await fixture("s-kaupat-search.json"),
		"maito",
		"613756972",
	);
	expect(result).toMatchObject({
		chain: "s-kaupat",
		query: "maito",
		storeId: "613756972",
		totalCount: 47,
	});
	expect(result.products).toEqual([
		{
			name: "Valio täysmaito 1 l",
			// the campaign or current price wins over the list price
			price: 1.39,
			unitPrice: "1,39 €/ltr",
			id: "6408430000098",
			imageUrl: "https://cdn.s-cloud.fi/v1/w_200,h_200/6408430000098.png",
			brand: "Valio",
			category: "Maito",
			url: "https://www.s-kaupat.fi/tuote/valio-taysmaito-1-l/6408430000098",
		},
		{
			name: "Rainbow kevytmaito 1,5 l",
			price: 1.49,
			unitPrice: null,
			id: "6415712000013",
			imageUrl: null,
			brand: null,
			category: null,
			url: null,
		},
	]);
});

test("S-Kaupat: store pages are read with their cursor, and a changed format fails loudly", async () => {
	const first = sKaupat.parseStorePage(await fixture("s-kaupat-stores-page1.json"));
	expect(first.cursor).toBe("c2Vjb25k");
	expect(first.stores[0]).toEqual({
		id: "613756972",
		name: "Prisma Linnainmaa",
		chain: "s-kaupat",
		location: "Tampere",
	});
	const last = sKaupat.parseStorePage(await fixture("s-kaupat-stores-page2.json"));
	expect([last.cursor, last.stores.map((s) => s.name)]).toEqual([null, ["Prisma Kaleva"]]);

	// an expired persisted query, or a renamed field, must be an error rather than an empty list
	const expired = await fixture("s-kaupat-persisted-query-not-found.json");
	expect(() => sKaupat.parseSearchResponse(expired, "maito", "1")).toThrow(ZodError);
	expect(() => sKaupat.parseStorePage({ data: { searchStores: { stores: [] } } })).toThrow(
		ZodError,
	);
});

test("S-Kaupat: the aisle comes back for the right store, and an answer for another store is not trusted", async () => {
	serve(await fixture("s-kaupat-product-location.json"));
	expect(await getProductLocation("6408430000098", "613756972")).toEqual({
		status: "found",
		location: { aisle: "45", floor: 1 },
	});
	expect(requested).toHaveLength(1);
	const query = new URL(requested[0] ?? "").searchParams.get("query") ?? "";
	expect(query).toContain('product(id: "6408430000098", storeId: "613756972"');

	// fallbackToGlobal can answer for a different store, whose shelf would be wrong here
	serve(await fixture("s-kaupat-product-location.json"));
	expect((await getProductLocation("6408430000098", "542862476")).status).toBe("unknown");

	serve({ data: { product: { ean: "1111", storeId: "613756972", location: null } } });
	expect(await getProductLocation("1111", "613756972")).toEqual({ status: "none", location: null });
});

test("S-Kaupat: declared allergens and ingredient text are flagged, including traces", async () => {
	serve(await fixture("s-kaupat-product-allergens.json"));
	const details = await getProductAllergens("6416046511226", "613756972");
	expect(details.status).toBe("ok");
	const check = matchAvoidTerms(details, [
		"vehnä",
		"maapähkin",
		"cashew",
		"saksanpähkin",
		"seesam",
	]);
	expect(check.status).toBe("flagged");
	const kinds = Object.fromEntries(check.flags.map((f) => [`${f.term}/${f.source}`, f.kind]));
	expect(kinds).toEqual({
		"vehnä/declared allergens": "contains",
		"vehnä/ingredients": "contains",
		"maapähkin/declared allergens": "may_contain",
		"cashew/ingredients": "may_contain",
		"saksanpähkin/ingredients": "may_contain",
	});
	// "free from" sesame is not a hit
	expect(check.flags.some((f) => f.term === "seesam")).toBe(false);

	// a failed lookup is "unknown", never a clean result
	serve({ error: "boom" }, 500);
	const failed = await getProductAllergens("6416046511227", "613756972");
	expect(matchAvoidTerms(failed, ["cashew"]).status).toBe("unknown");
});

test("S-Kaupat: nutrition uses the per-100 table and skips per-portion ones", async () => {
	serve(await fixture("s-kaupat-product-nutrition.json"));
	expect(await getProductNutrition("6408430000098", "613756972")).toEqual({
		status: "ok",
		per100: { kcal: 64, fatG: 3.5, carbsG: 4.8, proteinG: 3.3, basis: "ml" },
	});
	serve({
		data: { product: { ean: "2222", storeId: "613756972", productDetails: { nutrients: [] } } },
	});
	expect(await getProductNutrition("2222", "613756972")).toEqual({ status: "none", per100: null });
});

test("K-Ruoka: search results become products, with missing prices left empty", async () => {
	const result = kRuoka.parseSearchResponse(await fixture("k-ruoka-search.json"), "maito", "N110");
	expect(result).toMatchObject({ chain: "k-ruoka", storeId: "N110", totalCount: 2 });
	expect(result.products[0]).toEqual({
		name: "Valio täysmaito 1 l",
		price: 1.42,
		unitPrice: "1,42 €/l",
		id: "6408430000098",
		imageUrl: "https://public.keskofiles.com/f/k-ruoka/product/6408430000098",
		brand: "Valio",
		category: "Maidot",
	});
	expect(result.products[1]).toMatchObject({
		name: "Pirkka luomumaito 1 l",
		price: null,
		unitPrice: null,
	});

	const blocked = await fixture("k-ruoka-blocked.json");
	expect(() => kRuoka.parseSearchResponse(blocked, "maito", "N110")).toThrow(
		"Blocked by Cloudflare",
	);
	expect(() =>
		kRuoka.parseSearchResponse({ error: { message: "store closed" } }, "maito", "N110"),
	).toThrow("K-Ruoka API error: store closed");
});

test("K-Ruoka: only web stores are listed, filtered by city", async () => {
	const raw = await fixture("k-ruoka-stores.json");
	expect(kRuoka.parseStoresResponse(raw).map((s) => s.id)).toEqual(["N110", "N205", "N301"]);
	expect(kRuoka.parseStoresResponse(raw, "tampere").map((s) => s.name)).toEqual([
		"K-Citymarket Tampere Lielahti",
		"K-Supermarket Hervanta",
	]);
	const blocked = await fixture("k-ruoka-blocked.json");
	expect(() => kRuoka.parseStoresResponse(blocked)).toThrow("Blocked by Cloudflare");
});

test("Alko: products get a price per litre, strength and image; stores map to cities", async () => {
	const result = alko.parseSearchResponse(
		await fixture("alko-search.json"),
		"punaviini",
		undefined,
	);
	expect(result).toMatchObject({ chain: "alko", storeId: null, totalCount: 812 });
	expect(result.products[0]).toEqual({
		name: "Ruby Valley Merlot 2022",
		price: 9.98,
		unitPrice: "13,31 €/l",
		id: "001234",
		imageUrl: "https://images.alko.fi/images/cs_srgb,f_auto,t_products/cdn/001234/001234.jpg",
		brand: null,
		category: "punaviinit",
		abv: 13.5,
	});
	expect(result.products[1]?.unitPrice).toBe("9,97 €/l");
	expect(result.products[2]).toMatchObject({
		price: null,
		unitPrice: null,
		abv: null,
		category: null,
	});

	const stores = alko.parseStoresResponse(await fixture("alko-stores.json"));
	expect(stores.map((s) => [s.id, s.location])).toEqual([
		["2102", "Tampere"],
		["2128", "TAMPERE"],
		["2001", "Helsinki"],
	]);
	expect(() => alko.parseStoresResponse({ stores: [] })).toThrow(ZodError);
});
