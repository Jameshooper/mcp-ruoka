/**
 * Usage: bun scripts/make-icons.ts
 * Renders src/ui/icons/icon.svg to the PNG sizes the home-screen app needs.
 */
import { join } from "node:path";
import { chromium } from "playwright";

const dir = join(import.meta.dirname, "..", "src", "ui", "icons");
const svg = await Bun.file(join(dir, "icon.svg")).text();
const sizes: Array<[string, number]> = [
	["apple-touch-icon.png", 180],
	["icon-192.png", 192],
	["icon-512.png", 512],
];

// CHROMIUM_PATH points at an existing Chromium when Playwright's own download is not installed
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
for (const [name, size] of sizes) {
	const page = await browser.newPage({ viewport: { width: size, height: size } });
	await page.setContent(
		`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
	);
	await page.screenshot({ path: join(dir, name) });
	await page.close();
}
await browser.close();
process.exit(0);
