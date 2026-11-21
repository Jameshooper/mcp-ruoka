import { expect, test } from "bun:test";
import { cookStatus, startCook, stopCook } from "./home-assistant/sous-vide.ts";
import {
	findPreset,
	resolveSousVide,
	roundThicknessUp,
	SOUS_VIDE_PRESETS,
	SousVideSchema,
} from "./sous-vide.ts";

test("every preset is valid sous vide settings and names its source", () => {
	for (const preset of SOUS_VIDE_PRESETS) {
		expect(SousVideSchema.safeParse({ ...preset, preset: preset.name }).success).toBe(true);
		expect(preset.source.length).toBeGreaterThan(0);
	}
	expect(new Set(SOUS_VIDE_PRESETS.map((p) => p.name)).size).toBe(SOUS_VIDE_PRESETS.length);
});

test("presets are found by name regardless of case", () => {
	expect(findPreset("  chicken BREAST ")?.coreTempC).toBe(63);
	expect(findPreset("tofu")).toBeUndefined();
});

test("thickness between table steps rounds up, never down", () => {
	expect(roundThicknessUp(23)).toBe(25);
	expect(roundThicknessUp(25)).toBe(25);
	expect(roundThicknessUp(2)).toBe(5);
	expect(roundThicknessUp(70)).toBe(70);
});

test("explicit values override the recipe, which overrides its preset", () => {
	const fromPreset = resolveSousVide({ preset: findPreset("Chicken breast") });
	expect(fromPreset).toMatchObject({
		protein: "poultry",
		coreTempC: 63,
		thicknessMm: 25,
		bathOffsetC: 1,
		preset: "Chicken breast",
	});

	const recipe = {
		preset: "Chicken breast",
		protein: "poultry" as const,
		coreTempC: 64,
		thicknessMm: 32,
	};
	expect(resolveSousVide({ recipe })).toMatchObject({
		coreTempC: 64,
		thicknessMm: 35,
		bathOffsetC: 1,
	});
	expect(resolveSousVide({ recipe }, { coreTempC: 65, bathOffsetC: 0 })).toMatchObject({
		coreTempC: 65,
		bathOffsetC: 0,
	});
});

test("missing settings are an error, not a guess", () => {
	expect(resolveSousVide({})).toHaveProperty("error");
	expect(resolveSousVide({}, { protein: "meat", coreTempC: 60 })).toHaveProperty("error");
});

test("starting a cook turns the script on with Home Assistant's protein names", async () => {
	const calls: Array<{ url: string; body: unknown }> = [];
	const fetchFn = Object.assign(
		async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response("[]");
		},
		{ preconnect: () => {} },
	);
	const result = await startCook(
		{
			protein: "fish_fatty",
			coreTempC: 57,
			thicknessMm: 25,
			bathOffsetC: 0.5,
			preset: null,
			finish: null,
		},
		{ token: "t", fetchFn },
	);
	expect(result).toEqual({ ok: true });
	expect(calls[0]?.url).toBe("http://supervisor/core/api/services/script/turn_on");
	expect(calls[0]?.body).toEqual({
		entity_id: "script.sous_vide_cook",
		variables: { protein: "Fatty fish", thickness: 25, core_temperature: 57, bath_offset: 0.5 },
	});

	await stopCook({ token: "t", fetchFn });
	expect(calls[1]?.body).toEqual({ entity_id: "script.sous_vide_stop" });
});

test("outside Home Assistant nothing is called", async () => {
	const saved = process.env.SUPERVISOR_TOKEN;
	delete process.env.SUPERVISOR_TOKEN;
	expect(await stopCook()).toEqual({ ok: false, error: "Not running inside Home Assistant" });
	expect(await cookStatus()).toEqual({ error: "Not running inside Home Assistant" });
	if (saved !== undefined) process.env.SUPERVISOR_TOKEN = saved;
});

test("status reads the cook back and treats unavailable as unknown", async () => {
	const states: Record<string, string> = {
		"input_select.pasteurisation_state": "holding",
		"script.sous_vide_cook": "off",
		"sensor.meater_internal": "62.4",
		"sensor.pasteurisation_kill_progress": "71.5",
		"sensor.isv_100w2_0_sous_vide_water_temperature": "unavailable",
		"switch.isv_100w2_0_sous_vide_running": "on",
	};
	const fetchFn = Object.assign(
		async (url: string | URL | Request) => {
			const id = String(url).split("/").pop() ?? "";
			const state = states[id];
			return state === undefined
				? new Response("", { status: 404 })
				: new Response(JSON.stringify({ entity_id: id, state }));
		},
		{ preconnect: () => {} },
	);
	const status = await cookStatus({ token: "t", fetchFn });
	expect(status).toMatchObject({
		stage: "holding",
		coreC: 62.4,
		pasteurisedPercent: 71.5,
		waterC: null,
		cookerOn: true,
		plannedFinish: null,
	});
});
