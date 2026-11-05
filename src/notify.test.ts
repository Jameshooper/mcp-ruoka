import { beforeEach, expect, test } from "bun:test";
import { resetNotifyCooldowns, sendNotification } from "./notify.ts";

beforeEach(() => resetNotifyCooldowns());

function recorder(status = 200) {
	const calls: Array<{ url: string; auth: string | null; body: string }> = [];
	const fetchFn = async (input: Request | URL | string, init?: RequestInit) => {
		calls.push({
			url: String(input),
			auth: new Headers(init?.headers).get("authorization"),
			body: String(init?.body),
		});
		return new Response("{}", { status });
	};
	return { calls, fetchFn: Object.assign(fetchFn, { preconnect: () => {} }) };
}

const base = { service: "notify.mobile_app_phone", token: "tok" };

test("posts to the Supervisor with the service name and token", async () => {
	const { calls, fetchFn } = recorder();
	const result = await sendNotification("test", "Hi", "There", { ...base, fetchFn });
	expect(result).toEqual({ ok: true });
	expect(calls[0]?.url).toBe("http://supervisor/core/api/services/notify/mobile_app_phone");
	expect(calls[0]?.auth).toBe("Bearer tok");
	expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ title: "Hi", message: "There" });
});

test("explains what is missing instead of failing silently", async () => {
	expect((await sendNotification("test", "a", "b", { service: "", token: "t" })).ok).toBe(false);
	expect(
		(await sendNotification("test", "a", "b", { service: "light.kitchen", token: "t" })).ok,
	).toBe(false);
	expect((await sendNotification("test", "a", "b", { service: base.service, token: "" })).ok).toBe(
		false,
	);
});

test("repeats of the same alert inside the cooldown are dropped", async () => {
	const { calls, fetchFn } = recorder();
	const send = (now: number) => sendNotification("ip-refused", "a", "b", { ...base, fetchFn, now });
	await send(0);
	await send(60_000);
	expect(calls.length).toBe(1);
	await send(7 * 60 * 60_000);
	expect(calls.length).toBe(2);
});

test("reports a rejected delivery", async () => {
	const { fetchFn } = recorder(401);
	const result = await sendNotification("test", "a", "b", { ...base, fetchFn });
	expect(result).toEqual({ ok: false, error: "Home Assistant answered HTTP 401" });
});

// DEV-02, DEV-03
test("only the configured notify service is called, with a title and message only", async () => {
	const { calls, fetchFn } = recorder();
	await sendNotification("test", "t", "m", { ...base, fetchFn });
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toMatch(/^http:\/\/supervisor\/core\/api\/services\/notify\/[a-z0-9_]+$/);
	expect(Object.keys(JSON.parse(calls[0]?.body ?? "{}")).sort()).toEqual(["message", "title"]);
	for (const service of [
		"lock.unlock",
		"notify.x/../../services/lock/unlock",
		"notify.MOBILE",
		"notify.a b",
		"homeassistant.restart",
	]) {
		await sendNotification("test", "t", "m", { service, token: "tok", fetchFn });
	}
	expect(calls).toHaveLength(1);
});

test("alerts held back by the cooldown are counted in the next one", async () => {
	const { calls, fetchFn } = recorder();
	const send = (now: number) =>
		sendNotification("ip-refused", "a", "Refused.", { ...base, fetchFn, now });
	await send(0);
	for (let i = 1; i <= 4; i++) await send(i * 60_000);
	await send(7 * 60 * 60_000);
	expect(calls).toHaveLength(2);
	expect(JSON.parse(calls[1]?.body ?? "{}").message).toBe(
		"Refused. (4 more since the last alert.)",
	);
});
