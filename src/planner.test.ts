import { expect, test } from "bun:test";
import { choosePack, mergeIngredients } from "./planner.ts";
import type { Product } from "./types.ts";

const carrot = (name: string, price: number, unitPrice: string): Product => ({
	name,
	price,
	unitPrice,
	id: name,
	imageUrl: null,
	brand: null,
	category: null,
});

test("needs for the same ingredient are pooled across meals", () => {
	const { merged, unquantified } = mergeIngredients([
		{
			meal: "Mon",
			ingredients: [
				{ english: "carrots", finnish: ["porkkana"], quantity: { amount: 300, unit: "g" } },
				{ english: "salt", finnish: ["suola"] },
			],
		},
		{
			meal: "Wed",
			ingredients: [
				{ english: "Carrot", finnish: ["Porkkana"], quantity: { amount: 0.4, unit: "kg" } },
				{ english: "milk", finnish: ["maito"], quantity: { amount: 1, unit: "l" } },
			],
		},
	]);
	expect(merged).toHaveLength(2);
	expect(merged[0]?.need).toBeCloseTo(0.7);
	expect(merged[0]?.uses).toHaveLength(2);
	expect(unquantified).toEqual([{ meal: "Mon", ingredient: "salt" }]);
});

test("a shared pack beats buying per meal, and leftovers are measured", () => {
	const { merged } = mergeIngredients([
		{
			meal: "Mon",
			ingredients: [
				{ english: "carrots", finnish: ["porkkana"], quantity: { amount: 300, unit: "g" } },
			],
		},
		{
			meal: "Wed",
			ingredients: [
				{ english: "carrots", finnish: ["porkkana"], quantity: { amount: 400, unit: "g" } },
			],
		},
	]);
	const item = merged[0];
	if (!item) throw new Error("expected a merged ingredient");
	const options = [
		carrot("1 kg", 1.19, "1,19 €/kg"),
		carrot("500 g", 0.95, "1,90 €/kg"),
		carrot("750 g", 1.5, "2,00 €/kg"),
	];
	const cheapest = choosePack(options, item, "cheapest");
	expect(cheapest?.product.name).toBe("1 kg");
	expect(cheapest?.cost).toBe(1.19);
	expect(cheapest?.leftover).toBeCloseTo(0.3);
	// bought per meal the 1 kg bag is needed twice
	expect(cheapest?.separateCost).toBe(2.38);

	const wasteless = choosePack(options, item, "least_waste");
	expect(wasteless?.product.name).toBe("750 g");
	expect(wasteless?.leftoverValue).toBeCloseTo(0.1, 2);
});

test("incomparable units are skipped", () => {
	const { merged } = mergeIngredients([
		{
			meal: "Mon",
			ingredients: [{ english: "milk", finnish: ["maito"], quantity: { amount: 1, unit: "l" } }],
		},
	]);
	const item = merged[0];
	if (!item) throw new Error("expected a merged ingredient");
	expect(choosePack([carrot("per kg", 1, "2,00 €/kg")], item, "cheapest")).toBeNull();
});
