import type { Product } from "./types.ts";

export type QuantityUnit = "g" | "kg" | "ml" | "l" | "pcs";

export interface Quantity {
	amount: number;
	unit: QuantityUnit;
}

type Dimension = "mass" | "volume" | "count";

interface Base {
	dimension: Dimension;
	// kg for mass, litres for volume, pieces for count
	value: number;
}

export type CostResult =
	| { status: "ok"; packSize: string; packages: number; basketCost: number; usedCost: number }
	| { status: "unit_mismatch" | "no_price" };

// A pack counts as covering the need if it falls short by under 2%: unit prices are rounded
// to cents, so a 400 g can would otherwise look like 400.3 g and demand a second pack
const PACK_TOLERANCE = 0.02;

const UNIT_PRICE_RE = /^\s*(\d[\d\s]*(?:[.,]\d+)?)\s*€\s*\/\s*(\S+)\s*$/;

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export function parseUnitPrice(
	text: string | null | undefined,
): { perBase: number; dimension: Dimension } | null {
	const match = text ? UNIT_PRICE_RE.exec(text) : null;
	if (!match?.[1] || !match[2]) return null;

	const value = Number(match[1].replace(/\s/g, "").replace(",", "."));
	if (!Number.isFinite(value) || value <= 0) return null;

	switch (match[2].toLowerCase()) {
		case "kg":
			return { perBase: value, dimension: "mass" };
		case "g":
			return { perBase: value * 1000, dimension: "mass" };
		case "l":
		case "ltr":
			return { perBase: value, dimension: "volume" };
		case "ml":
			return { perBase: value * 1000, dimension: "volume" };
		case "kpl":
		case "kappale":
		case "pcs":
			return { perBase: value, dimension: "count" };
		default:
			return null;
	}
}

export function toBase(quantity: Quantity): Base {
	switch (quantity.unit) {
		case "g":
			return { dimension: "mass", value: quantity.amount / 1000 };
		case "kg":
			return { dimension: "mass", value: quantity.amount };
		case "ml":
			return { dimension: "volume", value: quantity.amount / 1000 };
		case "l":
			return { dimension: "volume", value: quantity.amount };
		case "pcs":
			return { dimension: "count", value: quantity.amount };
	}
}

function describePack(dimension: Dimension, size: number): string {
	switch (dimension) {
		case "mass":
			return size < 1 ? `${Math.round(size * 1000)} g` : `${round2(size)} kg`;
		case "volume":
			return size < 1 ? `${Math.round(size * 1000)} ml` : `${round2(size)} l`;
		case "count":
			return `${Math.round(size * 100) / 100} pcs`;
	}
}

// Pack size comes from price / unit price because product names carry it in inconsistent
// formats ("380/230 g", "4x28g", "0,5 l"). For canned goods the unit price is per drained
// weight, which is the usable amount anyway.
export function costProduct(
	product: Pick<Product, "price" | "unitPrice">,
	quantity: Quantity,
): CostResult {
	const unitPrice = parseUnitPrice(product.unitPrice);
	if (product.price == null || product.price <= 0 || !unitPrice) return { status: "no_price" };

	const need = toBase(quantity);
	if (need.dimension !== unitPrice.dimension) return { status: "unit_mismatch" };

	const packSize = product.price / unitPrice.perBase;
	const packages = Math.max(1, Math.ceil(need.value / packSize - PACK_TOLERANCE));

	return {
		status: "ok",
		packSize: describePack(need.dimension, packSize),
		packages,
		basketCost: round2(packages * product.price),
		usedCost: round2(need.value * unitPrice.perBase),
	};
}

export interface CostTotals {
	basketTotal: number;
	usedTotal: number;
	basketPerPerson?: number;
	usedPerPerson?: number;
}

export function sumCosts(
	picks: Array<Extract<CostResult, { status: "ok" }>>,
	servings: number | undefined,
): CostTotals {
	const basketTotal = round2(picks.reduce((sum, c) => sum + c.basketCost, 0));
	const usedTotal = round2(picks.reduce((sum, c) => sum + c.usedCost, 0));
	return {
		basketTotal,
		usedTotal,
		...(servings && {
			basketPerPerson: round2(basketTotal / servings),
			usedPerPerson: round2(usedTotal / servings),
		}),
	};
}
