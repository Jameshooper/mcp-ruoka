import { expect, test } from "bun:test";
import * as z from "zod/v4";
import { classify, expectThat, runCheck, summarize } from "./live-check.ts";

test("refusals and timeouts are inconclusive; format changes and empty answers are broken", () => {
	for (const message of [
		"S-Kaupat API HTTP 403",
		"Blocked by Cloudflare after session reset",
		"Cloudflare challenge timed out — may require interactive verification",
		"The operation timed out.",
		"fetch failed",
		"Alko API rejected request after session refresh: HTTP 401",
		"page.goto: net::ERR_CONNECTION_RESET",
	]) {
		expect(classify(new Error(message)).status).toBe("blocked");
	}
	const changed = z.object({ data: z.object({ store: z.string() }) }).safeParse({ data: {} });
	if (changed.success) throw new Error("expected a parse failure");
	expect(classify(changed.error)).toEqual({
		status: "broken",
		detail:
			"Response format changed at data.store: Invalid input: expected string, received undefined",
	});
	expect(() => expectThat(false, "Search for a staple returned nothing")).toThrow();
	expect(
		classify(new TypeError("Cannot read properties of undefined (reading 'map')")).status,
	).toBe("broken");
});

test("only broken checks fail the run, and the summary says which", async () => {
	const ok = await runCheck("Alko", "search", async () => "5 products");
	const blocked = await runCheck("K-Ruoka", "search", async () => {
		throw new Error("Blocked by Cloudflare after session reset");
	});
	const broken = await runCheck("S-Kaupat", "search", async () => {
		expectThat(false, "Search for a staple returned nothing");
		return "";
	});
	expect([ok.status, blocked.status, broken.status]).toEqual(["ok", "blocked", "broken"]);

	expect(summarize([ok, blocked]).exitCode).toBe(0);
	expect(summarize([ok, blocked]).markdown).toContain("1 check(s) were blocked or unreachable");
	const failing = summarize([ok, blocked, broken]);
	expect(failing.exitCode).toBe(1);
	expect(failing.markdown).toContain("**1 check(s) broken**");
	expect(failing.markdown).toContain(
		"| ❌ | S-Kaupat | search | Search for a staple returned nothing |",
	);
	expect(summarize([ok]).markdown).toContain("All retailer responses read as expected.");
});

test("a check that depends on a failed one is skipped, not counted again", async () => {
	const { requires } = await import("./live-check.ts");
	const skipped = await runCheck("K-Ruoka", "search", async () =>
		requires<string>(undefined, "Skipped: no store"),
	);
	expect(skipped).toMatchObject({ status: "skipped", detail: "Skipped: no store" });
	expect(summarize([skipped]).exitCode).toBe(0);
	expect(
		classify(new Error("persistentContext: Executable doesn't exist\n╔════ banner ════╗")).detail,
	).toBe("persistentContext: Executable doesn't exist");
});
