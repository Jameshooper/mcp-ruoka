/**
 * Usage: bun scripts/check-skaupat-location.ts <product-page-url> <ean> <storeId>
 * Prints the status and aisle/floor getProductLocation finds, to verify store selection end to end.
 */
import { getProductLocation } from "../src/browser/s-kaupat-location.ts";

const [url, ean, storeId] = process.argv.slice(2);
if (!url || !ean || !storeId) {
	console.error("Usage: bun scripts/check-skaupat-location.ts <url> <ean> <storeId>");
	process.exit(1);
}

console.log(await getProductLocation(url, ean, storeId));
process.exit(0);
