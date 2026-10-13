import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	fetchWithRetry,
	memoizedLookup,
	resetGuardForTests,
	setBrowserFetchForTests,
	tuning,
} from "./http-retry.ts";

const url = new URL("https://api.example.test/");
const original = { ...tuning };

beforeEach(() => {
	tuning.backoffMs = [1, 1];
	tuning.spacingMs = 0;
	tuning.breakerBaseMs = 60_000;
	resetGuardForTests();
});
afterEach(() => {
	Object.assign(tuning, original);
	setBrowserFetchForTests(null);
});

function stubFetch(statuses: number[]) {
	let calls = 0;
	globalThis.fetch = (async (_input: Request | URL | string) => {
		const status = statuses[Math.min(calls, statuses.length - 1)] ?? 200;
		calls++;
		return new Response("{}", { status });
	}) as typeof fetch;
	return () => calls;
}

test("a short throttle is retried and succeeds", async () => {
	const calls = stubFetch([403, 403, 200]);
	expect((await fetchWithRetry(url, {})).status).toBe(200);
	expect(calls()).toBe(3);
});

test("a lasting block falls back to the browser, which is then preferred", async () => {
	const calls = stubFetch([403]);
	let browserCalls = 0;
	setBrowserFetchForTests(async () => {
		browserCalls++;
		return { status: 200, body: '{"ok":true}' };
	});
	const first = await fetchWithRetry(url, { headers: { Origin: "https://www.example.test" } });
	expect(await first.json()).toEqual({ ok: true });
	expect(calls()).toBe(3);

	await fetchWithRetry(url, {});
	expect(browserCalls).toBe(2);
	expect(calls()).toBe(3);
});

test("when the browser is refused too, requests pause instead of hammering", async () => {
	const calls = stubFetch([403]);
	setBrowserFetchForTests(async () => ({ status: 403, body: "" }));
	expect((await fetchWithRetry(url, {})).status).toBe(403);
	const before = calls();
	await expect(fetchWithRetry(url, {})).rejects.toThrow("paused");
	expect(calls()).toBe(before);
});

test("other errors are not retried", async () => {
	const calls = stubFetch([404]);
	expect((await fetchWithRetry(url, {})).status).toBe(404);
	expect(calls()).toBe(1);
});

test("memoizedLookup shares in-flight work and keeps only worthwhile results", async () => {
	let runs = 0;
	const lookup = memoizedLookup<number>(60_000, (n) => n > 0);
	const produce = async () => ++runs;
	const [a, b] = await Promise.all([lookup("k", produce), lookup("k", produce)]);
	expect([a, b, runs]).toEqual([1, 1, 1]);
	expect(await lookup("k", produce)).toBe(1);

	let zeros = 0;
	const empty = async () => {
		zeros++;
		return 0;
	};
	await lookup("z", empty);
	await lookup("z", empty);
	expect(zeros).toBe(2);
});
