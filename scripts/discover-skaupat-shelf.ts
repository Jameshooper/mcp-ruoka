/**
 * Finds which S-Kaupat GraphQL operation returns the "Sijainti myymälässä" / "Hyllyväli" data.
 *
 * Usage: bun scripts/discover-skaupat-shelf.ts <product-page-url> [needle]
 * (open a product in a store on s-kaupat.fi and copy the URL; needle defaults to the shelf number you expect, e.g. 23)
 *
 * Requests are passed through unmodified so the real responses can be inspected.
 */
import { chromium } from "playwright";

const [url, needle] = process.argv.slice(2);
if (!url) {
	console.error("Usage: bun scripts/discover-skaupat-shelf.ts <product-page-url> [needle]");
	process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("response", async (res) => {
	if (!res.url().startsWith("https://api.s-kaupat.fi/")) return;
	const u = new URL(res.url());
	const body = await res.text().catch(() => "");
	const hit = /hyllyv|shelf|aisle|location/i.test(body) || (needle ? body.includes(needle) : false);
	console.log(`\n${hit ? "★" : " "} ${u.searchParams.get("operationName")}`);
	if (hit) {
		console.log("  variables:", u.searchParams.get("variables"));
		console.log("  extensions:", u.searchParams.get("extensions"));
		console.log("  response:", body.slice(0, 3000));
	}
});

await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
await browser.close();
