import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
	answerWhenOpened,
	runCommand,
	startHomeAssistantCommands,
	takeCommands,
} from "./commands.ts";

test("reads one command per line, and a last one without a newline", () => {
	expect(takeCommands('{"a":1}\n{"b":2}\n{"c"')).toEqual({
		commands: [{ a: 1 }, { b: 2 }],
		rest: '{"c"',
	});
	expect(takeCommands('{"kindle":{"day":"Mon 16 Nov"}}')).toEqual({
		commands: [{ kindle: { day: "Mon 16 Nov" } }],
		rest: "",
	});
	expect(takeCommands("not json\n").commands).toEqual([]);
	expect(takeCommands(`{"x":"${"a".repeat(20_000)}`).rest).toBe("");
});

test("answers through a sensor, with the time keeping every answer a new state", async () => {
	const calls: Array<{ url: string; body: string }> = [];
	const fetchFn = Object.assign(
		async (input: Request | URL | string, init?: RequestInit) => {
			calls.push({ url: String(input), body: String(init?.body) });
			return new Response("{}", { status: 201 });
		},
		{ preconnect: () => {} },
	);
	const now = new Date(2026, 10, 16, 17, 0).getTime();
	const message = await runCommand({ kindle: { day: "someday" } }, { now, fetchFn, token: "tok" });
	expect(message).toBe("Unknown day");
	expect(calls[0]?.url).toBe("http://supervisor/core/api/states/sensor.ruoka_kindle");
	const body = JSON.parse(calls[0]?.body ?? "{}");
	// "<message>~<date>~<time>": old firmware reads up to the first ~, so it still gets the message
	expect(body.state).toBe(`Unknown day~-~${now}`);
	expect(body.attributes.date).toBeNull();
	expect(body.attributes.sent).toBe(false);

	expect(await runCommand({ reboot: true }, { now, fetchFn, token: "tok" })).toBeNull();
	expect(calls).toHaveLength(1);
});

test("does not listen outside Home Assistant", () => {
	const saved = process.env.SUPERVISOR_TOKEN;
	delete process.env.SUPERVISOR_TOKEN;
	const input = new PassThrough();
	startHomeAssistantCommands(input);
	expect(input.listenerCount("data")).toBe(0);
	if (saved !== undefined) process.env.SUPERVISOR_TOKEN = saved;
});

test("tells the display when the Kindle has opened what it sent, and only for its own sends", async () => {
	const { outbox } = await import("../kindle/outbox.ts");
	outbox.reset();
	const states: string[] = [];
	const fetchFn = Object.assign(
		async (_input: Request | URL | string, init?: RequestInit) => {
			states.push(JSON.parse(String(init?.body)).state);
			return new Response("{}", { status: 201 });
		},
		{ preconnect: () => {} },
	);
	const stop = answerWhenOpened({ fetchFn, token: "tok" });
	const book = new Uint8Array([1]);
	const item = { key: "salmon-soup", name: "Salmon soup", servings: 4, book };

	const fromApp = outbox.send(item, { from: "app" }, 1000);
	outbox.markOpened(fromApp.id, 2000);
	expect(states).toEqual([]);

	const fromDisplay = outbox.send(item, { from: "home-assistant", date: "2026-11-17" }, 3000);
	outbox.markOpened(fromDisplay.id, 4000);
	// A retried "opened" from the Kindle is not a second answer
	outbox.markOpened(fromDisplay.id, 5000);
	await Bun.sleep(0);
	expect(states).toEqual(["Opened on the Kindle~2026-11-17~4000"]);
	stop();
	outbox.reset();
});
