import { logger } from "../logger.ts";

// The app sets Home Assistant sensors through the Supervisor's proxy to the Core API. States set
// this way are not kept over a Home Assistant restart, so publishers send them again from time to
// time.

export type PublishResult = { ok: true } | { ok: false; error: string };

export interface PublishOptions {
	fetchFn?: typeof fetch;
	token?: string;
}

export async function publishState(
	entityId: string,
	body: { state: string; attributes: Record<string, unknown> },
	options: PublishOptions = {},
): Promise<PublishResult> {
	const token = options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
	if (!token) return { ok: false, error: "Not running inside Home Assistant" };
	try {
		const response = await (options.fetchFn ?? fetch)(
			`http://supervisor/core/api/states/${entityId}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok) {
			logger.warn({ entityId, status: response.status }, "Home Assistant refused a state");
			return { ok: false, error: `Home Assistant answered HTTP ${response.status}` };
		}
		return { ok: true };
	} catch (err) {
		logger.warn({ entityId, err }, "Could not publish a state to Home Assistant");
		return { ok: false, error: "Could not reach Home Assistant" };
	}
}
