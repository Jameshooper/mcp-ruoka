import { buildMenu, type MenuDay } from "../dinners.ts";
import { logger } from "../logger.ts";
import { listPlans, type MealPlan, onPlansChanged } from "../plan-book.ts";
import { listRecipes, type Recipe } from "../recipe-book.ts";
import { dishIcon } from "./dish-icon.ts";
import { type PublishOptions, type PublishResult, publishState } from "./states.ts";

export const DINNER_MENU_ENTITY = "sensor.ruoka_dinner_menu";
// Often enough that the menu moves on to the next day soon after midnight, and that the sensor
// comes back soon after a Home Assistant restart (states set through the API are not kept)
const REFRESH_MS = 15 * 60_000;
// Home Assistant refuses states longer than this
const MAX_STATE_LENGTH = 255;
const NOTHING_PLANNED = "Nothing planned";

// A meal planned from a saved recipe may carry no protein tag of its own
function withRecipeProtein(menu: MenuDay[], recipes: Recipe[]): MenuDay[] {
	const byId = new Map(recipes.map((r) => [r.id, r.protein]));
	return menu.map((day) => ({
		...day,
		protein: day.protein ?? (day.recipe ? (byId.get(day.recipe) ?? null) : null),
	}));
}

// Flat strings per day alongside the list, because small displays (ESPHome) read one attribute as
// plain text far more easily than they parse a JSON list:
//   day_N      "Mon 16 Nov~Salmon soup"                  (firmware before the date and icon)
//   day_N_full "2026-11-16~Mon 16 Nov~pot~Salmon soup"   (the dish is last, so a ~ in it is safe)
// A day with nothing planned has "-" as its dish and "none" as its icon. The display sends the
// date back with its Cook button, so the app never has to guess the year from a label.
export function menuState(menu: MenuDay[]) {
	const tonight = menu[0]?.dish ?? NOTHING_PLANNED;
	const days = menu.map((day) => ({
		...day,
		icon: day.dish ? dishIcon(day.dish, day.protein) : null,
	}));
	const attributes: Record<string, unknown> = {
		friendly_name: "Dinner menu",
		icon: "mdi:silverware-fork-knife",
		days,
	};
	days.forEach((day, i) => {
		attributes[`day_${i + 1}`] = `${day.label}~${day.dish ?? "-"}`;
		attributes[`day_${i + 1}_full`] =
			`${day.date}~${day.label}~${day.icon ?? "none"}~${day.dish ?? "-"}`;
	});
	return {
		state:
			tonight.length > MAX_STATE_LENGTH ? `${tonight.slice(0, MAX_STATE_LENGTH - 3)}...` : tonight,
		attributes,
	};
}

export async function publishDinnerMenu(
	options: PublishOptions & { now?: Date; plans?: MealPlan[]; recipes?: Recipe[] } = {},
): Promise<PublishResult> {
	const token = options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
	if (!token) return { ok: false, error: "Not running inside Home Assistant" };
	const plans = options.plans ?? (await listPlans());
	const recipes = options.recipes ?? (await listRecipes());
	const menu = withRecipeProtein(buildMenu(plans, options.now ?? new Date()), recipes);
	return publishState(DINNER_MENU_ENTITY, menuState(menu), { ...options, token });
}

// Only inside the Home Assistant app, where the Supervisor token exists
export function startDinnerMenuSync(): void {
	if (!process.env.SUPERVISOR_TOKEN) return;
	const run = () => {
		void publishDinnerMenu();
	};
	run();
	setInterval(run, REFRESH_MS).unref();
	onPlansChanged(run);
	logger.info({ entity: DINNER_MENU_ENTITY }, "Publishing the dinner menu to Home Assistant");
}
