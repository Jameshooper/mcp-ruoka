import { logger } from "./logger.ts";
import { listPlans, type MealPlan, onPlansChanged } from "./plan-book.ts";

const ENTITY_ID = "sensor.ruoka_dinner_menu";
const STATES_URL = `http://supervisor/core/api/states/${ENTITY_ID}`;
const DAYS = 7;
// Often enough that the menu moves on to the next day soon after midnight, and that the sensor
// comes back soon after a Home Assistant restart (states set through the API are not kept)
const REFRESH_MS = 15 * 60_000;
// Home Assistant refuses states longer than this
const MAX_STATE_LENGTH = 255;
const NOTHING_PLANNED = "Nothing planned";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// "Wed 21 Oct dinner" (the family plan's slots), "21 October"
const DAY_MONTH_RE =
	/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/i;
// "21.10." or "21/10", the Finnish and British numeric forms
const NUMERIC_RE = /\b(\d{1,2})[./](\d{1,2})\.?(?:[./](\d{4}))?(?!\d)/;
const OTHER_MEALS_RE = /\b(breakfast|brunch|lunch|snack|aamiainen|lounas)\b/i;

export interface MenuDay {
	date: string;
	label: string;
	dish: string | null;
	recipe: string | null;
	plan: string | null;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

export function localIsoDate(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function validDate(year: number, month: number, day: number): Date | null {
	const d = new Date(year, month - 1, day);
	return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}

// A slot name carries no year, so take the year that puts the date closest to when the plan was
// made: a plan saved on 28 December for "Fri 2 Jan" means the coming January
function closestYear(month: number, day: number, reference: Date): Date | null {
	let best: Date | null = null;
	for (const year of [
		reference.getFullYear() - 1,
		reference.getFullYear(),
		reference.getFullYear() + 1,
	]) {
		const d = validDate(year, month, day);
		if (!d) continue;
		if (
			!best ||
			Math.abs(d.getTime() - reference.getTime()) < Math.abs(best.getTime() - reference.getTime())
		) {
			best = d;
		}
	}
	return best;
}

// The meal's calendar day: its `date` when the plan was saved with one, otherwise read from the
// slot name. Names with only a weekday ("Mon dinner") are ambiguous, so they get no date.
export function mealDate(
	meal: { name: string; date?: string },
	planCreatedAt: string,
): string | null {
	const reference = new Date(planCreatedAt);
	if (meal.date) {
		const m = ISO_DATE_RE.exec(meal.date);
		const d = m && validDate(Number(m[1]), Number(m[2]), Number(m[3]));
		if (d) return localIsoDate(d);
	}
	const named = DAY_MONTH_RE.exec(meal.name);
	if (named) {
		const day = Number(named[1]);
		const month = MONTHS.indexOf((named[2] ?? "").toLowerCase()) + 1;
		const d = named[3]
			? validDate(Number(named[3]), month, day)
			: closestYear(month, day, reference);
		return d ? localIsoDate(d) : null;
	}
	const numeric = NUMERIC_RE.exec(meal.name);
	if (numeric) {
		const day = Number(numeric[1]);
		const month = Number(numeric[2]);
		const d = numeric[3]
			? validDate(Number(numeric[3]), month, day)
			: closestYear(month, day, reference);
		return d ? localIsoDate(d) : null;
	}
	return null;
}

function dayLabel(d: Date): string {
	return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]?.replace(/^./, (c) => c.toUpperCase())}`;
}

// Today and the next six days. When two saved plans cover the same evening, the one saved last wins,
// since re-planning a week is how a menu gets changed.
export function buildMenu(plans: MealPlan[], today: Date, days = DAYS): MenuDay[] {
	const byDate = new Map<
		string,
		{ dish: string; recipe: string | null; plan: string; updatedAt: string }
	>();
	for (const plan of plans) {
		for (const meal of plan.meals) {
			if (OTHER_MEALS_RE.test(meal.name)) continue;
			const date = mealDate(meal, plan.createdAt);
			if (!date) continue;
			const current = byDate.get(date);
			if (current && current.updatedAt > plan.updatedAt) continue;
			byDate.set(date, {
				dish: meal.dish ?? meal.name,
				recipe: meal.recipe ?? null,
				plan: plan.name,
				updatedAt: plan.updatedAt,
			});
		}
	}
	return Array.from({ length: days }, (_, i) => {
		const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
		const date = localIsoDate(d);
		const found = byDate.get(date);
		return {
			date,
			label: dayLabel(d),
			dish: found?.dish ?? null,
			recipe: found?.recipe ?? null,
			plan: found?.plan ?? null,
		};
	});
}

// Flat day_1..day_7 strings ("Mon 16 Nov~Salmon soup") alongside the list, because small displays
// (ESPHome) read one attribute as plain text far more easily than they parse a JSON list
export function menuState(menu: MenuDay[]) {
	const tonight = menu[0]?.dish ?? NOTHING_PLANNED;
	const attributes: Record<string, unknown> = {
		friendly_name: "Dinner menu",
		icon: "mdi:silverware-fork-knife",
		days: menu,
	};
	menu.forEach((day, i) => {
		attributes[`day_${i + 1}`] = `${day.label}~${day.dish ?? "-"}`;
	});
	return {
		state:
			tonight.length > MAX_STATE_LENGTH ? `${tonight.slice(0, MAX_STATE_LENGTH - 3)}...` : tonight,
		attributes,
	};
}

export type PublishResult = { ok: true } | { ok: false; error: string };

export async function publishDinnerMenu(
	options: { now?: Date; fetchFn?: typeof fetch; token?: string; plans?: MealPlan[] } = {},
): Promise<PublishResult> {
	const token = options.token ?? process.env.SUPERVISOR_TOKEN ?? "";
	if (!token) return { ok: false, error: "Not running inside Home Assistant" };
	const plans = options.plans ?? (await listPlans());
	const body = menuState(buildMenu(plans, options.now ?? new Date()));
	try {
		const response = await (options.fetchFn ?? fetch)(STATES_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			logger.warn({ status: response.status }, "Home Assistant refused the dinner menu");
			return { ok: false, error: `Home Assistant answered HTTP ${response.status}` };
		}
		return { ok: true };
	} catch (err) {
		logger.warn({ err }, "Could not publish the dinner menu");
		return { ok: false, error: "Could not reach Home Assistant" };
	}
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
	logger.info({ entity: ENTITY_ID }, "Publishing the dinner menu to Home Assistant");
}
