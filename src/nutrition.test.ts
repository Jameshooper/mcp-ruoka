import { expect, test } from "bun:test";
import { macrosFor, parseNutrients, quantityAmount, roundMacros, sumMacros } from "./nutrition.ts";

// Rows as the S-Kaupat product page lists them for a butter product
const BUTTER = [
	{ name: "Energia", value: "2 984 kJ / 713 kcal" },
	{ name: "Rasvaa", value: "80 g" },
	{ name: "- josta tyydyttyneitä rasvoja", value: "47 g" },
	{ name: "Hiilihydraattia", value: "0,8 g" },
	{ name: "- josta sokereita", value: "0,8 g" },
	{ name: "Proteiinia", value: "0,6 g" },
	{ name: "Suola", value: "1,40 g" },
];

test("parses the label rows and ignores the sub-rows", () => {
	expect(parseNutrients(BUTTER, "100 g")).toEqual({
		kcal: 713,
		fatG: 80,
		carbsG: 0.8,
		proteinG: 0.6,
		basis: "g",
	});
});

test("falls back to kJ, reads 'less than' as zero and accepts per 100 ml", () => {
	const rows = [
		{ name: "Energia", value: "418 kJ" },
		{ name: "Rasvaa", value: "<0,5 g" },
		{ name: "Hiilihydraattia", value: "10 g" },
		{ name: "Proteiinia", value: "3,4 g" },
	];
	const per100 = parseNutrients(rows, "100 ml");
	expect(per100?.kcal).toBe(100);
	expect(per100?.fatG).toBe(0);
	expect(per100?.basis).toBe("ml");
});

test("tables per portion or missing a macro are not used", () => {
	expect(parseNutrients(BUTTER, "1 annos (30 g)")).toBeNull();
	expect(
		parseNutrients(
			BUTTER.filter((r) => r.name !== "Proteiinia"),
			"100 g",
		),
	).toBeNull();
	expect(parseNutrients(BUTTER, null)).toBeNull();
});

test("scales per 100 g to the amount used and sums", () => {
	const per100 = parseNutrients(BUTTER, "100 g");
	if (!per100) throw new Error("expected a table");
	const amount = quantityAmount({ amount: 0.5, unit: "kg" });
	expect(amount).toEqual({ amount: 500, basis: "g" });
	const macros = roundMacros(macrosFor(per100, 500));
	expect(macros).toEqual({ kcal: 3565, proteinG: 3, carbsG: 4, fatG: 400 });
	expect(sumMacros([macros, macros]).kcal).toBe(7130);
	expect(quantityAmount({ amount: 3, unit: "pcs" })).toBeNull();
});
