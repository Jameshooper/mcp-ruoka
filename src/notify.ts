import { logger } from "./logger.ts";

const SUPERVISOR_URL = "http://supervisor/core/api/services";
const SERVICE_RE = /^notify\.[a-z0-9_]+$/;

// Repeats of the same alert are dropped: a scanner hitting the public endpoint all day should
// cost one buzz, not hundreds
const COOLDOWN_MS = {
	"sign-in-limit": 30 * 60_000,
	"ip-refused": 6 * 60 * 60_000,
	test: 0,
} as const;

export type AlertKind = keyof typeof COOLDOWN_MS;

const lastSent = new Map<AlertKind, number>();

export function resetNotifyCooldowns(): void {
	lastSent.clear();
}

export type NotifyResult = { ok: true } | { ok: false; error: string };

export async function sendNotification(
	kind: AlertKind,
	title: string,
	message: string,
	options: {
		now?: number;
		fetchFn?: typeof fetch;
		service?: string;
		token?: string;
	} = {},
): Promise<NotifyResult> {
	const service = options.service ?? process.env.RUOKA_NOTIFY_SERVICE ?? "";
	const token = options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
	if (!service) return { ok: false, error: "Set notify_service in the app configuration first" };
	if (!SERVICE_RE.test(service)) {
		return { ok: false, error: `notify_service must look like notify.mobile_app_your_phone` };
	}
	if (!token) return { ok: false, error: "Not running inside Home Assistant" };

	const now = options.now ?? Date.now();
	const last = lastSent.get(kind);
	if (last !== undefined && now - last < COOLDOWN_MS[kind]) return { ok: true };
	lastSent.set(kind, now);

	try {
		const response = await (options.fetchFn ?? fetch)(
			`${SUPERVISOR_URL}/notify/${service.slice("notify.".length)}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ title, message }),
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok) {
			const error = `Home Assistant answered HTTP ${response.status}`;
			logger.warn({ kind, status: response.status }, "Notification was not delivered");
			return { ok: false, error };
		}
		return { ok: true };
	} catch (err) {
		logger.warn({ err, kind }, "Notification failed");
		return { ok: false, error: "Could not reach Home Assistant" };
	}
}

// Fire and forget: an alert must never slow down or break the request that raised it
export function alert(kind: AlertKind, title: string, message: string): void {
	void sendNotification(kind, title, message);
}
