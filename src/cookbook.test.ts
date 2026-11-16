import { expect, test } from "bun:test";
import { buildCookbook, buildRecipeBook, escapeXml, formatQuantity } from "./cookbook.ts";
import type { MealPlan } from "./plan-book.ts";
import type { Recipe } from "./recipe-book.ts";
import { unzipFiles } from "./zip.ts";

const DECODER = new TextDecoder();

function recipe(id: string, name: string, extra: Partial<Recipe> = {}): Recipe {
	return {
		id,
		name,
		servings: 4,
		ingredients: [
			{ english: "salmon fillet", finnish: ["lohi"], quantity: { amount: 1200, unit: "g" } },
			{ english: "salt", finnish: ["suola"], pantry: true, quantity: { amount: 10, unit: "g" } },
		],
		steps: ["Cook it", "Serve it"],
		tags: ["dinner"],
		protein: "fish",
		createdAt: "2026-11-01T10:00:00.000Z",
		updatedAt: "2026-11-01T10:00:00.000Z",
		...extra,
	};
}

function plan(meals: MealPlan["meals"], lines: MealPlan["toBuy"]["lines"] = []): MealPlan {
	const empty = { total: 0, lines: [] };
	return {
		id: "family",
		name: "Family plan",
		createdAt: "2026-11-15T10:00:00.000Z",
		updatedAt: "2026-11-15T10:00:00.000Z",
		checked: ["ticked"],
		store: { chain: "s-kaupat", storeId: "1", name: "Prisma" },
		meals,
		toBuy: { total: 12.5, lines },
		pantry: empty,
		balance: { balanced: true, issues: [], counts: {} },
		nutrition: { average: null, missing: [] },
		missing: [],
		unquantified: [],
		waste: { leftoverValue: 0 },
		pooling: { saved: 0 },
	};
}

function line(
	ingredient: string,
	productId: string,
	aisle: string | null,
): MealPlan["toBuy"]["lines"][number] {
	return {
		ingredient,
		needed: "400 g",
		product: `${ingredient} pack`,
		productId,
		url: null,
		packSize: "400 g",
		packages: 1,
		unitPrice: null,
		cost: 1,
		leftover: "0 g",
		leftoverValue: 0,
		usedIn: [],
		location: aisle === null ? null : { aisle, floor: 1 },
	};
}

function read(bytes: Uint8Array): Map<string, string> {
	const files = unzipFiles(bytes, { maxEntries: 500, maxTotalBytes: 10_000_000 });
	return new Map([...files].map(([name, data]) => [name, DECODER.decode(data)]));
}

const today = new Date(2026, 10, 16, 12, 0);

test("formats quantities the way a cook reads them", () => {
	expect(formatQuantity({ amount: 1200, unit: "g" })).toBe("1.2 kg");
	expect(formatQuantity({ amount: 600, unit: "ml" })).toBe("600 ml");
	expect(formatQuantity({ amount: 2, unit: "pcs" })).toBe("2 ×");
	expect(formatQuantity({ amount: 0.5, unit: "g" })).toBe("0.5 g");
	expect(formatQuantity(undefined)).toBe("");
	expect(escapeXml(`<b>"Tom" & 'Jerry'</b>`)).toBe(
		"&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;",
	);
});

test("builds a valid EPUB: mimetype first and uncompressed, every link resolves", () => {
	const bytes = buildCookbook(
		[
			recipe("salmon-soup", "Salmon soup"),
			recipe("chili", "Bean chili", { protein: "vegetarian" }),
			recipe("eggs-benedict", "Eggs Benedict", { protein: "red_meat", tags: ["brunch"] }),
		],
		[],
		today,
	);
	// The OCF spec: "mimetype" is the first entry, stored, so readers can sniff the type at offset 38
	expect(DECODER.decode(bytes.subarray(30, 38))).toBe("mimetype");
	expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true)).toBe(0);
	expect(DECODER.decode(bytes.subarray(38, 58))).toBe("application/epub+zip");

	const files = read(bytes);
	expect(files.get("META-INF/container.xml")).toContain("OEBPS/content.opf");
	for (const [name, text] of files) {
		if (!name.endsWith(".xhtml") && !name.endsWith(".ncx")) continue;
		for (const [, href] of text.matchAll(/(?:href|src)="([^"#]+\.xhtml)/g)) {
			expect(files.has(`OEBPS/${href}`)).toBe(true);
		}
	}
	const contents = files.get("OEBPS/contents.xhtml") ?? "";
	expect(contents.indexOf("<h2>Fish</h2>")).toBeLessThan(contents.indexOf("<h2>Vegetarian</h2>"));
	expect(contents).toContain("<h2>Brunch and weekend</h2>");
	expect(contents).toContain("Eggs Benedict");
});

// KOReader uses the cover as the Kindle's sleep screen, found through the package metadata
test("the cookbook has a cover image; a single recipe book does not", () => {
	const files = unzipFiles(buildCookbook([recipe("chili", "Bean chili")], [], today));
	const opf = DECODER.decode(files.get("OEBPS/content.opf"));
	expect(opf).toContain(
		'<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>',
	);
	expect(opf).toContain('<meta name="cover" content="cover-image"/>');
	const png = files.get("OEBPS/cover.png") ?? new Uint8Array();
	expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
	// The Paperwhite's screen: width and height are big-endian at bytes 16 and 20 of the PNG header
	const header = new DataView(png.buffer, png.byteOffset);
	expect([header.getUint32(16), header.getUint32(20)]).toEqual([1072, 1448]);

	const single = unzipFiles(buildRecipeBook(recipe("chili", "Bean chili")));
	expect(single.has("OEBPS/cover.png")).toBe(false);
	expect(DECODER.decode(single.get("OEBPS/content.opf"))).not.toContain("cover-image");
});

test("a recipe page splits what to buy from cupboard staples and escapes text", () => {
	const files = read(
		buildCookbook([recipe("x", "Fish & <chips>", { notes: "Use the Meira oregano" })], [], today),
	);
	const page = files.get("OEBPS/r-x.xhtml") ?? "";
	expect(page).toContain("<h1>Fish &amp; &lt;chips&gt;</h1>");
	expect(page).toContain("1.2 kg");
	expect(page.indexOf("salmon fillet")).toBeLessThan(page.indexOf("From the cupboard"));
	expect(page.indexOf("From the cupboard")).toBeLessThan(page.indexOf(">salt<"));
	expect(page).toContain("Use the Meira oregano");
});

test("this week: dinners link to recipes, unsaved planned meals get pages, ticked items are left out", () => {
	const files = read(
		buildCookbook(
			[recipe("salmon-soup", "Salmon soup")],
			[
				plan(
					[
						{
							name: "Mon dinner",
							dish: "Salmon soup",
							date: "2026-11-16",
							recipe: "salmon-soup",
							servings: 4,
							ingredients: [],
							steps: [],
						},
						{
							name: "Tue dinner",
							dish: "Teriyaki stir-fry",
							date: "2026-11-17",
							servings: 2,
							ingredients: [
								{ english: "chicken", finnish: ["kana"], quantity: { amount: 200, unit: "g" } },
							],
							steps: ["Fry"],
						},
					],
					[
						line("tomatoes", "p1", "41"),
						line("carrots", "p2", "Hedelmät ja vihannekset"),
						line("milk", "ticked", "12"),
					],
				),
			],
			today,
		),
	);
	const week = files.get("OEBPS/this-week.xhtml") ?? "";
	expect(week).toContain('<a href="r-salmon-soup.xhtml">Salmon soup</a>');
	expect(week).toContain("(tonight)");
	expect(week).toContain('<a href="r-plan-teriyaki-stir-fry.xhtml">Teriyaki stir-fry</a>');
	expect(week.indexOf("Aisle 41")).toBeLessThan(week.indexOf("Hedelmät ja vihannekset"));
	expect(week).not.toContain("milk");
	expect(week).toContain("1 already ticked off");
	expect(files.get("OEBPS/r-salmon-soup.xhtml")).toContain("On the plan: Mon 16 Nov");
	expect(files.get("OEBPS/contents.xhtml")).toContain("From this week&#39;s plan");
});

test("plans that are over leave no shopping list behind", () => {
	const old = plan(
		[
			{
				name: "Mon dinner",
				dish: "Soup",
				date: "2026-10-01",
				servings: 4,
				ingredients: [],
				steps: [],
			},
		],
		[line("tomatoes", "p1", "41")],
	);
	const week = read(buildCookbook([], [old], today)).get("OEBPS/this-week.xhtml") ?? "";
	expect(week).not.toContain("Shopping:");
	expect(week).toContain("Nothing planned yet.");
});

test("the same data gives the same bytes, so the Kindle can skip unchanged downloads", () => {
	const recipes = [recipe("a", "A"), recipe("b", "B")];
	expect(buildCookbook(recipes, [], today)).toEqual(
		buildCookbook(recipes, [], new Date(2026, 10, 16, 20, 0)),
	);
});

test("a single-recipe book opens straight on the recipe", () => {
	const files = read(buildRecipeBook(recipe("a", "Salmon soup")));
	expect(files.get("OEBPS/content.opf")).toContain('<itemref idref="p0"/></spine>');
	expect(files.get("OEBPS/recipe.xhtml")).toContain("<h1>Salmon soup</h1>");
});
