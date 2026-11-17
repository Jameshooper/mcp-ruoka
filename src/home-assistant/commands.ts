import * as z from "zod/v4";
import { outbox } from "../kindle/outbox.ts";
import { requestOpenDinner } from "../kindle/send.ts";
import { logger } from "../logger.ts";
import { type PublishOptions, publishState } from "./states.ts";

// Home Assistant reaches the app through its stdin (the hassio.addon_stdin action), so an
// automation can ask for things without another port or a token. The answer goes back as a sensor,
// which the device that asked (the dinner-menu display) shows.
//
// The answer's state is "<message>~<date>~<time>": the date says which evening it answers ("-" when
// the day was not understood), and the time makes every answer a new state, so the display hears a
// repeat of the same answer too. Firmware that only reads up to the first ~ still gets the message.
export const ANSWER_ENTITY = "sensor.ruoka_kindle";
// One command is a few dozen bytes; anything this long without a newline is not a command
const MAX_PENDING = 16 * 1024;

const CommandSchema = z.object({
	kindle: z.object({ day: z.string().trim().min(1).max(40) }),
});

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// Commands are JSON objects, one per line. The Supervisor writes the action's input as it is,
// so a command can also arrive without a newline after it.
export function takeCommands(buffer: string): { commands: unknown[]; rest: string } {
	const lines = buffer.split("\n");
	let rest = lines.pop() ?? "";
	const commands: unknown[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const value = tryParse(line);
		if (value === undefined) logger.warn("Ignored input from Home Assistant that is not JSON");
		else commands.push(value);
	}
	const whole = rest.trim() ? tryParse(rest) : undefined;
	if (whole !== undefined) {
		commands.push(whole);
		rest = "";
	}
	if (rest.length > MAX_PENDING) rest = "";
	return { commands, rest };
}

type CommandOptions = PublishOptions & { now?: number };

function publishAnswer(
	message: string,
	ok: boolean,
	date: string | null,
	now: number,
	options: PublishOptions,
) {
	return publishState(
		ANSWER_ENTITY,
		{
			state: `${message}~${date ?? "-"}~${now}`,
			attributes: {
				friendly_name: "Ruoka Kindle",
				icon: "mdi:book-open-variant",
				message,
				sent: ok,
				date,
				at: new Date(now).toISOString(),
			},
		},
		options,
	);
}

export async function runCommand(
	raw: unknown,
	options: CommandOptions = {},
): Promise<string | null> {
	const command = CommandSchema.safeParse(raw);
	if (!command.success) {
		logger.warn("Ignored an unknown command from Home Assistant");
		return null;
	}
	const now = options.now ?? Date.now();
	const result = await requestOpenDinner(command.data.kindle.day, now);
	if (!result.ok)
		logger.info(
			{ day: command.data.kindle.day, reason: result.message },
			"Nothing sent to the Kindle",
		);
	await publishAnswer(result.message, result.ok, result.date, now, options);
	return result.message;
}

// The display is still waiting when the Kindle opens what it sent (the Kindle asks every 5 seconds),
// so it can show that the recipe is really there rather than only queued
export function answerWhenOpened(options: PublishOptions = {}): () => void {
	return outbox.onOpened((request) => {
		if (request.origin.from !== "home-assistant") return;
		const now = request.openedAt ?? Date.now();
		void publishAnswer("Opened on the Kindle", true, request.origin.date, now, options);
	});
}

// Only inside the Home Assistant app, where stdin carries the Supervisor's input
export function startHomeAssistantCommands(input: NodeJS.ReadableStream = process.stdin): void {
	if (!process.env.SUPERVISOR_TOKEN) return;
	answerWhenOpened();
	let buffer = "";
	let queue: Promise<unknown> = Promise.resolve();
	input.setEncoding("utf8");
	input.on("data", (chunk: string) => {
		const { commands, rest } = takeCommands(buffer + chunk);
		buffer = rest;
		for (const command of commands) {
			queue = queue
				.then(() => runCommand(command))
				.catch((err) => {
					logger.warn({ err }, "Command from Home Assistant failed");
				});
		}
	});
	logger.info("Listening for commands from Home Assistant");
}
