import * as z from "zod/v4";
import { logger } from "../logger.ts";
import { SOUS_VIDE_PROTEINS, type SousVideSettings } from "../sous-vide.ts";
import type { PublishOptions, PublishResult } from "./states.ts";

// Home Assistant owns the cook: script.sous_vide_cook sets the INKBIRD and waits for the water,
// and the Pasteurisation monitor automation decides when the food is safe from the MEATER probe.
// The app only starts and stops that script and reads the result back.
export const COOK_SCRIPT = "script.sous_vide_cook";
export const STOP_SCRIPT = "script.sous_vide_stop";
// Manual mode skips the cook script and the pasteurisation tracking: the cook just sets the water
// and, optionally, how long it runs. Home Assistant switches the cooker off when the timer ends,
// so the app does not need to stay open.
export const MANUAL_TIMER = "timer.sous_vide_manual_timer";
// Without the MEATER the cook script times the cook from Baldwin's table with this timer
export const TABLE_TIMER = "timer.sous_vide_table_timer";
const BATH_NUMBER = "number.sous_vide_set_temperature";
const COOKER_SWITCH = "switch.isv_100w2_0_sous_vide_running";

const STATUS_ENTITIES = {
	state: "input_select.pasteurisation_state",
	protein: "input_select.sous_vide_protein",
	coreTarget: "input_number.pasteurisation_target_temperature",
	thickness: "input_number.sous_vide_thickness",
	bathSetpoint: "number.sous_vide_set_temperature",
	water: "sensor.isv_100w2_0_sous_vide_water_temperature",
	cookerOn: "switch.isv_100w2_0_sous_vide_running",
	core: "sensor.meater_internal",
	killProgress: "sensor.pasteurisation_kill_progress",
	fsaiRemaining: "sensor.pasteurisation_hold_remaining",
	plannedMinutes: "sensor.sous_vide_planned_bath_time",
	plannedFinish: "input_datetime.sous_vide_planned_finish",
	heating: COOK_SCRIPT,
} as const;

const StateSchema = z.object({
	state: z.string(),
	attributes: z.record(z.string(), z.unknown()).optional(),
});

function token(options: PublishOptions): string {
	return options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
}

const TIMED_OUT = "Home Assistant did not answer in time";

async function callService(
	domain: string,
	service: string,
	data: Record<string, unknown>,
	options: PublishOptions,
	timeoutMs = 10_000,
): Promise<PublishResult> {
	const auth = token(options);
	if (!auth) return { ok: false, error: "Not running inside Home Assistant" };
	try {
		const response = await (options.fetchFn ?? fetch)(
			`http://supervisor/core/api/services/${domain}/${service}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
				body: JSON.stringify(data),
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		if (!response.ok) {
			logger.warn({ domain, service, status: response.status }, "Home Assistant refused a call");
			return { ok: false, error: `Home Assistant answered HTTP ${response.status}` };
		}
		return { ok: true };
	} catch (err) {
		logger.warn({ domain, service, err }, "Could not call Home Assistant");
		return err instanceof Error && err.name === "TimeoutError"
			? { ok: false, error: TIMED_OUT }
			: { ok: false, error: "Could not reach Home Assistant" };
	}
}

async function readEntity(
	entityId: string,
	options: PublishOptions,
): Promise<z.infer<typeof StateSchema> | null> {
	try {
		const response = await (options.fetchFn ?? fetch)(
			`http://supervisor/core/api/states/${entityId}`,
			{
				headers: { Authorization: `Bearer ${token(options)}` },
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok) return null;
		const parsed = StateSchema.safeParse(await response.json());
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function readState(entityId: string, options: PublishOptions): Promise<string | null> {
	const state = (await readEntity(entityId, options))?.state ?? null;
	return state === "unavailable" || state === "unknown" ? null : state;
}

// script.turn_on returns at once; calling the script itself would hold the request open for the
// whole time the water heats
// Home Assistant can take well over ten seconds to answer script.turn_on (seen on a real cook),
// while the script has in fact started. So the call waits longer, and if it still times out the
// script's last_triggered decides whether the cook began.
export async function startCook(
	settings: SousVideSettings,
	meater = true,
	options: PublishOptions = {},
): Promise<PublishResult> {
	const asked = Date.now();
	const result = await callService(
		"script",
		"turn_on",
		{
			entity_id: COOK_SCRIPT,
			variables: {
				protein: SOUS_VIDE_PROTEINS[settings.protein],
				thickness: settings.thicknessMm,
				core_temperature: settings.coreTempC,
				bath_offset: settings.bathOffsetC,
				meater,
			},
		},
		options,
		30_000,
	);
	if (result.ok || result.error !== TIMED_OUT) return result;
	const script = await readEntity(COOK_SCRIPT, options);
	const triggered = script?.attributes?.last_triggered;
	const started = typeof triggered === "string" && Date.parse(triggered) >= asked - 5_000;
	return started ? { ok: true } : result;
}

export function stopCook(options: PublishOptions = {}): Promise<PublishResult> {
	return callService("script", "turn_on", { entity_id: STOP_SCRIPT }, options);
}

function duration(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

export async function startManual(
	bathC: number,
	minutes: number | undefined,
	options: PublishOptions = {},
): Promise<PublishResult> {
	const set = await callService(
		"number",
		"set_value",
		{ entity_id: BATH_NUMBER, value: bathC },
		options,
	);
	if (!set.ok) return set;
	const on = await callService("switch", "turn_on", { entity_id: COOKER_SWITCH }, options);
	if (!on.ok) return on;
	return minutes
		? callService(
				"timer",
				"start",
				{ entity_id: MANUAL_TIMER, duration: duration(minutes) },
				options,
			)
		: callService("timer", "cancel", { entity_id: MANUAL_TIMER }, options);
}

export async function stopManual(options: PublishOptions = {}): Promise<PublishResult> {
	await callService("timer", "cancel", { entity_id: MANUAL_TIMER }, options);
	return callService("switch", "turn_off", { entity_id: COOKER_SWITCH }, options);
}

function capPercent(value: number | null): number | null {
	return value === null ? null : Math.min(100, value);
}

function num(value: string | null): number | null {
	if (value === null) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

export interface CookStatus {
	stage: "idle" | "heating water" | "heating" | "holding" | "complete" | "unknown";
	protein: string | null;
	coreTargetC: number | null;
	thicknessMm: number | null;
	bathSetpointC: number | null;
	waterC: number | null;
	cookerOn: boolean | null;
	coreC: number | null;
	pasteurisedPercent: number | null;
	fsaiHoldRemainingMin: number | null;
	plannedBathMinutes: number | null;
	plannedFinish: string | null;
	timerEndsAt: string | null;
	tableTimerEndsAt: string | null;
}

function endsAt(timer: z.infer<typeof StateSchema> | null): string | null {
	const finishesAt = timer?.attributes?.finishes_at;
	return timer?.state === "active" && typeof finishesAt === "string" ? finishesAt : null;
}

export async function cookStatus(
	options: PublishOptions = {},
): Promise<CookStatus | { error: string }> {
	if (!token(options)) return { error: "Not running inside Home Assistant" };
	const entries = Object.entries(STATUS_ENTITIES);
	const [values, timer, tableTimer] = await Promise.all([
		Promise.all(entries.map(([, entityId]) => readState(entityId, options))),
		readEntity(MANUAL_TIMER, options),
		readEntity(TABLE_TIMER, options),
	]);
	const s: Record<string, string | null> = {};
	entries.forEach(([key], i) => {
		s[key] = values[i] ?? null;
	});
	const state = s.state ?? null;
	// Once the probe shows the core at target the pasteurisation state is the news, even if the cook
	// script is still running (it waits for the water and can outlast the bags going in)
	const stage =
		state === "holding" || state === "complete"
			? state
			: s.heating === "on"
				? "heating water"
				: state === "idle" || state === "heating"
					? state
					: "unknown";
	return {
		stage,
		protein: s.protein ?? null,
		coreTargetC: num(s.coreTarget ?? null),
		thicknessMm: num(s.thickness ?? null),
		bathSetpointC: num(s.bathSetpoint ?? null),
		waterC: num(s.water ?? null),
		cookerOn: s.cookerOn === "on" ? true : s.cookerOn === "off" ? false : null,
		coreC: num(s.core ?? null),
		// The kill keeps adding up after 100 %, which reads as nonsense; 100 means done
		pasteurisedPercent: capPercent(num(s.killProgress ?? null)),
		fsaiHoldRemainingMin: num(s.fsaiRemaining ?? null),
		plannedBathMinutes: num(s.plannedMinutes ?? null),
		plannedFinish: s.plannedFinish ?? null,
		timerEndsAt: endsAt(timer),
		tableTimerEndsAt: endsAt(tableTimer),
	};
}
