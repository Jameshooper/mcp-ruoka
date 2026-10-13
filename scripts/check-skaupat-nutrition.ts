/**
 * Usage: bun scripts/check-skaupat-nutrition.ts <ean> <storeId>
 * Prints the per-100 g/ml nutrition getProductNutrition finds for one product in one store.
 */
import { getProductNutrition } from "../src/browser/s-kaupat-nutrition.ts";

const [ean, storeId] = process.argv.slice(2);
if (!ean || !storeId) {
	console.error("Usage: bun scripts/check-skaupat-nutrition.ts <ean> <storeId>");
	process.exit(1);
}

console.log(await getProductNutrition(ean, storeId));
process.exit(0);
