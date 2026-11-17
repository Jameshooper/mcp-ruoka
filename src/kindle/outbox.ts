import { logger } from "../logger.ts";

// What is waiting for the Kindle. The KOReader plugin asks for it every few seconds while KOReader
// is open; nothing connects into the Kindle, so a sleeping Kindle simply picks the request up when
// it wakes (within REQUEST_TTL_MS). There is one slot: sending something new replaces what the
// Kindle has not fetched yet, which is what someone pressing Cook on another day means.

const REQUEST_TTL_MS = 10 * 60_000;
// The Kindle counts as reachable when it asked this recently
const SEEN_RECENTLY_MS = 2 * 60_000;
// The plugin names itself in its User-Agent ("Ruoka-KOReader/2"), which shows in the app's status
// whether a new plugin release has been copied to the Kindle. The first release sent none.
const PLUGIN_RE = /\bRuoka-KOReader\/(\d{1,4})\b/;

// A book ready to send. Everything is built when it is sent, so what the Kindle gets is what was
// on screen when Cook or "Open on Kindle" was pressed.
export interface Sendable {
	// Names the downloaded file on the Kindle ("salmon-soup", "web-...", "plan-...")
	key: string;
	name: string;
	// 0 when the source has no serving count (Instagram captions)
	servings: number;
	book: Uint8Array;
}

// Who asked: Home Assistant (the dinner-menu display) hears back when the Kindle opens the book
export type SendOrigin = { from: "app" } | { from: "home-assistant"; date: string };

export interface KindleRequest extends Sendable {
	id: string;
	origin: SendOrigin;
	requestedAt: number;
	openedAt: number | null;
}

type OpenedListener = (request: KindleRequest) => void;

export class KindleOutbox {
	private pending: KindleRequest | null = null;
	private lastSeen: number | null = null;
	private plugin: string | null = null;
	// The release last written to the log, so a new plugin shows up there once instead of on every
	// poll; undefined until the Kindle first asks after a restart
	private loggedRelease: string | undefined;
	private readonly listeners = new Set<OpenedListener>();

	send(item: Sendable, origin: SendOrigin = { from: "app" }, now = Date.now()): KindleRequest {
		this.pending = {
			...item,
			id: crypto.randomUUID(),
			origin,
			requestedAt: now,
			openedAt: null,
		};
		logger.info(
			{ key: item.key, servings: item.servings, from: origin.from },
			"Sent to the Kindle",
		);
		return this.pending;
	}

	// The request still waiting or just opened; one nobody picked up in time is dropped
	current(now = Date.now()): KindleRequest | null {
		if (this.pending && !this.pending.openedAt && now - this.pending.requestedAt > REQUEST_TTL_MS) {
			this.pending = null;
		}
		return this.pending;
	}

	seen(now = Date.now(), userAgent: string | null = null): void {
		this.lastSeen = now;
		const version = userAgent ? PLUGIN_RE.exec(userAgent)?.[1] : undefined;
		if (version) this.plugin = version;
		// The app's status page is only reachable through Home Assistant, so the log is the easy
		// place to check that a plugin copied to the Kindle by hand is the one running
		const release = version ?? "1";
		if (release === this.loggedRelease) return;
		this.loggedRelease = release;
		if (version) logger.info({ pluginVersion: version }, `Kindle plugin release ${version}`);
		else
			logger.info(
				{ pluginVersion: null },
				"Kindle plugin release 1 (sends no version); copy kindle/ruoka.koplugin to update it",
			);
	}

	// Only the request that was handed out can be marked, and only once
	markOpened(id: string, now = Date.now()): boolean {
		const request = this.current(now);
		if (!request || request.id !== id) return false;
		this.lastSeen = now;
		if (request.openedAt) return true;
		request.openedAt = now;
		logger.info({ key: request.key }, "Opened on the Kindle");
		for (const listener of this.listeners) {
			try {
				listener(request);
			} catch (err) {
				logger.warn({ err }, "A Kindle listener failed");
			}
		}
		return true;
	}

	onOpened(listener: OpenedListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	seenRecently(now = Date.now()): boolean {
		return this.lastSeen !== null && now - this.lastSeen < SEEN_RECENTLY_MS;
	}

	status(now = Date.now()) {
		const request = this.current(now);
		return {
			request: request
				? {
						id: request.id,
						recipe: request.key,
						name: request.name,
						servings: request.servings,
						status: request.openedAt ? "opened" : "waiting",
					}
				: null,
			lastSeenSecondsAgo: this.lastSeen === null ? null : Math.round((now - this.lastSeen) / 1000),
			seenRecently: this.seenRecently(now),
			pluginVersion: this.plugin,
		};
	}

	reset(): void {
		this.pending = null;
		this.lastSeen = null;
		this.plugin = null;
		this.loggedRelease = undefined;
		this.listeners.clear();
	}
}

// The app has one Kindle; the instance is shared by the app's screens, Home Assistant commands and
// the Kindle's own listener
export const outbox = new KindleOutbox();
