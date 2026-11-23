import { expect, test } from "bun:test";
import {
	cookStatus,
	markBagsIn,
	startCook,
	startManual,
	stopCook,
	stopManual,
} from "./home-assistant/sous-vide.ts";
import {
	estimateSousVide,
	findPreset,
	ManualBathSchema,
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
		true,
		{ token: "t", fetchFn },
	);
	expect(result).toEqual({ ok: true });
	expect(calls[0]?.url).toBe("http://supervisor/core/api/services/script/turn_on");
	expect(calls[0]?.body).toEqual({
		entity_id: "script.sous_vide_cook",
		variables: {
			protein: "Fatty fish",
			thickness: 25,
			core_temperature: 57,
			bath_offset: 0.5,
			meater: true,
		},
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

test("manual mode sets the water, switches on and starts or cancels the timer", async () => {
	const calls: Array<{ url: string; body: unknown }> = [];
	const fetchFn = Object.assign(
		async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(url).replace("http://supervisor/core/api/services/", ""),
				body: JSON.parse(String(init?.body)),
			});
			return new Response("[]");
		},
		{ preconnect: () => {} },
	);
	expect(await startManual(45.5, 90, { token: "t", fetchFn })).toEqual({ ok: true });
	expect(calls).toEqual([
		{
			url: "number/set_value",
			body: { entity_id: "number.sous_vide_set_temperature", value: 45.5 },
		},
		{ url: "switch/turn_on", body: { entity_id: "switch.isv_100w2_0_sous_vide_running" } },
		{
			url: "timer/start",
			body: { entity_id: "timer.sous_vide_manual_timer", duration: "01:30:00" },
		},
	]);
	calls.length = 0;
	await startManual(60, undefined, { token: "t", fetchFn });
	expect(calls[2]).toEqual({
		url: "timer/cancel",
		body: { entity_id: "timer.sous_vide_manual_timer" },
	});
	calls.length = 0;
	await stopManual({ token: "t", fetchFn });
	expect(calls.map((c) => c.url)).toEqual(["timer/cancel", "switch/turn_off"]);
});

test("manual limits follow the cooker", () => {
	expect(ManualBathSchema.safeParse({ bathC: 45.5, minutes: 90 }).success).toBe(true);
	expect(ManualBathSchema.safeParse({ bathC: 95 }).success).toBe(false);
	expect(ManualBathSchema.safeParse({ bathC: 45.3 }).success).toBe(false);
	expect(ManualBathSchema.safeParse({ bathC: 60, minutes: 0 }).success).toBe(false);
});

test("a cook without the MEATER tells the script to time it from the table", async () => {
	const bodies: unknown[] = [];
	const fetchFn = Object.assign(
		async (_url: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response("[]");
		},
		{ preconnect: () => {} },
	);
	await startCook(
		{
			protein: "poultry",
			coreTempC: 63,
			thicknessMm: 25,
			bathOffsetC: 1,
			preset: null,
			finish: null,
		},
		false,
		{ token: "t", fetchFn },
	);
	expect(bodies[0]).toMatchObject({ variables: { meater: false, protein: "Poultry" } });
});

test("estimates match Baldwin's tables and stay on the safe side", () => {
	// Table 4.1, 63 °C column, 25 mm: 1¼ hr; Table 1.1 slab, 25 mm: 50 min
	expect(estimateSousVide("poultry", 63, 25)).toEqual({
		cookMinutes: 75,
		coolMinutes: 50,
		coolWithinFsai: true,
	});
	// Part degrees use the cooler (longer) column; 23 mm rounds up to 25 mm
	expect(estimateSousVide("poultry", 63.5, 23).cookMinutes).toBe(75);
	// Above the table the hottest column applies (Table 5.1, 66 °C, 25 mm: 55 min)
	expect(estimateSousVide("meat", 70, 25).cookMinutes).toBe(55);
	// Below the table there is no table time
	expect(estimateSousVide("poultry", 56, 25).cookMinutes).toBeNull();
	// Table 3.1 fatty fish, 60 °C, 70 mm: 5¼ hr
	expect(estimateSousVide("fish_fatty", 60, 70).cookMinutes).toBe(315);
	// 50 mm takes 2¾ hr to chill, past the FSAI 2 hour limit
	expect(estimateSousVide("meat", 60, 50)).toMatchObject({
		coolMinutes: 165,
		coolWithinFsai: false,
	});
});

function slowHomeAssistant(lastTriggered: string) {
	return Object.assign(
		async (_url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST")
				throw new DOMException("The operation timed out.", "TimeoutError");
			return new Response(
				JSON.stringify({ state: "on", attributes: { last_triggered: lastTriggered } }),
			);
		},
		{ preconnect: () => {} },
	);
}

const chicken = {
	protein: "poultry" as const,
	coreTempC: 63,
	thicknessMm: 30,
	bathOffsetC: 1,
	preset: null,
	finish: null,
};

test("a slow answer still counts when the cook script did start", async () => {
	const fetchFn = slowHomeAssistant(new Date().toISOString());
	expect(await startCook(chicken, true, { token: "t", fetchFn })).toEqual({ ok: true });
});

test("a slow answer is an error when the script did not start", async () => {
	const fetchFn = slowHomeAssistant("2026-11-19T10:00:00+00:00");
	expect(await startCook(chicken, true, { token: "t", fetchFn })).toEqual({
		ok: false,
		error: "Home Assistant did not answer in time",
	});
});

test("status shows holding while the script is still waiting, and caps the kill at 100 %", async () => {
	const states: Record<string, string> = {
		"input_select.pasteurisation_state": "holding",
		"script.sous_vide_cook": "on",
		"sensor.pasteurisation_kill_progress": "718.7",
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
	expect(await cookStatus({ token: "t", fetchFn })).toMatchObject({
		stage: "holding",
		pasteurisedPercent: 100,
	});
});

test("marking the bags in runs Home Assistant's bags-in script with where it came from", async () => {
	const calls: Array<{ url: string; body: unknown }> = [];
	const fetchFn = Object.assign(
		async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response("[]");
		},
		{ preconnect: () => {} },
	);
	expect(await markBagsIn("Bags in button", { token: "t", fetchFn })).toEqual({ ok: true });
	expect(calls[0]).toEqual({
		url: "http://supervisor/core/api/services/script/turn_on",
		body: { entity_id: "script.sous_vide_bags_in", variables: { source: "Bags in button" } },
	});
});

test("status reports when the bags went in, for the elapsed time", async () => {
	const fetchFn = Object.assign(
		async (url: string | URL | Request) => {
			const id = String(url).split("/").pop() ?? "";
			if (id === "input_datetime.sous_vide_bags_in") {
				return new Response(
					JSON.stringify({ state: "2026-11-22 17:41:26", attributes: { timestamp: 1795362086 } }),
				);
			}
			if (id === "input_boolean.sous_vide_bags_confirmed") {
				return new Response(JSON.stringify({ state: "on" }));
			}
			return new Response("", { status: 404 });
		},
		{ preconnect: () => {} },
	);
	expect(await cookStatus({ token: "t", fetchFn })).toMatchObject({
		bagsInAt: new Date(1795362086 * 1000).toISOString(),
		bagsConfirmed: true,
	});
});
