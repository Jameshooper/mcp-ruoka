/**
 * Usage: bun scripts/live-check.ts
 * Calls K-Ruoka, S-Kaupat and Alko once each, the way the tools do, and reports whether their
 * answers still read correctly. Run weekly by .github/workflows/live-check.yml (never on every
 * push, to keep the load on the retailers negligible). Exits 1 only when a response format
 * changed; refusals and timeouts from the CI runner are reported as inconclusive.
 *
 * The raw JSON responses seen through fetch are written to LIVE_CHECK_OUT (default
 * ./live-check-output) so the test fixtures can be refreshed from real data.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as alko from "../src/browser/alko.ts";
import * as kRuoka from "../src/browser/k-ruoka.ts";
import * as sKaupat from "../src/browser/s-kaupat.ts";
import { getProductAllergens } from "../src/browser/s-kaupat-allergens.ts";
import { getProductLocation } from "../src/browser/s-kaupat-location.ts";
import { getProductNutrition } from "../src/browser/s-kaupat-nutrition.ts";
import { type CheckResult, expectThat, requires, runCheck, summarize } from "../src/live-check.ts";

const OUT = process.env.LIVE_CHECK_OUT ?? "live-check-output";
// Prisma Linnainmaa, Tampere: a large store that has always had an online selection
const S_KAUPAT_STORE = "613756972";
const RETAILER_HOST = /(^|\.)(s-kaupat\.fi|k-ruoka\.fi|alko\.fi)$/;

await mkdir(OUT, { recursive: true });

// Keep a copy of every retailer JSON answer (bodies only: request cookies are never written)
let saved = 0;
const statuses: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (input: Request | URL | string, init?: RequestInit) => {
		const response = await realFetch(input, init);
		const url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
		);
		if (RETAILER_HOST.test(url.hostname)) {
			statuses.push(`${url.hostname} ${response.status}`);
			if (response.headers.get("content-type")?.includes("json")) {
				const op = url.searchParams.get("operationName") ?? url.pathname.replace(/\W+/g, "-");
				const name = `${String(++saved).padStart(2, "0")}-${url.hostname}-${op}`.slice(0, 120);
				await writeFile(join(OUT, `${name}.json`), await response.clone().text());
			}
		}
		return response;
	},
	{ preconnect: realFetch.preconnect },
);

const results: CheckResult[] = [];

// S-Kaupat: stores, search, then the three product-detail lookups for the first product found
results.push(
	await runCheck("S-Kaupat", "stores in Tampere", async () => {
		const stores = await sKaupat.getStores("Tampere");
		expectThat(stores.length > 0, "No stores returned for Tampere");
		expectThat(
			stores.every((s) => s.id && s.name),
			"Stores without id or name",
		);
		return `${stores.length} stores`;
	}),
);
let ean: string | undefined;
results.push(
	await runCheck("S-Kaupat", "search 'maito'", async () => {
		const result = await sKaupat.searchProducts("maito", S_KAUPAT_STORE, 5);
		expectThat(result.products.length > 0, "Search for a staple returned nothing");
		expectThat(
			result.products.some((p) => typeof p.price === "number" && p.price > 0),
			"No product has a price",
		);
		ean = result.products.find((p) => /^\d+$/.test(p.id))?.id;
		return `${result.products.length} products, e.g. ${result.products[0]?.name} ${result.products[0]?.price} €`;
	}),
);
for (const [check, lookup] of [
	["aisle", async (id: string) => (await getProductLocation(id, S_KAUPAT_STORE)).status],
	["allergens", async (id: string) => (await getProductAllergens(id, S_KAUPAT_STORE)).status],
	["nutrition", async (id: string) => (await getProductNutrition(id, S_KAUPAT_STORE)).status],
] as const) {
	results.push(
		await runCheck("S-Kaupat", `product ${check}`, async () => {
			const id = requires(ean, "Skipped: the search found no product to look up");
			const before = statuses.length;
			const status = await lookup(id);
			// The lookups turn every failure into "unknown"; the HTTP status tells refusal from format
			const refused = statuses.slice(before).find((s) => /\s(401|403|429|503)$/.test(s));
			if (status === "unknown" && refused) throw new Error(`Refused: ${refused}`);
			expectThat(status !== "unknown", `Lookup answered but could not be read (status ${status})`);
			return `status ${status} for ${id}`;
		}),
	);
}

// K-Ruoka: stores, then a search at the first Tampere web store (needs the browser session)
let kStore: string | undefined;
results.push(
	await runCheck("K-Ruoka", "stores in Tampere", async () => {
		const stores = await kRuoka.getStores("Tampere");
		expectThat(stores.length > 0, "No web stores returned for Tampere");
		kStore = stores[0]?.id;
		return `${stores.length} web stores`;
	}),
);
results.push(
	await runCheck("K-Ruoka", "search 'maito'", async () => {
		const store = requires(kStore, "Skipped: the store list gave no store to search");
		const result = await kRuoka.searchProducts("maito", store, 5);
		expectThat(result.products.length > 0, "Search for a staple returned nothing");
		return `${result.products.length} products, e.g. ${result.products[0]?.name} ${result.products[0]?.price} €`;
	}),
);

// Alko: national catalogue search and the store list
results.push(
	await runCheck("Alko", "search 'punaviini'", async () => {
		const result = await alko.searchProducts("punaviini", undefined, 5);
		expectThat(result.products.length > 0, "Search returned nothing");
		expectThat(
			result.products.some((p) => typeof p.price === "number"),
			"No product has a price",
		);
		return `${result.products.length} products of ${result.totalCount}`;
	}),
);
results.push(
	await runCheck("Alko", "stores in Tampere", async () => {
		const stores = await alko.getStores("Tampere");
		expectThat(stores.length > 0, "No stores returned for Tampere");
		return `${stores.length} stores`;
	}),
);

const { markdown, exitCode } = summarize(results);
console.log(markdown);
console.log(`\nSaved ${saved} raw responses to ${OUT}`);
if (process.env.GITHUB_STEP_SUMMARY)
	await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
for (const r of results.filter((r) => r.status === "blocked")) {
	console.log(`::warning title=${r.chain} unverified::${r.check}: ${r.detail}`);
}
for (const r of results.filter((r) => r.status === "broken")) {
	console.log(`::error title=${r.chain} broken::${r.check}: ${r.detail}`);
}
// The headless browser keeps the process alive otherwise
process.exit(exitCode);
