import type { Protein } from "./schemas.ts";

export interface MealNutrition {
	kcal: number;
	proteinG: number;
}

export interface PlannedMeal {
	name: string;
	servings: number;
	protein?: Protein;
	vegetables?: boolean;
	nutrition?: MealNutrition;
}

export interface BalanceOptions {
	requireProteins: Protein[];
	maxRedMeatMeals?: number;
	minProteinG?: number;
}

export interface BalanceReport {
	balanced: boolean;
	counts: Record<Protein, number>;
	issues: string[];
}

function names(meals: PlannedMeal[]): string {
	return meals.map((m) => m.name).join(", ");
}

const LABEL: Record<Protein, string> = {
	white_meat: "white meat",
	red_meat: "red meat",
	fish: "fish",
	vegetarian: "vegetarian",
	other: "other",
};

export function assessBalance(meals: PlannedMeal[], options: BalanceOptions): BalanceReport {
	const counts: Record<Protein, number> = {
		white_meat: 0,
		red_meat: 0,
		fish: 0,
		vegetarian: 0,
		other: 0,
	};
	for (const meal of meals) if (meal.protein) counts[meal.protein]++;

	const issues: string[] = [];

	const untagged = meals.filter((m) => !m.protein);
	if (untagged.length > 0) {
		issues.push(`Protein type not set for: ${names(untagged)} (needed to check the balance)`);
	}

	// A plan with fewer meals than categories cannot cover them all, so it is not penalised
	if (meals.length >= options.requireProteins.length) {
		for (const category of options.requireProteins) {
			if (counts[category] === 0) issues.push(`No ${LABEL[category]} meal in the plan`);
		}
	}

	const { maxRedMeatMeals } = options;
	if (maxRedMeatMeals !== undefined && counts.red_meat > maxRedMeatMeals) {
		issues.push(
			`${counts.red_meat} red meat meals; keep it to ${maxRedMeatMeals} or fewer (health guidance suggests limiting red meat)`,
		);
	}

	const noVegetables = meals.filter((m) => m.vegetables !== true);
	if (noVegetables.length > 0) {
		issues.push(
			`No vegetables or salad marked for: ${names(noVegetables)}. Add a vegetable side or salad (and include it in the ingredients)`,
		);
	}

	if (options.minProteinG !== undefined) {
		const low = meals.filter(
			(m) => m.nutrition && m.nutrition.proteinG < (options.minProteinG ?? 0),
		);
		if (low.length > 0) {
			issues.push(`Under ${options.minProteinG} g protein per portion: ${names(low)}`);
		}
	}

	return { balanced: issues.length === 0, counts, issues };
}

export interface NutritionSummary {
	perMeal: Array<{ meal: string; kcalPerPortion: number; proteinPerPortionG: number }>;
	average: { kcalPerPortion: number; proteinPerPortionG: number } | null;
	missing: string[];
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

export function summarizeNutrition(meals: PlannedMeal[]): NutritionSummary {
	const withData = meals.flatMap((m) =>
		m.nutrition
			? [
					{
						meal: m.name,
						kcalPerPortion: m.nutrition.kcal,
						proteinPerPortionG: m.nutrition.proteinG,
					},
				]
			: [],
	);
	const mean = (pick: (row: (typeof withData)[number]) => number) =>
		withData.reduce((sum, row) => sum + pick(row), 0) / withData.length;
	return {
		perMeal: withData,
		average:
			withData.length > 0
				? {
						kcalPerPortion: Math.round(mean((r) => r.kcalPerPortion)),
						proteinPerPortionG: round1(mean((r) => r.proteinPerPortionG)),
					}
				: null,
		missing: meals.filter((m) => !m.nutrition).map((m) => m.name),
	};
}
