import { expect, test } from "bun:test";
import { assessBalance, type PlannedMeal, summarizeNutrition } from "./balance.ts";

const options = {
	requireProteins: ["white_meat", "red_meat", "fish"] as const,
	maxRedMeatMeals: 2,
};
const opts = { ...options, requireProteins: [...options.requireProteins] };

const meal = (name: string, extra: Partial<PlannedMeal> = {}): PlannedMeal => ({
	name,
	servings: 2,
	vegetables: true,
	...extra,
});

test("a balanced week passes", () => {
	const report = assessBalance(
		[
			meal("Mon", { protein: "white_meat" }),
			meal("Tue", { protein: "fish" }),
			meal("Wed", { protein: "red_meat" }),
			meal("Thu", { protein: "vegetarian" }),
		],
		opts,
	);
	expect(report.balanced).toBe(true);
	expect(report.counts).toEqual({ white_meat: 1, red_meat: 1, fish: 1, vegetarian: 1, other: 0 });
});

test("missing categories, too much red meat and missing vegetables are reported", () => {
	const report = assessBalance(
		[
			meal("Mon", { protein: "red_meat" }),
			meal("Tue", { protein: "red_meat", vegetables: false }),
			meal("Wed", { protein: "red_meat" }),
			meal("Thu", { protein: "white_meat", vegetables: undefined }),
		],
		opts,
	);
	expect(report.balanced).toBe(false);
	expect(report.issues).toContain("No fish meal in the plan");
	expect(report.issues.some((i) => i.startsWith("3 red meat meals"))).toBe(true);
	expect(report.issues.some((i) => i.includes("Tue, Thu"))).toBe(true);
});

test("untagged meals are flagged and a short plan is not forced to cover every category", () => {
	const report = assessBalance([meal("Mon", { protein: "fish" }), meal("Tue")], opts);
	expect(report.issues).toEqual(["Protein type not set for: Tue (needed to check the balance)"]);
});

test("low protein meals are flagged", () => {
	const report = assessBalance(
		[meal("Mon", { protein: "fish", nutrition: { kcal: 500, proteinG: 18 } })],
		{ requireProteins: [], minProteinG: 25 },
	);
	expect(report.issues).toEqual(["Under 25 g protein per portion: Mon"]);
});

test("nutrition summary averages the meals that have data", () => {
	const summary = summarizeNutrition([
		meal("Mon", { nutrition: { kcal: 600, proteinG: 40 } }),
		meal("Tue", { nutrition: { kcal: 500, proteinG: 31 } }),
		meal("Wed"),
	]);
	expect(summary.average).toEqual({ kcalPerPortion: 550, proteinPerPortionG: 35.5 });
	expect(summary.missing).toEqual(["Wed"]);
	expect(summarizeNutrition([meal("X")]).average).toBeNull();
});
