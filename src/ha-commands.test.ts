import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runCommand, startHomeAssistantCommands, takeCommands } from "./ha-commands.ts";

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
	expect(body.state).toBe(`Unknown day~${now}`);
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
