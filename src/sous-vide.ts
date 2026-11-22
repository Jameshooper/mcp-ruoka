import * as z from "zod/v4";

// The pasteurisation maths lives in Home Assistant (Baldwin's kill rates, the FSAI hold and the
// MEATER probe); the app only says what is being cooked. These names must match the options of
// Home Assistant's input_select.sous_vide_protein, which picks the kill rates and tables.
export const SOUS_VIDE_PROTEINS = {
	meat: "Beef / pork / lamb",
	poultry: "Poultry",
	fish_lean: "Lean fish",
	fish_fatty: "Fatty fish",
} as const;

export const SousVideProteinSchema = z
	.enum(["meat", "poultry", "fish_lean", "fish_fatty"])
	.describe(
		"Which pasteurisation table and kill rates apply: meat (beef, pork, lamb), poultry, fish_lean (cod, pike-perch, whitefish) or fish_fatty (salmon, trout, char)",
	);

export type SousVideProtein = z.infer<typeof SousVideProteinSchema>;

export const SousVideSchema = z
	.object({
		preset: z
			.string()
			.min(1)
			.max(60)
			.optional()
			.describe(
				"The sous vide preset this follows (list_sous_vide_presets), e.g. 'Chicken breast'",
			),
		protein: SousVideProteinSchema,
		coreTempC: z
			.number()
			.min(55)
			.max(75)
			.multipleOf(0.5)
			.describe("Core target temperature in °C (55-75, in 0.5 steps)"),
		thicknessMm: z
			.number()
			.int()
			.min(5)
			.max(70)
			.describe("Thickness of the thickest piece in mm (5-70)"),
		bathOffsetC: z
			.number()
			.min(0)
			.max(2.5)
			.multipleOf(0.5)
			.optional()
			.describe("How far above the core target to set the water, in °C (default 1)"),
		finish: z
			.string()
			.min(1)
			.max(300)
			.optional()
			.describe("What to do after the bath, e.g. 'Sear 1 min per side in a smoking-hot pan'"),
	})
	.describe(
		"Sous vide settings for a recipe cooked in the water bath. Home Assistant uses them to set the cooker and to track pasteurisation with the MEATER probe.",
	);

export type SousVide = z.infer<typeof SousVideSchema>;

export interface SousVidePreset {
	name: string;
	protein: SousVideProtein;
	coreTempC: number;
	thicknessMm: number;
	bathOffsetC: number;
	finish: string;
	note: string;
	source: string;
}

// Starting points, all at pasteurising temperatures so the MEATER can confirm them. Fish below
// 55 °C (the classic silky salmon) is never pasteurised, so it is left out on purpose.
export const SOUS_VIDE_PRESETS: readonly SousVidePreset[] = [
	{
		name: "Chicken breast",
		protein: "poultry",
		coreTempC: 63,
		thicknessMm: 25,
		bathOffsetC: 1,
		finish: "Pat dry and sear 1 min per side, or crisp the skin separately",
		note: "Juicy and tender",
		source: "Baldwin, Practical Guide to Sous Vide Cooking: breasts in a 63.5 °C bath",
	},
	{
		name: "Chicken thigh",
		protein: "poultry",
		coreTempC: 65,
		thicknessMm: 25,
		bathOffsetC: 1,
		finish: "Sear skin-side down until crisp",
		note: "Firmer texture than breast temperatures",
		source: "Common practice, not from Baldwin (he only gives legs as confit at 80 °C)",
	},
	{
		name: "Turkey breast",
		protein: "poultry",
		coreTempC: 63,
		thicknessMm: 40,
		bathOffsetC: 1,
		finish: "Sear or brown under the grill",
		note: "Thicker than chicken, so the cook is longer",
		source: "Baldwin: chicken or turkey breast in a 63.5 °C bath",
	},
	{
		name: "Pork tenderloin",
		protein: "meat",
		coreTempC: 60,
		thicknessMm: 40,
		bathOffsetC: 1,
		finish: "Sear all round in a hot pan",
		note: "Pink and juicy",
		source: "Baldwin: pork in a 61 °C bath",
	},
	{
		name: "Pork chop",
		protein: "meat",
		coreTempC: 60,
		thicknessMm: 25,
		bathOffsetC: 1,
		finish: "Sear 1 min per side",
		note: "Pink and juicy",
		source: "Baldwin: pork chops in a 61 °C bath",
	},
	{
		name: "Beef steak (medium-rare)",
		protein: "meat",
		coreTempC: 56,
		thicknessMm: 25,
		bathOffsetC: 0.5,
		finish: "Sear 45 s per side in a smoking-hot pan",
		note: "Pasteurising at medium-rare takes a few hours",
		source:
			"Baldwin: medium-rare 55 °C, the lowest pasteurising column; 56 °C gives a little margin",
	},
	{
		name: "Beef steak (medium)",
		protein: "meat",
		coreTempC: 60,
		thicknessMm: 25,
		bathOffsetC: 1,
		finish: "Sear 45 s per side in a smoking-hot pan",
		note: "Shorter cook than medium-rare",
		source: "Baldwin: medium 60 °C",
	},
	{
		name: "Lamb loin",
		protein: "meat",
		coreTempC: 57,
		thicknessMm: 30,
		bathOffsetC: 0.5,
		finish: "Sear the fat side until golden",
		note: "Rosy pink",
		source: "Baldwin's meat doneness (medium-rare 55 °C, medium 60 °C)",
	},
	{
		name: "Salmon fillet",
		protein: "fish_fatty",
		coreTempC: 57,
		thicknessMm: 25,
		bathOffsetC: 0.5,
		finish: "Serve as is, or crisp the skin in a pan",
		note: "Pasteurised, so firmer than restaurant salmon: Baldwin's best texture (43-49 °C) is not pasteurised",
		source: "Baldwin: Table 3.1 fatty fish, 55-60 °C",
	},
	{
		name: "Cod fillet",
		protein: "fish_lean",
		coreTempC: 60,
		thicknessMm: 25,
		bathOffsetC: 0.5,
		finish: "Serve as is with a sauce, or brown briefly in butter",
		note: "Flaky and moist",
		source: "Baldwin: most fish best at medium, 60 °C",
	},
];

export function findPreset(name: string): SousVidePreset | undefined {
	const wanted = name.trim().toLowerCase();
	return SOUS_VIDE_PRESETS.find((preset) => preset.name.toLowerCase() === wanted);
}

export interface SousVideSettings {
	protein: SousVideProtein;
	coreTempC: number;
	thicknessMm: number;
	bathOffsetC: number;
	preset: string | null;
	finish: string | null;
}

export const SousVideOverridesSchema = z.object({
	protein: SousVideProteinSchema.optional(),
	coreTempC: z.number().min(55).max(75).multipleOf(0.5).optional(),
	thicknessMm: z.number().int().min(5).max(70).optional(),
	bathOffsetC: z.number().min(0).max(2.5).multipleOf(0.5).optional(),
});

export type SousVideOverrides = z.infer<typeof SousVideOverridesSchema>;

// Home Assistant's tables step in 5 mm and look up the column at or below the thickness they are
// given, so a thickness between steps is rounded up to keep the planned time on the safe side
export function roundThicknessUp(mm: number): number {
	return Math.min(70, Math.max(5, Math.ceil(mm / 5) * 5));
}

// Explicit values win over the recipe, which wins over its preset
export function resolveSousVide(
	base: { preset?: SousVidePreset; recipe?: SousVide },
	overrides: SousVideOverrides = {},
): SousVideSettings | { error: string } {
	const fromPreset = base.recipe?.preset ? findPreset(base.recipe.preset) : undefined;
	const preset = base.preset ?? fromPreset;
	const protein = overrides.protein ?? base.recipe?.protein ?? preset?.protein;
	const coreTempC = overrides.coreTempC ?? base.recipe?.coreTempC ?? preset?.coreTempC;
	const thicknessMm = overrides.thicknessMm ?? base.recipe?.thicknessMm ?? preset?.thicknessMm;
	if (protein === undefined || coreTempC === undefined || thicknessMm === undefined) {
		return {
			error:
				"Need the protein, core temperature and thickness: give a preset, a recipe with sous vide settings, or the values themselves",
		};
	}
	return {
		protein,
		coreTempC,
		thicknessMm: roundThicknessUp(thicknessMm),
		bathOffsetC: overrides.bathOffsetC ?? base.recipe?.bathOffsetC ?? preset?.bathOffsetC ?? 1,
		preset: preset?.name ?? base.recipe?.preset ?? null,
		finish: base.recipe?.finish ?? preset?.finish ?? null,
	};
}

// Manual mode: the cooker as a plain water heater, for things that are not pasteurised (eggs,
// fish below 55 °C, warming water). Limits match the INKBIRD entity in Home Assistant.
export const ManualBathSchema = z.object({
	bathC: z
		.number()
		.min(20)
		.max(90)
		.multipleOf(0.5)
		.describe("Water temperature in °C (20-90, in 0.5 steps)"),
	minutes: z
		.number()
		.int()
		.min(1)
		.max(1440)
		.optional()
		.describe("Switch the cooker off after this many minutes; leave out to keep it running"),
});

// Douglas Baldwin, "A Practical Guide to Sous Vide Cooking": total minutes in the bath from 5 °C
// fridge-cold for thicknesses 5-70 mm in 5 mm steps, keyed by bath temperature column (°C).
// Tables 3.1 (lean and fatty fish), 4.1 (poultry) and 5.1 (beef, pork, lamb). Home Assistant holds
// the same tables for the planned finish; these let the panel show the time while the cook edits.
const BATH_MINUTES: Record<SousVideProtein, Record<number, readonly number[]>> = {
	meat: {
		55: [120, 120, 135, 150, 165, 180, 195, 210, 240, 270, 300, 315, 360, 390],
		56: [75, 90, 105, 120, 135, 150, 165, 180, 195, 225, 255, 285, 315, 345],
		57: [60, 75, 90, 105, 120, 120, 135, 150, 180, 195, 225, 255, 285, 315],
		58: [45, 55, 75, 90, 105, 120, 120, 135, 165, 180, 210, 225, 255, 285],
		59: [40, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 210, 240, 255],
		60: [30, 40, 55, 75, 90, 90, 105, 120, 135, 150, 180, 195, 225, 240],
		61: [25, 35, 50, 60, 75, 90, 105, 105, 135, 150, 165, 180, 210, 225],
		62: [25, 30, 45, 55, 75, 90, 90, 105, 120, 135, 165, 180, 195, 225],
		63: [18, 30, 40, 55, 75, 75, 90, 105, 120, 135, 150, 165, 195, 210],
		64: [16, 25, 40, 50, 60, 75, 90, 90, 105, 120, 150, 165, 180, 195],
		65: [14, 25, 35, 45, 55, 75, 75, 90, 105, 120, 135, 150, 180, 195],
		66: [13, 25, 35, 45, 55, 75, 75, 90, 105, 120, 135, 150, 165, 195],
	},
	poultry: {
		57: [135, 135, 150, 165, 180, 195, 225, 240, 270, 285, 315, 345, 375, 420],
		58: [105, 105, 105, 120, 135, 165, 180, 195, 225, 255, 270, 300, 330, 360],
		59: [75, 75, 90, 105, 120, 135, 150, 165, 195, 225, 240, 270, 300, 330],
		60: [45, 55, 75, 75, 90, 120, 135, 150, 180, 195, 225, 255, 270, 300],
		61: [35, 40, 50, 75, 90, 105, 120, 135, 165, 180, 210, 225, 255, 285],
		62: [25, 35, 45, 55, 75, 90, 105, 120, 150, 165, 195, 210, 240, 270],
		63: [18, 30, 40, 50, 75, 90, 105, 120, 135, 150, 180, 195, 225, 255],
		64: [15, 25, 35, 45, 60, 75, 90, 105, 120, 150, 165, 195, 210, 240],
		65: [13, 20, 30, 40, 55, 75, 90, 105, 120, 135, 165, 180, 195, 225],
	},
	fish_lean: {
		55: [150, 165, 165, 180, 195, 225, 240, 270, 285, 315, 345, 375, 420, 450],
		56: [105, 120, 120, 135, 150, 180, 195, 225, 240, 270, 300, 330, 360, 405],
		57: [75, 90, 90, 105, 120, 150, 165, 180, 210, 240, 270, 300, 330, 360],
		58: [50, 60, 75, 90, 105, 120, 150, 165, 195, 210, 240, 270, 300, 330],
		59: [35, 45, 55, 75, 90, 105, 135, 150, 165, 195, 225, 240, 270, 300],
		60: [30, 35, 50, 60, 75, 105, 120, 135, 150, 180, 210, 225, 255, 285],
	},
	fish_fatty: {
		55: [255, 255, 270, 285, 300, 315, 330, 360, 390, 420, 450, 480, 510, 555],
		56: [180, 180, 195, 210, 225, 240, 255, 285, 315, 345, 375, 405, 435, 480],
		57: [120, 120, 135, 150, 165, 195, 210, 240, 255, 285, 315, 345, 375, 420],
		58: [90, 90, 105, 120, 135, 150, 180, 195, 225, 255, 285, 315, 345, 375],
		59: [60, 75, 75, 90, 105, 135, 150, 180, 195, 225, 255, 285, 315, 345],
		60: [40, 50, 60, 75, 90, 120, 135, 150, 180, 195, 225, 255, 285, 315],
	},
};

// Table 1.1, slab-like column (the slowest shape): minutes to cool from 55-80 °C to 5 °C in a bath
// that is at least half ice, for 5-70 mm
const ICE_BATH_MINUTES: readonly number[] = [
	5, 14, 25, 35, 50, 75, 90, 105, 135, 165, 195, 225, 255, 285,
];

// FSAI: chill to 5 °C within 120 minutes (after at most 30 minutes out of the bath)
export const FSAI_CHILL_LIMIT_MIN = 120;

export interface SousVideEstimate {
	cookMinutes: number | null;
	coolMinutes: number;
	coolWithinFsai: boolean;
}

// Uses the column at or below the core target (the bath, target + offset, is hotter, so the time
// is on the safe side) and the thickness rounded up to the next table step. Outside the table the
// cook time is unknown: only the MEATER can say when such a cook is done.
export function estimateSousVide(
	protein: SousVideProtein,
	coreTempC: number,
	thicknessMm: number,
): SousVideEstimate {
	const index = roundThicknessUp(thicknessMm) / 5 - 1;
	const columns = Object.keys(BATH_MINUTES[protein])
		.map(Number)
		.filter((t) => t <= coreTempC);
	const column = columns.length ? Math.max(...columns) : undefined;
	const cookMinutes =
		column === undefined ? null : (BATH_MINUTES[protein][column]?.[index] ?? null);
	const coolMinutes =
		ICE_BATH_MINUTES[index] ?? ICE_BATH_MINUTES[ICE_BATH_MINUTES.length - 1] ?? 285;
	return { cookMinutes, coolMinutes, coolWithinFsai: coolMinutes <= FSAI_CHILL_LIMIT_MIN };
}
