import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import * as z from "zod/v4";

// The recipe panel runs inside Home Assistant's own web origin, so script injected through a
// stored recipe would run with the user's Home Assistant session and could reach every device in
// the home. Every field that can come from Claude, a retailer or a backup is seeded with payloads
// and every screen is opened in a real browser.

const MARK = "__ruokaXss";
const ReportSchema = z.object({
	flagged: z.boolean(),
	handlers: z.array(z.string()),
	badLinks: z.array(z.string()),
	scripts: z.number(),
	iframes: z.number(),
});
const PAYLOADS = [
	`<img src=x onerror="window.${MARK}=1">`,
	`<script>window.${MARK}=1</script>`,
	`"><svg onload="window.${MARK}=1">`,
	`javascript:window.${MARK}=1`,
	`'><iframe src="javascript:parent.${MARK}=1">`,
	"‮gnp.exe",
];
const evil = (i: number) => `${PAYLOADS[i % PAYLOADS.length]} #${i}`;

// The browser that matches the installed Playwright, or a preinstalled one (CI images, sandboxes)
async function launchBrowser(): Promise<Browser | null> {
	try {
		return await chromium.launch();
	} catch {
		const fallback = process.env.RUOKA_TEST_CHROMIUM ?? "/opt/pw-browsers/chromium";
		if (!existsSync(fallback)) return null;
		return chromium.launch({ executablePath: fallback }).catch(() => null);
	}
}

const browser = await launchBrowser();
let dir = "";
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-xss-"));
	process.env.RUOKA_DATA_DIR = dir;
	const { saveRecipe, rateRecipe } = await import("./recipe-book.ts");
	const { savePlan, ratePlan } = await import("./plan-book.ts");
	const { rememberStores } = await import("./store-names.ts");
	const { createIngressFetch } = await import("./ui-server.ts");

	const saved = await saveRecipe({
		name: evil(0),
		servings: 2,
		tags: [evil(1).slice(0, 40), evil(2).slice(0, 40)],
		steps: [evil(3), evil(4), evil(5)],
		notes: evil(6),
		ingredients: [
			{ english: evil(7), finnish: [evil(8)], quantity: { amount: 100, unit: "g" } },
			{ english: evil(9), finnish: [evil(10)], pantry: true },
		],
		estimatedCost: {
			total: 2,
			perPortion: 1,
			chain: "s-kaupat",
			storeId: "1",
			storeName: evil(11),
			pricedAt: new Date().toISOString(),
		},
	});
	await rateRecipe(saved.recipe.id, 4, evil(12));
	await rememberStores([{ chain: "s-kaupat", id: "1", name: evil(13).slice(0, 120) }]);

	const line = (i: number) => ({
		ingredient: evil(i),
		needed: evil(i + 1),
		product: evil(i + 2),
		productId: `p${i}`,
		url: `javascript:window.${MARK}=1`,
		packSize: evil(i + 3),
		packages: 1,
		unitPrice: evil(i + 4),
		cost: 1,
		leftover: evil(i + 5),
		leftoverValue: 0.5,
		usedIn: [evil(i + 6)],
		location: { aisle: evil(i + 7), floor: 1 },
	});
	const plan = await savePlan(evil(20), {
		store: { chain: "s-kaupat", storeId: "1", name: evil(21) },
		budget: 30,
		meals: [
			{
				name: evil(22),
				dish: evil(23),
				servings: 2,
				steps: [evil(24)],
				cost: { total: 1, perPortion: 0.5, complete: true },
				ingredients: [
					{ english: evil(25), finnish: [evil(26)], quantity: { amount: 100, unit: "g" } },
				],
			},
		],
		toBuy: { total: 1, lines: [line(30)] },
		pantry: { total: 1, lines: [line(40)] },
		balance: { balanced: false, issues: [evil(50)], counts: {} },
		nutrition: { average: null, missing: [evil(51)] },
		missing: [{ ingredient: evil(52), reason: evil(53) }],
		unquantified: [],
		waste: { leftoverValue: 0.5 },
		pooling: { saved: 0 },
	});
	await ratePlan(plan.plan.id, 3, evil(54));

	const fetch = createIngressFetch(true);
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		development: false,
		fetch: (req, srv) => fetch(req, srv.requestIP(req)?.address),
	});
});

afterAll(async () => {
	server?.stop(true);
	await browser?.close();
	await rm(dir, { recursive: true, force: true });
});

// INP-01 (static half): the page builds its DOM with text nodes, never HTML strings
test("the page has no HTML-string sinks", async () => {
	const html = await readFile(join(import.meta.dirname, "ui", "index.html"), "utf8");
	for (const sink of [
		"innerHTML",
		"outerHTML",
		"insertAdjacentHTML",
		"document.write",
		"eval(",
		"new Function",
	]) {
		expect(html.includes(sink)).toBe(false);
	}
});

// INP-01 (dynamic half)
test.skipIf(!browser)(
	"stored content never runs as script on any screen",
	async () => {
		if (!browser || !server) throw new Error("browser or server missing");
		const page = await browser.newPage();
		const dialogs: string[] = [];
		page.on("dialog", async (dialog) => {
			dialogs.push(dialog.message());
			await dialog.dismiss();
		});
		const base = `http://127.0.0.1:${server.port}/`;

		const check = async (screen: string) => {
			await page.waitForTimeout(150);
			// Runs in the page; written as a string because this project's TypeScript has no DOM types
			const report = ReportSchema.parse(
				await page.evaluate(`(() => {
					const handlers = [];
					const badLinks = [];
					for (const node of document.querySelectorAll("*")) {
						for (const attr of node.getAttributeNames()) {
							if (attr.toLowerCase().startsWith("on")) handlers.push(node.tagName + "@" + attr);
						}
						const href = node.getAttribute("href") ?? node.getAttribute("src");
						if (href && /^\\s*(javascript|data|vbscript):/i.test(href)) badLinks.push(href);
					}
					return {
						flagged: window[${JSON.stringify(MARK)}] !== undefined,
						handlers,
						badLinks,
						scripts: document.querySelectorAll("script").length,
						iframes: document.querySelectorAll("iframe").length,
					};
				})()`),
			);
			expect({ screen, ...report }).toEqual({
				screen,
				flagged: false,
				handlers: [],
				badLinks: [],
				scripts: 1,
				iframes: 0,
			});
		};

		await page.goto(base);
		await page.waitForSelector("#grid .card");
		await check("recipe list");
		expect(await page.textContent("#grid")).toContain("<img src=x");

		await page.click("#grid .card");
		await page.waitForSelector("#detail-view:not(.hidden)");
		await check("recipe detail");
		// every Claude button points at claude.ai with the text encoded
		for (const href of await page.$$eval("a[target=_blank]", (as) =>
			as.map((a) => a.getAttribute("href") ?? ""),
		)) {
			expect(href.startsWith("https://claude.ai/new?q=")).toBe(true);
		}

		await page.click("#tab-plans");
		await page.waitForSelector("#plan-grid .card");
		await check("plan list");
		await page.click("#plan-grid .card");
		await page.waitForSelector("#plan-detail-view:not(.hidden)");
		await check("plan detail");

		// the backup button lives on the list screen's header
		await page.goto(base);
		await page.waitForSelector("#grid .card");
		await page.click("#backup-open");
		await page.waitForSelector("#backup-view:not(.hidden)");
		await check("backup screen");

		expect(dialogs).toEqual([]);
		await page.close();
	},
	30_000,
);
