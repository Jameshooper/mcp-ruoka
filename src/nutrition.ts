import type { Quantity } from "./costing.ts";

export interface Macros {
	kcal: number;
	proteinG: number;
	carbsG: number;
	fatG: number;
}

export interface Per100 extends Macros {
	// Whether the label values refer to 100 g or 100 ml
	basis: "g" | "ml";
}

const NUMBER = String.raw`(\d[\d\s ]*(?:[.,]\d+)?)`;
const KCAL_RE = new RegExp(`${NUMBER}\\s*kcal`, "i");
const KJ_RE = new RegExp(`${NUMBER}\\s*kj`, "i");
const GRAMS_RE = new RegExp(`^\\s*(<)?\\s*${NUMBER}\\s*g\\b`, "i");
const REFERENCE_RE = /^\s*100\s*(g|ml)\s*$/i;

function toNumber(text: string): number {
	return Number(text.replace(/[\s ]/g, "").replace(",", "."));
}

function parseKcal(value: string): number | null {
	const kcal = KCAL_RE.exec(value)?.[1];
	if (kcal) return toNumber(kcal);
	const kj = KJ_RE.exec(value)?.[1];
	return kj ? Math.round(toNumber(kj) / 4.184) : null;
}

// "<0,5 g" is a rounding statement; counting it as zero keeps totals from inflating
function parseGrams(value: string): number | null {
	const match = GRAMS_RE.exec(value);
	if (!match?.[2]) return null;
	return match[1] ? 0 : toNumber(match[2]);
}

// The store's rows are Finnish label rows ("Energia", "Rasvaa", "- josta sokereita", ...)
export function parseNutrients(
	rows: Array<{ name: string; value: string }>,
	referenceQuantity: string | null | undefined,
): Per100 | null {
	const reference = referenceQuantity ? REFERENCE_RE.exec(referenceQuantity) : null;
	if (!reference?.[1]) return null;

	let kcal: number | null = null;
	let protein: number | null = null;
	let carbs: number | null = null;
	let fat: number | null = null;

	for (const row of rows) {
		const name = row.name.trim().toLowerCase();
		if (name.startsWith("-")) continue;
		if (name.startsWith("energia")) kcal ??= parseKcal(row.value);
		else if (name.startsWith("proteiini")) protein ??= parseGrams(row.value);
		else if (name.startsWith("hiilihydraat")) carbs ??= parseGrams(row.value);
		else if (name.startsWith("rasva")) fat ??= parseGrams(row.value);
	}

	if (kcal === null || protein === null || carbs === null || fat === null) return null;
	return {
		kcal,
		proteinG: protein,
		carbsG: carbs,
		fatG: fat,
		basis: reference[1].toLowerCase() === "ml" ? "ml" : "g",
	};
}

// Grams (or millilitres) of the product used; pieces cannot be converted without a weight.
// Litres are treated as kilograms, which is close enough for water-based foods and a few
// percent off for oils.
export function quantityAmount(quantity: Quantity): { amount: number; basis: "g" | "ml" } | null {
	switch (quantity.unit) {
		case "g":
			return { amount: quantity.amount, basis: "g" };
		case "kg":
			return { amount: quantity.amount * 1000, basis: "g" };
		case "ml":
			return { amount: quantity.amount, basis: "ml" };
		case "l":
			return { amount: quantity.amount * 1000, basis: "ml" };
		case "pcs":
			return null;
	}
}

// A label per 100 ml applied to grams (or the reverse) assumes a density of 1
export function macrosFor(per100: Per100, amount: number): Macros {
	const factor = amount / 100;
	return {
		kcal: per100.kcal * factor,
		proteinG: per100.proteinG * factor,
		carbsG: per100.carbsG * factor,
		fatG: per100.fatG * factor,
	};
}

export function sumMacros(rows: Macros[]): Macros {
	return rows.reduce<Macros>(
		(total, r) => ({
			kcal: total.kcal + r.kcal,
			proteinG: total.proteinG + r.proteinG,
			carbsG: total.carbsG + r.carbsG,
			fatG: total.fatG + r.fatG,
		}),
		{ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
	);
}

export function roundMacros(m: Macros): Macros {
	return {
		kcal: Math.round(m.kcal),
		proteinG: Math.round(m.proteinG * 10) / 10,
		carbsG: Math.round(m.carbsG * 10) / 10,
		fatG: Math.round(m.fatG * 10) / 10,
	};
}
