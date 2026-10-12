import { API_TIMEOUT, API_URL, ORIGIN } from "./s-kaupat.ts";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_CONCURRENT = 6;
// Inserted into the query text, so only plain digits are allowed
const ID_RE = /^\d+$/;

export function isValidId(id: string): boolean {
	return ID_RE.test(id);
}

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
	if (active < MAX_CONCURRENT) {
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

// The site's own pages read product fields from this GraphQL endpoint, which accepts plain GET
// queries from browser-like clients (a POST is rejected by its CDN). Naming the fields here
// avoids the persisted-query hashes used for search.
export async function fetchProductFields(
	selection: string,
	ean: string,
	storeId: string,
): Promise<unknown> {
	if (!isValidId(ean) || !isValidId(storeId)) throw new Error("Invalid product or store ID");

	const query = `{ product(id: "${ean}", storeId: "${storeId}", fallbackToGlobal: true, includeAgeLimitedByAlcohol: true) { ean storeId ${selection} } }`;
	const url = new URL(API_URL);
	url.searchParams.set("query", query);

	await acquire();
	try {
		const response = await fetch(url, {
			headers: {
				Origin: ORIGIN,
				Referer: `${ORIGIN}/`,
				"User-Agent": UA,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(API_TIMEOUT),
		});
		if (!response.ok) throw new Error(`S-Kaupat API HTTP ${response.status}`);
		return await response.json();
	} finally {
		release();
	}
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
