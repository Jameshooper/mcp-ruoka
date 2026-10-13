import {
	type CostResult,
	costProduct,
	type Dimension,
	describePack,
	packSizeBase,
	type Quantity,
	toBase,
} from "./costing.ts";
import type { Ingredient } from "./schemas.ts";
import type { Product } from "./types.ts";

export interface MealIngredients {
	meal: string;
	ingredients: Ingredient[];
}

export interface MergedUse {
	meal: string;
	quantity: Quantity;
}

export interface MergedIngredient {
	key: string;
	english: string;
	finnish: string[];
	pantry: boolean;
	dimension: Dimension;
	// kg for mass, litres for volume, pieces for count
	need: number;
	uses: MergedUse[];
}

const BASE_UNIT = { mass: "kg", volume: "l", count: "pcs" } as const;

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export function baseQuantity(dimension: Dimension, value: number): Quantity {
	return { amount: Math.round(value * 10_000) / 10_000, unit: BASE_UNIT[dimension] };
}

export function mergeKey(ingredient: Ingredient, dimension: Dimension): string {
	const term = ingredient.finnish[0]?.trim().toLowerCase() ?? ingredient.english.toLowerCase();
	return `${term}|${dimension}`;
}

// One shopping line per ingredient: needs from every meal are pooled so that a single pack can
// serve several meals, which is how leftovers get used rather than thrown away
export function mergeIngredients(meals: MealIngredients[]): {
	merged: MergedIngredient[];
	unquantified: Array<{ meal: string; ingredient: string }>;
} {
	const byKey = new Map<string, MergedIngredient>();
	const unquantified: Array<{ meal: string; ingredient: string }> = [];

	for (const { meal, ingredients } of meals) {
		for (const ingredient of ingredients) {
			if (!ingredient.quantity) {
				unquantified.push({ meal, ingredient: ingredient.english });
				continue;
			}
			const base = toBase(ingredient.quantity);
			const key = mergeKey(ingredient, base.dimension);
			const existing = byKey.get(key);
			if (existing) {
				existing.need += base.value;
				existing.pantry = existing.pantry && ingredient.pantry === true;
				existing.uses.push({ meal, quantity: ingredient.quantity });
			} else {
				byKey.set(key, {
					key,
					english: ingredient.english,
					finnish: ingredient.finnish,
					pantry: ingredient.pantry === true,
					dimension: base.dimension,
					need: base.value,
					uses: [{ meal, quantity: ingredient.quantity }],
				});
			}
		}
	}
	return { merged: [...byKey.values()], unquantified };
}

export type Preference = "cheapest" | "least_waste";

export interface PackChoice {
	product: Product;
	packSize: string;
	packages: number;
	cost: number;
	leftover: number;
	leftoverValue: number;
	// What the same product would cost if each meal bought its own packs
	separateCost: number;
}

type OkCost = Extract<CostResult, { status: "ok" }>;

function isOk(cost: CostResult): cost is OkCost {
	return cost.status === "ok";
}

// Candidates must already be filtered for allergens
export function choosePack(
	candidates: Product[],
	item: MergedIngredient,
	preference: Preference,
): PackChoice | null {
	const need = baseQuantity(item.dimension, item.need);
	let best: PackChoice | null = null;

	for (const product of candidates) {
		const cost = costProduct(product, need);
		const size = packSizeBase(product);
		if (!isOk(cost) || !size || size.dimension !== item.dimension) continue;

		const leftover = Math.max(cost.packages * size.size - item.need, 0);
		const separateCost = item.uses.reduce((sum, use) => {
			const own = costProduct(product, use.quantity);
			return sum + (isOk(own) ? own.basketCost : 0);
		}, 0);
		const choice: PackChoice = {
			product,
			packSize: cost.packSize,
			packages: cost.packages,
			cost: cost.basketCost,
			leftover,
			leftoverValue: round2(leftover * size.perBase),
			separateCost: round2(separateCost),
		};

		const better =
			!best ||
			(preference === "least_waste"
				? choice.leftoverValue < best.leftoverValue ||
					(choice.leftoverValue === best.leftoverValue && choice.cost < best.cost)
				: choice.cost < best.cost ||
					(choice.cost === best.cost && choice.leftoverValue < best.leftoverValue));
		if (better) best = choice;
	}
	return best;
}

export function formatAmount(dimension: Dimension, value: number): string {
	return describePack(dimension, value);
}
