import * as z from "zod/v4";
import { logger } from "../logger.ts";
import { SOUS_VIDE_PROTEINS, type SousVideSettings } from "../sous-vide.ts";
import type { PublishOptions, PublishResult } from "./states.ts";

// Home Assistant owns the cook: script.sous_vide_cook sets the INKBIRD and waits for the water,
// and the Pasteurisation monitor automation decides when the food is safe from the MEATER probe.
// The app only starts and stops that script and reads the result back.
export const COOK_SCRIPT = "script.sous_vide_cook";
export const STOP_SCRIPT = "script.sous_vide_stop";

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

const StateSchema = z.object({ state: z.string() });

function token(options: PublishOptions): string {
	return options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
}

async function callService(
	domain: string,
	service: string,
	data: Record<string, unknown>,
	options: PublishOptions,
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
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok) {
			logger.warn({ domain, service, status: response.status }, "Home Assistant refused a call");
			return { ok: false, error: `Home Assistant answered HTTP ${response.status}` };
		}
		return { ok: true };
	} catch (err) {
		logger.warn({ domain, service, err }, "Could not call Home Assistant");
		return { ok: false, error: "Could not reach Home Assistant" };
	}
}

async function readState(entityId: string, options: PublishOptions): Promise<string | null> {
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
		if (!parsed.success) return null;
		const state = parsed.data.state;
		return state === "unavailable" || state === "unknown" ? null : state;
	} catch {
		return null;
	}
}

// script.turn_on returns at once; calling the script itself would hold the request open for the
// whole time the water heats
export function startCook(
	settings: SousVideSettings,
	options: PublishOptions = {},
): Promise<PublishResult> {
	return callService(
		"script",
		"turn_on",
		{
			entity_id: COOK_SCRIPT,
			variables: {
				protein: SOUS_VIDE_PROTEINS[settings.protein],
				thickness: settings.thicknessMm,
				core_temperature: settings.coreTempC,
				bath_offset: settings.bathOffsetC,
			},
		},
		options,
	);
}

export function stopCook(options: PublishOptions = {}): Promise<PublishResult> {
	return callService("script", "turn_on", { entity_id: STOP_SCRIPT }, options);
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
}

export async function cookStatus(
	options: PublishOptions = {},
): Promise<CookStatus | { error: string }> {
	if (!token(options)) return { error: "Not running inside Home Assistant" };
	const entries = Object.entries(STATUS_ENTITIES);
	const values = await Promise.all(entries.map(([, entityId]) => readState(entityId, options)));
	const s: Record<string, string | null> = {};
	entries.forEach(([key], i) => {
		s[key] = values[i] ?? null;
	});
	const state = s.state ?? null;
	const stage =
		s.heating === "on"
			? "heating water"
			: state === "idle" || state === "heating" || state === "holding" || state === "complete"
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
		pasteurisedPercent: num(s.killProgress ?? null),
		fsaiHoldRemainingMin: num(s.fsaiRemaining ?? null),
		plannedBathMinutes: num(s.plannedMinutes ?? null),
		plannedFinish: s.plannedFinish ?? null,
	};
}
