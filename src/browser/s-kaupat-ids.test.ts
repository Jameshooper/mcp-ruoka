import { afterEach, expect, test } from "bun:test";
import { getProductAllergens } from "./s-kaupat-allergens.ts";
import { isValidId } from "./s-kaupat-api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

// INP-05
test("only plain ASCII digits are ever put into the product query", async () => {
	for (const bad of ['1") { __schema', "1 2", "١٢٣", "１２３", "", "12a", "-1", "1e5"]) {
		expect(isValidId(bad)).toBe(false);
	}
	expect(isValidId("6408430000098")).toBe(true);

	let calls = 0;
	globalThis.fetch = Object.assign(
		async () => {
			calls++;
			return new Response("{}");
		},
		{ preconnect: () => {} },
	);
	const result = await getProductAllergens('1") { __schema { types { name } } } #', "613756972");
	expect(result.status).toBe("unknown");
	expect(calls).toBe(0);
});
