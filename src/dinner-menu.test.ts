import { expect, test } from "bun:test";
import { buildMenu, mealDate, menuState, publishDinnerMenu } from "./dinner-menu.ts";
import type { MealPlan } from "./plan-book.ts";

function plan(
	name: string,
	meals: Array<{ name: string; dish?: string; date?: string; recipe?: string }>,
	createdAt = "2026-11-14T10:00:00.000Z",
	updatedAt = createdAt,
): MealPlan {
	const emptyList = { total: 0, lines: [] };
	return {
		id: name.toLowerCase().replace(/\s+/g, "-"),
		name,
		createdAt,
		updatedAt,
		checked: [],
		store: { chain: "s-kaupat", storeId: "1" },
		meals: meals.map((m) => ({ ...m, servings: 4, ingredients: [], steps: [] })),
		toBuy: emptyList,
		pantry: emptyList,
		balance: { balanced: true, issues: [], counts: {} },
		nutrition: { average: null, missing: [] },
		missing: [],
		unquantified: [],
		waste: { leftoverValue: 0 },
		pooling: { saved: 0 },
	};
}

const created = "2026-10-17T11:20:08.509Z";

test("reads the date from the family plan's slot names", () => {
	expect(mealDate({ name: "Wed 21 Oct dinner" }, created)).toBe("2026-10-21");
	expect(mealDate({ name: "Thu 29 October" }, created)).toBe("2026-10-29");
	expect(mealDate({ name: "Ke 21.10. päivällinen" }, created)).toBe("2026-10-21");
	expect(mealDate({ name: "21/10 dinner" }, created)).toBe("2026-10-21");
});

test("an explicit date wins over the slot name", () => {
	expect(mealDate({ name: "Wed 21 Oct dinner", date: "2026-10-22" }, created)).toBe("2026-10-22");
});

test("a weekday alone is too vague to place on the calendar", () => {
	expect(mealDate({ name: "Mon: Chicken curry" }, created)).toBeNull();
	expect(mealDate({ name: "31 Feb dinner" }, created)).toBeNull();
});

test("a slot without a year lands in the year nearest to when the plan was made", () => {
	expect(mealDate({ name: "Fri 2 Jan dinner" }, "2026-12-28T12:00:00.000Z")).toBe("2027-01-02");
	expect(mealDate({ name: "Mon 29 Dec dinner" }, "2027-01-02T12:00:00.000Z")).toBe("2026-12-29");
});

test("builds seven days from today, with gaps where nothing is planned", () => {
	const menu = buildMenu(
		[
			plan("Family plan 18 Nov - 26 Nov", [
				{ name: "Wed 18 Nov dinner", dish: "Salmon soup", recipe: "salmon-soup" },
				{ name: "Thu 19 Nov dinner", dish: "Tacos" },
			]),
		],
		new Date(2026, 10, 15),
	);
	expect(menu).toHaveLength(7);
	expect(menu[0]).toEqual({
		date: "2026-11-15",
		label: "Sun 15 Nov",
		dish: null,
		recipe: null,
		plan: null,
	});
	expect(menu[3]).toEqual({
		date: "2026-11-18",
		label: "Wed 18 Nov",
		dish: "Salmon soup",
		recipe: "salmon-soup",
		plan: "Family plan 18 Nov - 26 Nov",
	});
	expect(menu[4]?.dish).toBe("Tacos");
});

test("the most recently saved plan wins a shared evening, and lunches are left out", () => {
	const older = plan(
		"Old",
		[{ name: "Wed 18 Nov dinner", dish: "Old dish" }],
		created,
		"2026-11-01T00:00:00Z",
	);
	const newer = plan(
		"New",
		[
			{ name: "Wed 18 Nov dinner", dish: "New dish" },
			{ name: "Thu 19 Nov lunch", dish: "Sandwiches" },
		],
		created,
		"2026-11-10T00:00:00Z",
	);
	const menu = buildMenu([newer, older], new Date(2026, 10, 18));
	expect(menu[0]?.dish).toBe("New dish");
	expect(menu[1]?.dish).toBeNull();
});

test("flattens the menu into day attributes and puts tonight in the state", () => {
	const menu = buildMenu(
		[plan("P", [{ name: "Sun 15 Nov dinner", dish: "Curry" }])],
		new Date(2026, 10, 15),
	);
	const { state, attributes } = menuState(menu);
	expect(state).toBe("Curry");
	expect(attributes.day_1).toBe("Sun 15 Nov~Curry");
	expect(attributes.day_2).toBe("Mon 16 Nov~-");
	expect(attributes.day_7).toBe("Sat 21 Nov~-");
	expect(menuState(buildMenu([], new Date(2026, 10, 15))).state).toBe("Nothing planned");
});

test("posts the sensor to Home Assistant through the Supervisor", async () => {
	const calls: Array<{ url: string; auth: string | null; body: string }> = [];
	const fetchFn = async (input: Request | URL | string, init?: RequestInit) => {
		calls.push({
			url: String(input),
			auth: new Headers(init?.headers).get("authorization"),
			body: String(init?.body),
		});
		return new Response("{}", { status: 201 });
	};
	const result = await publishDinnerMenu({
		token: "tok",
		now: new Date(2026, 10, 15),
		plans: [plan("P", [{ name: "Sun 15 Nov dinner", dish: "Curry" }])],
		fetchFn: Object.assign(fetchFn, { preconnect: () => {} }),
	});
	expect(result).toEqual({ ok: true });
	expect(calls[0]?.url).toBe("http://supervisor/core/api/states/sensor.ruoka_dinner_menu");
	expect(calls[0]?.auth).toBe("Bearer tok");
	expect(JSON.parse(calls[0]?.body ?? "{}").state).toBe("Curry");
});

test("does nothing outside Home Assistant", async () => {
	expect(await publishDinnerMenu({ token: "", plans: [] })).toEqual({
		ok: false,
		error: "Not running inside Home Assistant",
	});
});
