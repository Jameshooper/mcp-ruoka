/**
 * Probes whether api.s-kaupat.fi accepts a hand-written product query that returns the
 * in-store location, without loading a page. Run it from a normal home connection:
 *
 *   bun scripts/probe-skaupat-graphql.ts <ean> <storeId>
 *   bun scripts/probe-skaupat-graphql.ts 6407840041172 613756972
 *
 * Prints what the API answers at each step (nothing secret is sent or printed).
 */
import { createHash } from "node:crypto";

const [ean, storeId] = process.argv.slice(2);
if (!ean || !storeId) {
	console.error("Usage: bun scripts/probe-skaupat-graphql.ts <ean> <storeId>");
	process.exit(1);
}

const API = "https://api.s-kaupat.fi/";
const headers = {
	Origin: "https://www.s-kaupat.fi",
	Referer: "https://www.s-kaupat.fi/",
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "application/json",
};

async function show(label: string, request: Promise<Response>): Promise<void> {
	console.log(`\n=== ${label}`);
	try {
		const res = await request;
		const body = await res.text();
		console.log(`HTTP ${res.status}`);
		console.log(body.slice(0, 1800));
	} catch (err) {
		console.log("request failed:", String(err));
	}
}

function post(query: string): Promise<Response> {
	return fetch(API, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
	});
}

await show("1. connectivity: { __typename }", post("{ __typename }"));

await show(
	"2. introspection: fields of Product",
	post('{ __type(name: "Product") { fields { name } } }'),
);

await show(
	"3. introspection: arguments of the product query",
	post(
		"{ __schema { queryType { fields { name args { name type { name kind ofType { name } } } } } } }",
	),
);

const adHoc = `{ product(id: "${ean}", storeId: "${storeId}", fallbackToGlobal: true, includeAgeLimitedByAlcohol: true) { ean storeId location { aisle floor } } }`;

await show("4. ad-hoc query via POST", post(adHoc));

await show(
	"5. ad-hoc query via GET",
	fetch(`${API}?query=${encodeURIComponent(adHoc)}`, { headers }),
);

const hash = createHash("sha256").update(adHoc).digest("hex");
await show(
	"6. automatic persisted query (register by hash)",
	fetch(
		`${API}?query=${encodeURIComponent(adHoc)}&extensions=${encodeURIComponent(
			JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
		)}`,
		{ headers },
	),
);
