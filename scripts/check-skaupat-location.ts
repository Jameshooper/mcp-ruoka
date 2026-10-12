/**
 * Usage: bun scripts/check-skaupat-location.ts <ean> <storeId>
 * Prints the status and aisle/floor getProductLocation finds for one product in one store.
 */
import { getProductLocation } from "../src/browser/s-kaupat-location.ts";

const [ean, storeId] = process.argv.slice(2);
if (!ean || !storeId) {
	console.error("Usage: bun scripts/check-skaupat-location.ts <ean> <storeId>");
	process.exit(1);
}

console.log(await getProductLocation(ean, storeId));
process.exit(0);
