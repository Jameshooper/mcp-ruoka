import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { RecipeInput } from "./recipe-book.ts";
import type { Ingredient } from "./schemas.ts";
import { launchTestBrowser } from "./test-browser.ts";

// The recipe screens as you use them: a real browser against the real UI server and data files,
// with each test starting from its own freshly seeded data folder.

const browser = await launchTestBrowser();
let dir = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let page: Page | null = null;
let base = "";

const recipe = (
	name: string,
	extra: Partial<RecipeInput>,
	ingredients: Ingredient[] = [
		{ english: "rice", finnish: ["riisi"], quantity: { amount: 400, unit: "g" } },
	],
): RecipeInput => ({ name, servings: 4, steps: ["Cook it"], tags: [], ingredients, ...extra });

const line = (productId: string, product: string, aisle: string, cost: number) => ({
	ingredient: product.toLowerCase(),
	needed: "200 g",
	product,
	productId,
	url: null,
	packSize: "1 kg",
	packages: 1,
	unitPrice: "2,00 €/kg",
	cost,
	leftover: "800 g",
	leftoverValue: 1,
	usedIn: ["Mon: 200 g"],
	location: { aisle, floor: 1 },
});

async function seed(): Promise<void> {
	const { saveRecipe, rateRecipe } = await import("./recipe-book.ts");
	const { savePlan } = await import("./plan-book.ts");
	await saveRecipe(
		recipe(
			"Kanacurry",
			{ protein: "white_meat", tags: ["dinner"], prepMinutes: 10, cookMinutes: 30 },
			[{ english: "chicken", finnish: ["broileri"], quantity: { amount: 400, unit: "g" } }],
		),
	);
	await rateRecipe("kanacurry", 5);
	await saveRecipe(
		recipe("Lohikeitto", { protein: "fish", tags: ["soup"], prepMinutes: 15, cookMinutes: 20 }, [
			{ english: "salmon", finnish: ["lohi"], quantity: { amount: 300, unit: "g" } },
		]),
	);
	await rateRecipe("lohikeitto", 3);
	await saveRecipe(
		recipe("Linssipata", {
			protein: "vegetarian",
			tags: ["dinner", "vegan"],
			prepMinutes: 5,
			cookMinutes: 60,
		}),
	);
	await savePlan("Family plan 4-12 Nov", {
		store: { chain: "s-kaupat", storeId: "613756972", name: "Prisma Linnainmaa" },
		budget: 30,
		meals: [
			{
				name: "Wed dinner",
				dish: "Rice bowl",
				servings: 5,
				steps: ["Cook rice", "Serve"],
				cost: { total: 4, perPortion: 0.8, complete: true },
				protein: "vegetarian",
				vegetables: true,
				ingredients: [
					{ english: "rice", finnish: ["riisi"], quantity: { amount: 500, unit: "g" } },
				],
			},
		],
		toBuy: {
			total: 5,
			lines: [line("211", "Rice 1 kg", "45", 2.5), line("311", "Carrots 1 kg", "12", 2.5)],
		},
		pantry: { total: 1, lines: [line("411", "Salt 1 kg", "60", 1)] },
		balance: { balanced: true, issues: [], counts: { vegetarian: 1 } },
		nutrition: { average: null, missing: ["Wed dinner"] },
		missing: [],
		unquantified: [],
		waste: { leftoverValue: 1 },
		pooling: { saved: 0 },
	});
}

const apiJson = async (path: string): Promise<unknown> => (await fetch(`${base}${path}`)).json();

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-flows-"));
	process.env.RUOKA_DATA_DIR = dir;
	process.env.RUOKA_DEFAULT_STORE_ID = "613756972";
	process.env.RUOKA_DEFAULT_STORE_NAME = "Prisma Linnainmaa";
	process.env.RUOKA_CLAUDE_NOTE = "Always pass avoidAllergens for cashew.";
	await seed();
	if (!server) {
		const { createIngressFetch } = await import("./ui-server.ts");
		const handle = createIngressFetch(true);
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			development: false,
			fetch: (req, srv) => handle(req, srv.requestIP(req)?.address),
		});
		base = `http://127.0.0.1:${server.port}/`;
	}
	if (browser) {
		page = await browser.newPage({ acceptDownloads: true });
		// Nothing on these screens may reach the internet; the Claude buttons are only read
		await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
		await page.goto(base);
		await page.waitForSelector("#grid .card");
	}
});

afterEach(async () => {
	await page?.close();
	page = null;
	await rm(dir, { recursive: true, force: true });
	for (const key of ["RUOKA_DEFAULT_STORE_ID", "RUOKA_DEFAULT_STORE_NAME", "RUOKA_CLAUDE_NOTE"]) {
		delete process.env[key];
	}
});

afterAll(async () => {
	server?.stop(true);
	await browser?.close();
});

function current(): Page {
	if (!page) throw new Error("no page");
	return page;
}

const cardNames = async () =>
	current().$$eval("#grid .card h2", (els) => els.map((e) => e.textContent ?? ""));
const decodedHref = async (selector: string) =>
	decodeURIComponent(
		new URL((await current().getAttribute(selector, "href")) ?? "").searchParams.get("q") ?? "",
	);

const browserTest = test.skipIf(!browser);
const TIMEOUT = 30_000;

browserTest(
	"the recipe list searches, filters and sorts",
	async () => {
		const p = current();
		expect(await cardNames()).toEqual(["Kanacurry", "Lohikeitto", "Linssipata"]);
		expect(await p.textContent("#subtitle")).toBe("3 recipes");

		await p.fill("#search", "salmon");
		expect(await cardNames()).toEqual(["Lohikeitto"]);
		await p.fill("#search", "broileri dinner");
		expect(await cardNames()).toEqual(["Kanacurry"]);
		await p.fill("#search", "nothing like this");
		expect(await cardNames()).toEqual([]);
		expect(await p.textContent("#empty")).toBe("No recipes match.");
		await p.fill("#search", "");

		await p.selectOption("#tag", "vegan");
		expect(await cardNames()).toEqual(["Linssipata"]);
		await p.selectOption("#tag", "");
		await p.selectOption("#protein", "fish");
		expect(await cardNames()).toEqual(["Lohikeitto"]);
		await p.selectOption("#protein", "");

		await p.selectOption("#sort", "name");
		expect(await cardNames()).toEqual(["Kanacurry", "Linssipata", "Lohikeitto"]);
		await p.selectOption("#sort", "quick");
		expect(await cardNames()).toEqual(["Lohikeitto", "Kanacurry", "Linssipata"]);
	},
	TIMEOUT,
);

browserTest(
	"a recipe scales with the servings stepper, and its rating and review are saved",
	async () => {
		const p = current();
		await p.click("#grid .card:has-text('Kanacurry')");
		await p.waitForSelector("#detail-view:not(.hidden)");
		const quantity = () => p.textContent("#detail-view .ing .qty");
		expect(await quantity()).toBe("400 g");

		await p.click("button[aria-label='More servings']");
		expect(await quantity()).toBe("500 g");
		await p.fill("#detail-view input[aria-label='Servings']", "8");
		expect(await quantity()).toBe("800 g");
		await p.click("button[aria-label='Fewer servings']");
		expect(await quantity()).toBe("700 g");

		await p.click("#detail-view .stars button[title='4 stars']");
		await p.waitForSelector("#detail-view .meta:text('Saved')");
		await p.fill("#detail-view textarea", "Needs more chilli");
		// the review button must keep the rating just chosen, not the one the screen opened with
		await p.click("text=Save review");
		await p.waitForTimeout(200);
		expect(await apiJson("api/recipes/kanacurry")).toMatchObject({
			rating: 4,
			review: "Needs more chilli",
		});

		// clicking the current rating again clears it
		await p.click("#detail-view .stars button[title='4 stars']");
		await p.waitForTimeout(200);
		expect(await apiJson("api/recipes/kanacurry")).not.toHaveProperty("rating");
	},
	TIMEOUT,
);

browserTest(
	"deleting a recipe asks first, and only a yes removes it",
	async () => {
		const p = current();
		await p.click("#grid .card:has-text('Lohikeitto')");
		await p.waitForSelector("#detail-view:not(.hidden)");

		p.once("dialog", (dialog) => dialog.dismiss());
		await p.click("text=Delete recipe");
		await p.waitForTimeout(200);
		expect((await fetch(`${base}api/recipes/lohikeitto`)).status).toBe(200);

		const asked: string[] = [];
		p.once("dialog", (dialog) => {
			asked.push(dialog.message());
			void dialog.accept();
		});
		await p.click("text=Delete recipe");
		await p.waitForSelector("#list-view:not(.hidden)");
		expect(asked[0]).toContain('Delete "Lohikeitto"?');
		expect(await cardNames()).toEqual(["Kanacurry", "Linssipata"]);
		expect((await fetch(`${base}api/recipes/lohikeitto`)).status).toBe(404);
	},
	TIMEOUT,
);

browserTest(
	"a plan's shopping list is grouped by aisle and ticks survive a reload",
	async () => {
		const p = current();
		await p.click("#tab-plans");
		await p.waitForSelector("#plan-grid .card");
		expect(await p.textContent("#plan-grid .card")).toContain("Within budget");
		await p.click("#plan-grid .card");
		await p.waitForSelector("#plan-detail-view:not(.hidden)");

		// lowest aisle first
		const aisles = await p.$$eval("#plan-detail-view .aisle .badge", (els) =>
			els.map((e) => e.textContent),
		);
		expect(aisles).toEqual(["12", "45", "60"]);
		expect(await p.textContent("#plan-detail-view")).toContain("0 of 3 ticked");

		await p.check("#plan-detail-view label.line:has-text('Rice 1 kg') input");
		expect(await p.textContent("#plan-detail-view")).toContain("1 of 3 ticked");
		await p.waitForTimeout(200);
		expect(await apiJson("api/plans/family-plan-4-12-nov")).toMatchObject({ checked: ["211"] });

		await p.reload();
		await p.click("#tab-plans");
		await p.click("#plan-grid .card");
		expect(await p.isChecked("#plan-detail-view label.line:has-text('Rice 1 kg') input")).toBe(
			true,
		);
		expect(await p.isChecked("#plan-detail-view label.line:has-text('Carrots 1 kg') input")).toBe(
			false,
		);

		await p.uncheck("#plan-detail-view label.line:has-text('Rice 1 kg') input");
		await p.waitForTimeout(200);
		expect(await apiJson("api/plans/family-plan-4-12-nov")).toMatchObject({ checked: [] });
	},
	TIMEOUT,
);

browserTest(
	"a plan meal can be saved to the recipes, and then links to it",
	async () => {
		const p = current();
		await p.click("#tab-plans");
		await p.click("#plan-grid .card");
		await p.waitForSelector("#plan-detail-view:not(.hidden)");

		const messages: string[] = [];
		p.on("dialog", (dialog) => {
			messages.push(dialog.message());
			void (dialog.type() === "prompt" ? dialog.accept("Rice bowl special") : dialog.accept());
		});
		await p.click("text=Save to recipes");
		await p.waitForSelector("#plan-detail-view button:has-text('View recipe')");
		expect(messages).toEqual([
			"Save as a recipe named:",
			'Saved "Rice bowl special" to the Recipes tab.',
		]);
		expect(await apiJson("api/recipes/rice-bowl-special")).toMatchObject({
			servings: 5,
			steps: ["Cook rice", "Serve"],
		});

		await p.click("#plan-detail-view button:has-text('View recipe')");
		await p.waitForSelector("#detail-view:not(.hidden)");
		expect(await p.textContent("#detail-view h2")).toBe("Rice bowl special");
	},
	TIMEOUT,
);

browserTest(
	"a plan can be rated and deleted",
	async () => {
		const p = current();
		await p.click("#tab-plans");
		await p.click("#plan-grid .card");
		await p.waitForSelector("#plan-detail-view:not(.hidden)");
		await p.click("#plan-detail-view .stars button[title='5 stars']");
		await p.waitForTimeout(200);
		expect(await apiJson("api/plans/family-plan-4-12-nov")).toMatchObject({ rating: 5 });
		await p.click("#plan-detail-view .stars button[title='3 stars']");
		await p.waitForTimeout(200);
		await p.fill("#plan-detail-view textarea", "Too much rice");
		await p.click("#plan-detail-view button:has-text('Save review')");
		await p.waitForTimeout(200);
		expect(await apiJson("api/plans/family-plan-4-12-nov")).toMatchObject({
			rating: 3,
			review: "Too much rice",
		});

		p.once("dialog", (dialog) => dialog.accept());
		await p.click("#plan-detail-view button:has-text('Delete')");
		await p.waitForSelector("#plans-view:not(.hidden)");
		expect(await p.textContent("#plan-empty")).toContain("No meal plans saved yet");
		expect((await fetch(`${base}api/plans/family-plan-4-12-nov`)).status).toBe(404);
	},
	TIMEOUT,
);

browserTest(
	"backup exports a zip and imports one after a preview",
	async () => {
		const p = current();
		await p.click("#backup-open");
		await p.waitForSelector("#backup-view:not(.hidden)");
		expect(await p.textContent("#backup-view")).toContain("3 recipes · 1 meal plans");

		const [download] = await Promise.all([
			p.waitForEvent("download"),
			p.click("text=Export to zip"),
		]);
		const saved = join(dir, "export.zip");
		await download.saveAs(saved);
		const { unzipFiles } = await import("./zip.ts");
		const files = unzipFiles(new Uint8Array(await readFile(saved)));
		expect(JSON.parse(new TextDecoder().decode(files.get("recipes.json"))).recipes).toHaveLength(3);

		// a backup from elsewhere, with one recipe this book does not have
		const { zipFiles } = await import("./zip.ts");
		const now = new Date().toISOString();
		const incoming = zipFiles([
			{
				name: "recipes.json",
				data: new TextEncoder().encode(
					JSON.stringify({
						recipes: [
							{
								...recipe("Pinaattiletut", {}),
								id: "pinaattiletut",
								createdAt: now,
								updatedAt: now,
							},
						],
					}),
				),
			},
		]);
		const file = join(dir, "incoming.zip");
		await writeFile(file, incoming);
		await p.setInputFiles("#backup-view input[type=file]", file);
		await p.waitForSelector("#backup-view :text('1 recipes (1 new, 0 already here)')");
		await p.click("#backup-view button:has-text('Import')");
		await p.waitForSelector("#backup-view .result.ok");
		expect(await p.textContent("#backup-view .result.ok")).toContain(
			"Recipes: 1 added, 0 updated, 0 kept as they were",
		);
		expect(await apiJson("api/recipes/pinaattiletut")).toMatchObject({ name: "Pinaattiletut" });
		// the safety copy taken before the import shows up in the saved backups list
		await p.reload();
		await p.click("#backup-open");
		await p.waitForSelector("#backup-view :text('Before import')");
	},
	TIMEOUT,
);

browserTest(
	"the Claude buttons carry the recipe, the store, the house rules and the note",
	async () => {
		const p = current();
		await p.click("#grid .card:has-text('Kanacurry')");
		await p.waitForSelector("#detail-view:not(.hidden)");
		const cook = await decodedHref("#detail-view a:has-text('Cook with Claude')");
		expect(cook).toContain('Cook with me: "Kanacurry" for 4 people');
		const shop = await decodedHref("#detail-view a:has-text('Shop with Claude')");
		expect(shop).toContain(
			'storeId 613756972, storeName "Prisma Linnainmaa", includeLocation: true',
		);
		for (const text of [cook, shop]) {
			expect(text).toContain("Never choose Xtra own-brand products.");
			expect(text).toContain("Always pass avoidAllergens for cashew.");
		}

		await p.click("#tab-plans");
		await p.waitForSelector("#plan-starter a");
		const family = await decodedHref("#plan-starter a");
		expect(family).toContain("First ask me two quick questions");
		expect(family).toMatch(/66 portions in total/);
		expect(family).toContain("Never choose Xtra own-brand products.");
	},
	TIMEOUT,
);
