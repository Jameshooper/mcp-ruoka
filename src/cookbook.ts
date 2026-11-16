import { buildMenu, localIsoDate, mealDate } from "./dinner-menu.ts";
import type { MealPlan } from "./plan-book.ts";
import type { Recipe } from "./recipe-book.ts";
import type { WebRecipe } from "./web-recipe.ts";
import { zipFiles } from "./zip.ts";

// An EPUB cookbook for e-ink readers (built for KOReader on a Kindle). Pages are plain XHTML with
// links, so it works on any reader; a "This week" page carries the dinner plan and shopping list.

type Ingredient = Recipe["ingredients"][number];

interface Page {
	file: string;
	title: string;
	body: string;
}

interface Section {
	key: string;
	label: string;
	recipes: CookbookRecipe[];
}

// A saved recipe, or a planned meal that was never saved as one but has a method
interface CookbookRecipe {
	id: string;
	name: string;
	servings: number;
	prepMinutes?: number;
	cookMinutes?: number;
	protein?: string;
	vegetables?: boolean;
	nutrition?: Recipe["nutrition"];
	costPerPortion?: number;
	tags: string[];
	ingredients: Ingredient[];
	steps: string[];
	notes?: string;
	rating?: number;
}

const SECTIONS: Array<[string, string]> = [
	["fish", "Fish"],
	["chicken", "Chicken"],
	["meat", "Meat"],
	["vegetarian", "Vegetarian"],
	["other", "More recipes"],
	["brunch", "Brunch and weekend"],
	["plan", "From this week's plan"],
];

const PROTEIN_LABEL: Record<string, string> = {
	fish: "Fish",
	white_meat: "Chicken",
	red_meat: "Meat",
	vegetarian: "Vegetarian",
	other: "Other",
};

// How far ahead the "This week" page looks, so a plan made on Sunday for the next nine days fits
const WEEK_DAYS = 10;

// KOReader justifies text and indents paragraphs unless told otherwise, which spreads short
// headings across the line on a narrow screen
const CSS = `
body { font-family: serif; line-height: 1.4; margin: 0 0.4em; }
h1, h2, h3, p, li, td { text-align: left; text-indent: 0; hyphens: none; }
h1 { font-size: 1.6em; line-height: 1.2; margin: 1.2em 0 0.4em 0; }
h2 { font-size: 1.2em; margin: 1.1em 0 0.3em 0; border-bottom: 1px solid #000; padding-bottom: 0.1em; }
h3 { font-size: 1.05em; margin: 0.9em 0 0.2em 0; }
p { margin: 0.3em 0; }
.meta { font-size: 0.95em; margin: 0 0 0.2em 0; }
.small { font-size: 0.85em; }
.tags { font-size: 0.85em; font-style: italic; }
ul, ol { margin: 0.3em 0 0.3em 1.3em; padding: 0; }
li { margin: 0.25em 0; }
ol.method li { margin: 0.6em 0; }
ul.toc { list-style: none; margin-left: 0; }
ul.toc li { margin: 0.55em 0; }
.sub { font-size: 0.85em; }
td { vertical-align: top; padding: 0.15em 0.4em 0.15em 0; }
td.q { white-space: nowrap; text-align: right; font-weight: bold; }
.nav { font-size: 0.9em; margin-top: 1.4em; border-top: 1px solid #000; padding-top: 0.3em; }
.note { font-size: 0.9em; border-left: 3px solid #000; padding-left: 0.5em; margin-top: 1em; }
.center, .center h1, .center p { text-align: center; }
`;

const ENCODER = new TextEncoder();

export function escapeXml(value: string | number): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function fileSlug(id: string): string {
	return id.replace(/[^a-z0-9-]+/gi, "-").slice(0, 80) || "recipe";
}

function num(x: number): string {
	return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100);
}

export function formatQuantity(quantity: Ingredient["quantity"]): string {
	if (!quantity) return "";
	const { amount, unit } = quantity;
	if (unit === "g" && amount >= 1000) return `${num(amount / 1000)} kg`;
	if (unit === "ml" && amount >= 1000) return `${num(amount / 1000)} l`;
	if (unit === "pcs") return `${num(amount)} ×`;
	return `${num(amount)} ${unit}`;
}

function minutes(m: number): string {
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	const rest = m % 60;
	return rest ? `${h} h ${rest} min` : `${h} h`;
}

function totalMinutes(r: CookbookRecipe): number {
	return (r.prepMinutes ?? 0) + (r.cookMinutes ?? 0);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

// Built by hand rather than with toLocaleDateString, whose output depends on the runtime's ICU data
function dayLabel(iso: string): string {
	const [y, m, d] = iso.split("-").map(Number);
	const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
	return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]?.slice(0, 3)}`;
}

function longDate(date: Date): string {
	return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function fromRecipe(r: Recipe): CookbookRecipe {
	return {
		id: r.id,
		name: r.name,
		servings: r.servings,
		prepMinutes: r.prepMinutes,
		cookMinutes: r.cookMinutes,
		protein: r.protein,
		vegetables: r.vegetables,
		nutrition: r.nutrition,
		costPerPortion: r.estimatedCost?.perPortion,
		tags: r.tags,
		ingredients: r.ingredients,
		steps: r.steps,
		notes: r.notes,
		rating: r.rating,
	};
}

function fromMeal(meal: MealPlan["meals"][number], dish: string): CookbookRecipe {
	return {
		id: `plan-${fileSlug(dish.toLowerCase())}`,
		name: dish,
		servings: meal.servings,
		prepMinutes: meal.prepMinutes,
		cookMinutes: meal.cookMinutes,
		protein: meal.protein,
		vegetables: meal.vegetables,
		nutrition: meal.nutrition,
		costPerPortion: meal.cost?.perPortion,
		tags: [],
		ingredients: meal.ingredients,
		steps: meal.steps,
	};
}

function sectionOf(r: CookbookRecipe): string {
	if (r.tags.some((t) => t.toLowerCase() === "brunch")) return "brunch";
	switch (r.protein) {
		case "fish":
			return "fish";
		case "white_meat":
			return "chicken";
		case "red_meat":
			return "meat";
		case "vegetarian":
			return "vegetarian";
		default:
			return "other";
	}
}

function page(title: string, body: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>
`;
}

function ingredientTable(items: Ingredient[]): string {
	const rows = items
		.map(
			(i) =>
				`<tr><td class="q">${escapeXml(formatQuantity(i.quantity))}</td><td>${escapeXml(i.english)}</td></tr>`,
		)
		.join("");
	return `<table>${rows}</table>`;
}

function recipeBody(r: CookbookRecipe, onPlan: string | undefined, nav: string): string {
	const total = totalMinutes(r);
	const meta = [`Serves ${r.servings}`];
	if (total) {
		meta.push(
			`${minutes(total)} (prep ${minutes(r.prepMinutes ?? 0)}, cook ${minutes(r.cookMinutes ?? 0)})`,
		);
	}
	const extra = [PROTEIN_LABEL[r.protein ?? ""] ?? null, r.vegetables ? "with vegetables" : null];
	if (r.costPerPortion) extra.push(`about €${r.costPerPortion.toFixed(2)} a portion`);
	if (r.rating) extra.push(`${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}`);
	const n = r.nutrition;
	const tags = r.tags.filter((t) => !["family", "dinner"].includes(t.toLowerCase()));
	const parts = [
		`<h1>${escapeXml(r.name)}</h1>`,
		`<p class="meta">${escapeXml(meta.join(" · "))}</p>`,
		n
			? `<p class="meta">Per portion: ${Math.round(n.kcal)} kcal · protein ${Math.round(n.proteinG)} g${n.carbsG !== undefined ? ` · carbs ${Math.round(n.carbsG)} g` : ""}${n.fatG !== undefined ? ` · fat ${Math.round(n.fatG)} g` : ""}${n.source === "estimate" ? " (estimate)" : ""}</p>`
			: "",
		`<p class="meta">${escapeXml(extra.filter(Boolean).join(" · "))}</p>`,
		onPlan ? `<p class="meta"><b>On the plan: ${escapeXml(onPlan)}</b></p>` : "",
		tags.length ? `<p class="tags">${escapeXml(tags.join(", "))}</p>` : "",
		"<h2>Ingredients</h2>",
		ingredientTable(r.ingredients.filter((i) => !i.pantry)),
	];
	const pantry = r.ingredients.filter((i) => i.pantry);
	if (pantry.length) parts.push("<h3>From the cupboard</h3>", ingredientTable(pantry));
	if (r.steps.length) {
		parts.push(
			"<h2>Method</h2>",
			`<ol class="method">${r.steps.map((s) => `<li>${escapeXml(s)}</li>`).join("")}</ol>`,
		);
	}
	if (r.notes) parts.push(`<p class="note">${escapeXml(r.notes)}</p>`);
	if (nav) parts.push(`<p class="nav">${nav}</p>`);
	return parts.filter(Boolean).join("\n");
}

function shoppingSection(plan: MealPlan): string {
	const ticked = new Set(plan.checked);
	const lines = plan.toBuy.lines.filter((l) => !ticked.has(l.productId));
	const parts = [`<h2>Shopping: ${escapeXml(plan.name)}</h2>`];
	const info = [plan.store.name, `about €${plan.toBuy.total.toFixed(2)}`]
		.filter(Boolean)
		.join(" · ");
	parts.push(`<p class="small">${escapeXml(info)}. Cupboard staples not included.</p>`);
	if (ticked.size) {
		const got = plan.toBuy.lines.length - lines.length;
		parts.push(`<p class="small">${got} already ticked off in the app.</p>`);
	}
	if (!lines.length) {
		parts.push("<p>Everything is ticked off.</p>");
		return parts.join("\n");
	}

	// Numbered aisles in shelf order, then named areas (produce), then anything without a location
	const groups = new Map<string, { order: string; label: string; items: typeof lines }>();
	for (const line of lines) {
		const aisle = line.location?.aisle ?? null;
		const floor = line.location?.floor ?? null;
		const numeric = aisle !== null && /^\d+$/.test(aisle);
		let label = aisle === null ? "No aisle listed" : numeric ? `Aisle ${aisle}` : aisle;
		if (aisle !== null && floor !== null && floor !== 1) label += ` (floor ${floor})`;
		const order = aisle === null ? "2" : numeric ? `0${aisle.padStart(6, "0")}` : `1${aisle}`;
		const group = groups.get(label) ?? { order, label, items: [] };
		group.items.push(line);
		groups.set(label, group);
	}
	const sorted = [...groups.values()].sort((a, b) => a.order.localeCompare(b.order));
	const showHeadings = sorted.some((g) => g.label !== "No aisle listed");
	for (const group of sorted) {
		if (showHeadings) parts.push(`<h3>${escapeXml(group.label)}</h3>`);
		parts.push(
			`<ul>${group.items
				.map(
					(l) =>
						`<li><b>${escapeXml(l.ingredient)}</b>: ${escapeXml(l.needed)}<br/><span class="small">${escapeXml(l.product)}</span></li>`,
				)
				.join("")}</ul>`,
		);
	}
	if (plan.missing.length) {
		const names = plan.missing.map((m) => m.ingredient).join(", ");
		parts.push(`<p class="small">Also buy (not priced): ${escapeXml(names)}.</p>`);
	}
	return parts.join("\n");
}

function packageEpub(options: {
	title: string;
	pages: Page[];
	nav: Array<{ label: string; file: string; children?: Array<{ label: string; file: string }> }>;
	modified: Date;
	identifier: string;
}): Uint8Array {
	const { title, pages, nav, modified, identifier } = options;
	const stamp = `${modified.toISOString().slice(0, 19)}Z`;

	const navList = nav
		.map((item) => {
			const kids = item.children?.length
				? `<ol>${item.children.map((c) => `<li><a href="${c.file}">${escapeXml(c.label)}</a></li>`).join("")}</ol>`
				: "";
			return `<li><a href="${item.file}">${escapeXml(item.label)}</a>${kids}</li>`;
		})
		.join("");
	const navDoc = page(
		"Contents",
		`<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navList}</ol></nav>`,
	);

	// KOReader and older readers take the table of contents from the NCX
	let order = 0;
	const point = (label: string, file: string, children = ""): string => {
		order += 1;
		return `<navPoint id="np${order}" playOrder="${order}"><navLabel><text>${escapeXml(label)}</text></navLabel><content src="${file}"/>${children}</navPoint>`;
	};
	const ncxPoints = nav
		.map((item) => {
			if (!item.children?.length) return point(item.label, item.file);
			order += 1;
			const parentOrder = order;
			const kids = item.children.map((c) => point(c.label, c.file)).join("");
			return `<navPoint id="np${parentOrder}" playOrder="${parentOrder}"><navLabel><text>${escapeXml(item.label)}</text></navLabel><content src="${item.file}"/>${kids}</navPoint>`;
		})
		.join("");
	const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(identifier)}"/><meta name="dtb:depth" content="2"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${ncxPoints}</navMap></ncx>
`;

	const manifest = [
		'<item id="css" href="style.css" media-type="text/css"/>',
		'<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
		'<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
		...pages.map(
			(p, i) => `<item id="p${i}" href="${p.file}" media-type="application/xhtml+xml"/>`,
		),
	].join("");
	const spine = pages.map((_, i) => `<itemref idref="p${i}"/>`).join("");
	const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>Ruoka</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">${stamp}</meta></metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>
`;
	const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>
`;

	// The zip timestamp comes from the data, so unchanged recipes give byte-identical files and the
	// Kindle can tell from the ETag that nothing needs downloading
	return zipFiles(
		[
			{ name: "mimetype", data: ENCODER.encode("application/epub+zip"), stored: true },
			{ name: "META-INF/container.xml", data: ENCODER.encode(container) },
			{ name: "OEBPS/content.opf", data: ENCODER.encode(opf) },
			{ name: "OEBPS/toc.ncx", data: ENCODER.encode(ncx) },
			{ name: "OEBPS/nav.xhtml", data: ENCODER.encode(navDoc) },
			{ name: "OEBPS/style.css", data: ENCODER.encode(CSS) },
			...pages.map((p) => ({ name: `OEBPS/${p.file}`, data: ENCODER.encode(p.body) })),
		],
		modified,
	);
}

function latest(dates: string[], fallback: Date): Date {
	const times = dates.map((d) => Date.parse(d)).filter((t) => Number.isFinite(t));
	return times.length ? new Date(Math.max(...times)) : fallback;
}

export function buildCookbook(
	recipes: Recipe[],
	plans: MealPlan[],
	today = new Date(),
): Uint8Array {
	const todayIso = localIsoDate(today);
	const horizon = localIsoDate(
		new Date(today.getFullYear(), today.getMonth(), today.getDate() + WEEK_DAYS - 1),
	);
	const book = recipes.map(fromRecipe);
	const byName = new Map(book.map((r) => [r.name.toLowerCase(), r]));
	const byId = new Map(book.map((r) => [r.id, r]));

	// Plans that cover any evening from today on: their shopping lists and unsaved meals are shown
	const current = plans.filter((plan) =>
		plan.meals.some((meal) => {
			const date = mealDate(meal, plan.createdAt);
			return date !== null && date >= todayIso && date <= horizon;
		}),
	);
	const planned: CookbookRecipe[] = [];
	for (const plan of current) {
		for (const meal of plan.meals) {
			const dish = meal.dish ?? meal.name;
			if (meal.recipe && byId.has(meal.recipe)) continue;
			if (byName.has(dish.toLowerCase()) || !meal.steps.length || !meal.ingredients.length)
				continue;
			const r = fromMeal(meal, dish);
			byName.set(dish.toLowerCase(), r);
			planned.push(r);
		}
	}

	const fileOf = (r: CookbookRecipe) => `r-${fileSlug(r.id)}.xhtml`;
	const menu = buildMenu(plans, today, WEEK_DAYS).filter((day) => day.dish);
	const recipeForDish = (day: (typeof menu)[number]) =>
		(day.recipe ? byId.get(day.recipe) : undefined) ?? byName.get((day.dish ?? "").toLowerCase());
	const onPlan = new Map<string, string>();
	for (const day of menu) {
		const r = recipeForDish(day);
		if (r && !onPlan.has(r.id)) onPlan.set(r.id, dayLabel(day.date));
	}

	const sections: Section[] = SECTIONS.map(([key, label]) => ({ key, label, recipes: [] }));
	for (const r of book) sections.find((s) => s.key === sectionOf(r))?.recipes.push(r);
	sections.find((s) => s.key === "plan")?.recipes.push(...planned);
	const filled = sections.filter((s) => s.recipes.length);
	for (const s of filled) s.recipes.sort((a, b) => a.name.localeCompare(b.name));

	const nav = `<a href="contents.xhtml">Contents</a> · <a href="this-week.xhtml">This week</a> · <a href="index.xhtml">Ingredient index</a>`;
	const builtOn = longDate(today);

	const title = page(
		"Ruoka Cookbook",
		`<div class="center"><h1 style="margin-top:3em;font-size:2.2em">Ruoka Cookbook</h1><p>${recipes.length} recipes from the Ruoka app</p><p class="small">Updated ${escapeXml(builtOn)}</p><p style="margin-top:2em"><a href="contents.xhtml">Contents</a> · <a href="this-week.xhtml">This week</a></p></div>`,
	);

	const contents = [
		"<h1>Contents</h1>",
		'<ul class="toc"><li><a href="this-week.xhtml"><b>This week</b></a><br/><span class="sub">Dinner plan and shopping list</span></li><li><a href="index.xhtml"><b>Ingredient index</b></a><br/><span class="sub">Find recipes by what you have</span></li></ul>',
	];
	for (const s of filled) {
		contents.push(`<h2>${escapeXml(s.label)}</h2>`, '<ul class="toc">');
		for (const r of s.recipes) {
			const total = totalMinutes(r);
			const sub = `Serves ${r.servings}${total ? ` · ${minutes(total)}` : ""}`;
			contents.push(
				`<li><a href="${fileOf(r)}">${escapeXml(r.name)}</a><br/><span class="sub">${escapeXml(sub)}</span></li>`,
			);
		}
		contents.push("</ul>");
	}

	const week = ["<h1>This week</h1>", "<h2>Dinners</h2>"];
	if (menu.length) {
		week.push('<ul class="toc">');
		for (const day of menu) {
			const r = recipeForDish(day);
			const dish = escapeXml(day.dish ?? "");
			const name = r ? `<a href="${fileOf(r)}">${dish}</a>` : dish;
			const tonight = day.date === todayIso ? " <b>(tonight)</b>" : "";
			week.push(`<li><b>${escapeXml(dayLabel(day.date))}</b>${tonight}<br/>${name}</li>`);
		}
		week.push("</ul>");
	} else {
		week.push("<p>Nothing planned yet.</p>");
	}
	for (const plan of current) week.push(shoppingSection(plan));
	week.push(
		`<p class="nav"><a href="contents.xhtml">Contents</a> · <a href="index.xhtml">Ingredient index</a></p>`,
	);

	// Main ingredients only: everything uses salt, so cupboard staples would bury the useful entries
	const index = new Map<string, Map<string, CookbookRecipe>>();
	for (const r of [...book, ...planned]) {
		for (const i of r.ingredients) {
			if (i.pantry) continue;
			const key = (i.english.replace(/\s*\(.*?\)/g, "").split(",")[0] ?? "").trim().toLowerCase();
			if (!key) continue;
			const entry = index.get(key) ?? new Map<string, CookbookRecipe>();
			entry.set(r.id, r);
			index.set(key, entry);
		}
	}
	const indexBody = [
		"<h1>Ingredient index</h1>",
		'<p class="small">Main ingredients only (not cupboard staples).</p>',
	];
	let letter = "";
	for (const key of [...index.keys()].sort()) {
		const first = key.charAt(0).toUpperCase();
		if (first !== letter) {
			if (letter) indexBody.push("</ul>");
			letter = first;
			indexBody.push(`<h2>${escapeXml(letter)}</h2><ul class="toc">`);
		}
		const links = [...(index.get(key)?.values() ?? [])]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((r) => `<a href="${fileOf(r)}">${escapeXml(r.name)}</a>`)
			.join(", ");
		indexBody.push(`<li><b>${escapeXml(key)}</b><br/><span class="sub">${links}</span></li>`);
	}
	if (letter) indexBody.push("</ul>");
	indexBody.push(
		`<p class="nav"><a href="contents.xhtml">Contents</a> · <a href="this-week.xhtml">This week</a></p>`,
	);

	const pages: Page[] = [
		{ file: "title.xhtml", title: "Ruoka Cookbook", body: title },
		{ file: "contents.xhtml", title: "Contents", body: page("Contents", contents.join("\n")) },
		{ file: "this-week.xhtml", title: "This week", body: page("This week", week.join("\n")) },
	];
	for (const s of filled) {
		for (const r of s.recipes) {
			pages.push({
				file: fileOf(r),
				title: r.name,
				body: page(r.name, recipeBody(r, onPlan.get(r.id), nav)),
			});
		}
	}
	pages.push({
		file: "index.xhtml",
		title: "Ingredient index",
		body: page("Ingredient index", indexBody.join("\n")),
	});

	// The date is part of the content ("tonight"), so the file changes at least once a day
	const dataTime = latest(
		[...recipes.map((r) => r.updatedAt), ...plans.map((p) => p.updatedAt)],
		today,
	);
	const modified = new Date(
		Math.max(dataTime.getTime(), new Date(`${todayIso}T00:00:00`).getTime()),
	);

	return packageEpub({
		title: "Ruoka Cookbook",
		pages,
		nav: [
			{ label: "This week", file: "this-week.xhtml" },
			...filled.flatMap((s) => {
				const first = s.recipes[0];
				if (!first) return [];
				const children = s.recipes.map((r) => ({ label: r.name, file: fileOf(r) }));
				return [{ label: s.label, file: fileOf(first), children }];
			}),
			{ label: "Ingredient index", file: "index.xhtml" },
		],
		modified,
		identifier: "urn:ruoka:cookbook",
	});
}

// One recipe on its own, already scaled, for "Open on Kindle": a short book opens straight to the
// recipe instead of the cookbook's title page
export function buildRecipeBook(recipe: Recipe): Uint8Array {
	const r = fromRecipe(recipe);
	return packageEpub({
		title: recipe.name,
		pages: [
			{
				file: "recipe.xhtml",
				title: recipe.name,
				body: page(recipe.name, recipeBody(r, undefined, "")),
			},
		],
		nav: [{ label: recipe.name, file: "recipe.xhtml" }],
		modified: new Date(Date.parse(recipe.updatedAt) || 0),
		identifier: `urn:ruoka:recipe:${recipe.id}:${recipe.servings}`,
	});
}

// A recipe found on the web and sent from the phone's share sheet. Its ingredients are the site's
// own lines ("2 tbsp olive oil"), so they are listed as written instead of in the quantity table.
export function buildWebRecipeBook(web: WebRecipe, now = new Date()): Uint8Array {
	const meta: string[] = [];
	if (web.yieldText) meta.push(web.servings ? `Serves ${web.servings}` : web.yieldText);
	const total = web.totalMinutes ?? ((web.prepMinutes ?? 0) + (web.cookMinutes ?? 0) || undefined);
	if (total) {
		const split =
			web.prepMinutes !== undefined && web.cookMinutes !== undefined
				? ` (prep ${minutes(web.prepMinutes)}, cook ${minutes(web.cookMinutes)})`
				: "";
		meta.push(`${minutes(total)}${split}`);
	}
	if (web.kcal) meta.push(`${web.kcal} kcal a portion`);

	const parts = [
		`<h1>${escapeXml(web.name)}</h1>`,
		meta.length ? `<p class="meta">${escapeXml(meta.join(" · "))}</p>` : "",
		`<p class="small">From ${escapeXml(web.site)}</p>`,
		web.description ? `<p class="tags">${escapeXml(web.description)}</p>` : "",
		"<h2>Ingredients</h2>",
		`<ul>${web.ingredients.map((i) => `<li>${escapeXml(i)}</li>`).join("")}</ul>`,
	];
	if (web.steps.length) {
		parts.push("<h2>Method</h2>");
		let section: string | undefined;
		let open = false;
		for (const step of web.steps) {
			if (step.section !== section || !open) {
				if (open) parts.push("</ol>");
				section = step.section;
				if (section) parts.push(`<h3>${escapeXml(section)}</h3>`);
				parts.push('<ol class="method">');
				open = true;
			}
			parts.push(`<li>${escapeXml(step.text)}</li>`);
		}
		if (open) parts.push("</ol>");
	}
	parts.push(`<p class="note">Source: ${escapeXml(web.source)}</p>`);

	return packageEpub({
		title: web.name,
		pages: [
			{
				file: "recipe.xhtml",
				title: web.name,
				body: page(web.name, parts.filter(Boolean).join("\n")),
			},
		],
		nav: [{ label: web.name, file: "recipe.xhtml" }],
		modified: now,
		identifier: `urn:ruoka:web:${web.source}`,
	});
}
