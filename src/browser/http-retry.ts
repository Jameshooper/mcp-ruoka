import type { Page } from "playwright";
import * as z from "zod/v4";
import { logger } from "../logger.ts";

const RETRY_STATUSES = new Set([403, 429, 502, 503, 504]);

// Mutable so tests can run without real delays
export const tuning = {
	backoffMs: [1_000, 3_000],
	spacingMs: 120,
	concurrency: 4,
	breakerBaseMs: 45_000,
	breakerMaxMs: 300_000,
	browserPreferMs: 10 * 60_000,
};

let breakerUntil = 0;
let breakerStreak = 0;
let browserUntil = 0;
let nextSlot = 0;
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
	if (active < tuning.concurrency) {
		active++;
		return;
	}
	await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
	const next = waiters.shift();
	if (next) next();
	else active--;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Requests start at least spacingMs apart: bursts of parallel lookups are what the CDN punishes
async function waitForSlot(): Promise<void> {
	const slot = Math.max(Date.now(), nextSlot);
	nextSlot = slot + tuning.spacingMs;
	if (slot > Date.now()) await sleep(slot - Date.now());
}

const BrowserResultSchema = z.object({ status: z.number(), body: z.string() });

type BrowserFetch = (url: URL, headers: Headers) => Promise<{ status: number; body: string }>;

let apiPage: Page | null = null;

// Same request, but sent by the real Chromium the server already runs, from a page on the
// site's own origin: its network stack and cookies look like a visitor, unlike a plain fetch
const defaultBrowserFetch: BrowserFetch = async (url, headers) => {
	const { getContext } = await import("./session.ts");
	const origin = headers.get("origin") ?? "https://www.s-kaupat.fi";
	if (!apiPage || apiPage.isClosed()) {
		apiPage = await (await getContext()).newPage();
		await apiPage.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
	}
	const result = await apiPage.evaluate(
		async ({ href, accept }) => {
			const response = await fetch(href, { headers: { Accept: accept }, credentials: "include" });
			return { status: response.status, body: await response.text() };
		},
		{ href: url.href, accept: headers.get("accept") ?? "application/json" },
	);
	return BrowserResultSchema.parse(result);
};

let browserFetch: BrowserFetch = defaultBrowserFetch;

export function setBrowserFetchForTests(fn: BrowserFetch | null): void {
	browserFetch = fn ?? defaultBrowserFetch;
}

export function resetGuardForTests(): void {
	breakerUntil = 0;
	breakerStreak = 0;
	browserUntil = 0;
	nextSlot = 0;
}

async function viaBrowser(url: URL, headers: Headers): Promise<Response | null> {
	try {
		const result = await browserFetch(url, headers);
		if (result.status !== 200) return null;
		return new Response(result.body, {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		logger.warn({ err }, "Browser fallback request failed");
		return null;
	}
}

function pausedError(): Error {
	const seconds = Math.ceil((breakerUntil - Date.now()) / 1000);
	return new Error(
		`S-Kaupat API HTTP 403 (requests paused for ${seconds} s after repeated blocks; try again later)`,
	);
}

// The chain's CDN answers bursts from one IP with 403/429, sometimes for minutes. Retrying
// briefly covers short throttles; a block that outlasts that is retried through the real browser,
// and if that is refused too the server stops sending requests for a while instead of extending
// the block by hammering it.
export async function fetchWithRetry(url: URL, init: RequestInit): Promise<Response> {
	if (breakerUntil > Date.now()) throw pausedError();
	const headers = new Headers(init.headers);

	if (browserUntil > Date.now()) {
		const response = await viaBrowser(url, headers);
		if (response) {
			breakerStreak = 0;
			return response;
		}
		browserUntil = 0;
	}

	let last: Response;
	for (let attempt = 0; ; attempt++) {
		await acquire();
		try {
			await waitForSlot();
			last = await fetch(url, init);
		} finally {
			release();
		}
		if (last.ok) {
			breakerStreak = 0;
			return last;
		}
		const delay = tuning.backoffMs[attempt];
		if (delay === undefined || !RETRY_STATUSES.has(last.status)) break;
		logger.warn({ status: last.status, attempt: attempt + 1 }, "S-Kaupat API throttled, retrying");
		await sleep(delay + Math.random() * 500);
	}

	if (!RETRY_STATUSES.has(last.status)) return last;

	const response = await viaBrowser(url, headers);
	if (response) {
		logger.info("S-Kaupat API blocked plain requests; using the browser for the next while");
		browserUntil = Date.now() + tuning.browserPreferMs;
		breakerStreak = 0;
		return response;
	}

	breakerStreak++;
	const pause = Math.min(tuning.breakerBaseMs * 2 ** (breakerStreak - 1), tuning.breakerMaxMs);
	breakerUntil = Date.now() + pause;
	logger.warn({ status: last.status, pauseMs: pause }, "S-Kaupat API keeps refusing, pausing");
	return last;
}

// Shared by the product lookups: answers are reused for a while and identical concurrent
// lookups share one request. Results that are not worth keeping (failures) are retried next time.
export function memoizedLookup<T>(
	ttlMs: number,
	shouldCache: (value: T) => boolean,
): (key: string, produce: () => Promise<T>) => Promise<T> {
	const cache = new Map<string, { value: T; expiresAt: number }>();
	const inflight = new Map<string, Promise<T>>();

	return (key, produce) => {
		const cached = cache.get(key);
		if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

		const running = inflight.get(key);
		if (running) return running;

		const promise = produce()
			.then((value) => {
				if (shouldCache(value)) cache.set(key, { value, expiresAt: Date.now() + ttlMs });
				return value;
			})
			.finally(() => inflight.delete(key));
		inflight.set(key, promise);
		return promise;
	};
}
