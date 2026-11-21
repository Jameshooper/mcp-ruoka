import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	cookStatus,
	startCook,
	startManual,
	stopCook,
	stopManual,
} from "../home-assistant/sous-vide.ts";
import { findRecipe } from "../recipe-book.ts";
import {
	findPreset,
	ManualBathSchema,
	resolveSousVide,
	SOUS_VIDE_PRESETS,
	SousVideOverridesSchema,
} from "../sous-vide.ts";

function text(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
	return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const SAFETY =
	"Home Assistant decides when the food is pasteurised, from the MEATER core probe (Baldwin's kill rates, plus the FSAI hold at 64 °C and above). The planned time is only a forecast: never tell the cook the food is safe from the clock.";

export function registerSousVideTools(server: McpServer): void {
	server.registerTool(
		"list_sous_vide_presets",
		{
			description:
				"List the sous vide presets (e.g. 'Chicken breast', 'Beef steak (medium-rare)') with their default protein type, core temperature, thickness, bath offset, finishing step and source. Use a preset's values when writing a sous vide recipe, adjusting the thickness to the actual cut.",
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => text({ presets: SOUS_VIDE_PRESETS }),
	);

	server.registerTool(
		"start_sous_vide",
		{
			description: `Start a sous vide cook on the INKBIRD through Home Assistant: it sets the bath to core target + offset, switches the cooker on and notifies the cook's phone when the water is ready ('drop the bags in, start the MEATER'). Give a saved recipe with sous vide settings, a preset name, or the values; explicit values override the recipe, which overrides its preset. Only call this when the cook asks to start now, and remind them the pot must have water in it. ${SAFETY}`,
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
			inputSchema: SousVideOverridesSchema.extend({
				recipe: z.string().min(1).max(120).optional().describe("Saved recipe id or name"),
				preset: z.string().min(1).max(60).optional().describe("Preset name"),
				meater: z
					.boolean()
					.optional()
					.describe(
						"False when the cook is not using the MEATER probe: Home Assistant then times the cook from Baldwin's table for the protein, thickness and temperature (plus 5 minutes to get the bags in), and refuses cuts outside the table. Default true.",
					),
			}),
		},
		async ({ recipe: recipeName, preset: presetName, meater, ...overrides }) => {
			const recipe = recipeName ? await findRecipe(recipeName) : undefined;
			if (recipeName && !recipe) return failure(`No saved recipe matches "${recipeName}".`);
			const preset = presetName ? findPreset(presetName) : undefined;
			if (presetName && !preset) {
				return failure(
					`No preset named "${presetName}". Presets: ${SOUS_VIDE_PRESETS.map((p) => p.name).join(", ")}`,
				);
			}
			const settings = resolveSousVide({ preset, recipe: recipe?.sousVide }, overrides);
			if ("error" in settings) return failure(settings.error);
			const started = await startCook(settings, meater ?? true);
			if (!started.ok) return failure(`Could not start the cook: ${started.error}`);
			return text({
				started: true,
				recipe: recipe?.name ?? null,
				...settings,
				bathC: settings.coreTempC + settings.bathOffsetC,
				meater: meater ?? true,
				next:
					meater === false
						? "Heating the water; when it is ready Home Assistant tells the phone to drop the bags in and starts a timer from Baldwin's table. That time assumes thawed, fridge-cold food and the thickness given; no probe confirms it."
						: "Heating the water; Home Assistant will notify the phone when to drop the bags in and start the MEATER.",
			});
		},
	);

	server.registerTool(
		"sous_vide_status",
		{
			description: `How the current sous vide cook is going: stage (heating water, heating, holding, complete), water and core temperatures, percent pasteurised, the FSAI hold remaining and the planned finish. ${SAFETY} Only say it is safe when stage is 'complete'.`,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () => {
			const status = await cookStatus();
			return "error" in status ? failure(status.error) : text(status);
		},
	);

	server.registerTool(
		"set_sous_vide_bath",
		{
			description:
				"Manual control: set the INKBIRD water to a temperature and switch it on, optionally for a number of minutes after which Home Assistant switches it off (with a 5-minute warning). This is NOT tracked for pasteurisation: use it for eggs, fish below 55 °C, warming water or anything the cook asks for directly, and say clearly that food cooked this way is not confirmed pasteurised. For meat, poultry or fish that should be pasteurised, use start_sous_vide instead. Only call this when the cook asks, and remind them the pot needs water.",
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
			inputSchema: ManualBathSchema,
		},
		async ({ bathC, minutes }) => {
			const result = await startManual(bathC, minutes);
			if (!result.ok) return failure(`Could not set the bath: ${result.error}`);
			return text({
				bathC,
				minutes: minutes ?? null,
				switchesOffAt: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
				pasteurisationTracked: false,
			});
		},
	);

	server.registerTool(
		"stop_sous_vide",
		{
			description:
				"Switch the INKBIRD off, cancel a cook that is still heating the water, and cancel a manual timer. Only call this when the cook asks.",
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		async () => {
			const [stopped] = await Promise.all([stopCook(), stopManual()]);
			return stopped.ok ? text({ stopped: true }) : failure(`Could not stop: ${stopped.error}`);
		},
	);
}
