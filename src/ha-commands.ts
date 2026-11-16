import * as z from "zod/v4";
import { requestOpenDinner } from "./kindle.ts";
import { logger } from "./logger.ts";

// Home Assistant reaches the app through its stdin (the hassio.addon_stdin action), so an
// automation can ask for things without another port or a token. The answer goes back as a sensor,
// which the device that asked (the dinner-menu display) shows.
const ENTITY_ID = "sensor.ruoka_kindle";
const STATES_URL = `http://supervisor/core/api/states/${ENTITY_ID}`;
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

export async function runCommand(
	raw: unknown,
	options: { now?: number; fetchFn?: typeof fetch; token?: string } = {},
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
	await publishResult(result.message, result.ok, now, options);
	return result.message;
}

async function publishResult(
	message: string,
	ok: boolean,
	now: number,
	options: { fetchFn?: typeof fetch; token?: string },
): Promise<void> {
	const token = options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
	if (!token) return;
	try {
		const response = await (options.fetchFn ?? fetch)(STATES_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				// The time after the ~ makes every answer a new state, so the display hears a repeat of
				// the same answer too
				state: `${message}~${now}`,
				attributes: {
					friendly_name: "Ruoka Kindle",
					icon: "mdi:book-open-variant",
					message,
					sent: ok,
					at: new Date(now).toISOString(),
				},
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			logger.warn({ status: response.status }, "Home Assistant refused the Kindle answer");
	} catch (err) {
		logger.warn({ err }, "Could not publish the Kindle answer");
	}
}

// Only inside the Home Assistant app, where stdin carries the Supervisor's input
export function startHomeAssistantCommands(input: NodeJS.ReadableStream = process.stdin): void {
	if (!process.env.SUPERVISOR_TOKEN) return;
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
