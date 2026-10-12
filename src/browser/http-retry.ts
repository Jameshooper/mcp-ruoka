import { logger } from "../logger.ts";

const RETRY_STATUSES = new Set([403, 429, 502, 503, 504]);
const BACKOFF_MS = [1_000, 3_000];

// The chain's CDN answers bursts from one IP with a transient 403/429 that clears within seconds,
// so a short backoff recovers most calls instead of failing a whole recipe lookup.
export async function fetchWithRetry(url: URL, init: RequestInit): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(url, init);
		const delay = BACKOFF_MS[attempt];
		if (response.ok || delay === undefined || !RETRY_STATUSES.has(response.status)) {
			return response;
		}
		logger.warn(
			{ status: response.status, attempt: attempt + 1 },
			"S-Kaupat API throttled, retrying",
		);
		await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 500));
	}
}
