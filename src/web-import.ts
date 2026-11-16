import type { RecipeInput } from "./recipe-book.ts";
import type { Ingredient } from "./schemas.ts";
import { type WebRecipe, WebRecipeError } from "./web-recipe.ts";

// Turns a recipe read from a web page into one the recipe book can hold. The app has no way to
// translate, so each ingredient's own name becomes its shop search term: right for Finnish sites,
// a placeholder for others. Imported recipes carry IMPORT_TAG so Claude can find and tidy them.

export const IMPORT_TAG = "from-web";

const MAX_INGREDIENTS = 40;
const MAX_STEPS = 40;
const MAX_STEP_CHARS = 2000;
// A page that does not say how many it serves is saved for a typical household
const DEFAULT_SERVINGS = 4;

type Unit = NonNullable<Ingredient["quantity"]>["unit"];

// Spoons and cups become ml, imperial weights become g, as the recipe book asks
const UNITS: Record<string, { unit: Unit; factor: number }> = {
	g: { unit: "g", factor: 1 },
	gr: { unit: "g", factor: 1 },
	gram: { unit: "g", factor: 1 },
	grams: { unit: "g", factor: 1 },
	gramma: { unit: "g", factor: 1 },
	grammaa: { unit: "g", factor: 1 },
	kg: { unit: "kg", factor: 1 },
	kilo: { unit: "kg", factor: 1 },
	kiloa: { unit: "kg", factor: 1 },
	ml: { unit: "ml", factor: 1 },
	cl: { unit: "ml", factor: 10 },
	dl: { unit: "ml", factor: 100 },
	l: { unit: "l", factor: 1 },
	litre: { unit: "l", factor: 1 },
	litres: { unit: "l", factor: 1 },
	liter: { unit: "l", factor: 1 },
	liters: { unit: "l", factor: 1 },
	litra: { unit: "l", factor: 1 },
	litraa: { unit: "l", factor: 1 },
	tbsp: { unit: "ml", factor: 15 },
	tbs: { unit: "ml", factor: 15 },
	tablespoon: { unit: "ml", factor: 15 },
	tablespoons: { unit: "ml", factor: 15 },
	rkl: { unit: "ml", factor: 15 },
	tsp: { unit: "ml", factor: 5 },
	teaspoon: { unit: "ml", factor: 5 },
	teaspoons: { unit: "ml", factor: 5 },
	tl: { unit: "ml", factor: 5 },
	mm: { unit: "ml", factor: 1 },
	cup: { unit: "ml", factor: 240 },
	cups: { unit: "ml", factor: 240 },
	oz: { unit: "g", factor: 28 },
	lb: { unit: "g", factor: 454 },
	lbs: { unit: "g", factor: 454 },
	kpl: { unit: "pcs", factor: 1 },
	// Finnish recipes count packs: purkki, paketti, pussi, rasia, tölkki
	prk: { unit: "pcs", factor: 1 },
	pkt: { unit: "pcs", factor: 1 },
	pss: { unit: "pcs", factor: 1 },
	pussi: { unit: "pcs", factor: 1 },
	rs: { unit: "pcs", factor: 1 },
	tlk: { unit: "pcs", factor: 1 },
	pcs: { unit: "pcs", factor: 1 },
};

const FRACTIONS: Record<string, number> = {
	"½": 0.5,
	"⅓": 1 / 3,
	"⅔": 2 / 3,
	"¼": 0.25,
	"¾": 0.75,
	"⅛": 0.125,
};

// Staples the cook probably has, in English and Finnish
const PANTRY =
	/^(salt|pepper|black pepper|sea salt|olive oil|oil|vegetable oil|sugar|flour|plain flour|water|suolaa?|pippuria?|mustapippuria?|öljyä?|oliiviöljyä?|rypsiöljyä?|sokeria?|vehnäjauhoa?|vehnäjauhoja|vesi|vettä)$/i;

function number(token: string): number | undefined {
	const t = token.replace(",", ".");
	const fraction = FRACTIONS[t];
	if (fraction !== undefined) return fraction;
	const slash = /^(\d+)[/⁄](\d+)$/.exec(t);
	if (slash) return Number(slash[1]) / Number(slash[2]);
	const whole = /^(\d+(?:\.\d+)?)([½⅓⅔¼¾⅛])?$/.exec(t);
	if (whole) return Number(whole[1]) + (whole[2] ? (FRACTIONS[whole[2]] ?? 0) : 0);
	return undefined;
}

// "1 1/2 cups milk", "2-3 cloves garlic", "500g beef", "2 dl kermaa" → amount, unit and the name
export function parseIngredient(line: string): Ingredient {
	let rest = line
		.replace(/\([^)]*\)/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	let amount: number | undefined;
	const lead = /^([\d.,/⁄½⅓⅔¼¾⅛]+)(?:\s+([\d/⁄½⅓⅔¼¾⅛]+))?(?:\s*[-–]\s*[\d.,/⁄½⅓⅔¼¾⅛]+)?\s*/.exec(
		rest,
	);
	if (lead?.[1]) {
		const first = number(lead[1]);
		const second = lead[2] ? number(lead[2]) : undefined;
		if (first !== undefined) {
			// "1 1/2" is one and a half; "2 ½" likewise
			amount = second !== undefined && second < 1 ? first + second : first;
			rest = rest.slice(lead[0].length);
		}
	}
	let unit: Unit = "pcs";
	let factor = 1;
	const word = /^([a-zäö]+)\.?(?:\s+|$)/i.exec(rest);
	const known = word?.[1] ? UNITS[word[1].toLowerCase()] : undefined;
	if (amount !== undefined && word && known) {
		unit = known.unit;
		factor = known.factor;
		rest = rest.slice(word[0].length);
	}
	const name =
		rest
			.replace(/^of\s+/i, "")
			.split(",")[0]
			?.trim()
			.slice(0, 100) || line.slice(0, 100);
	return {
		english: line.slice(0, 300),
		finnish: [name],
		...(PANTRY.test(name) && { pantry: true }),
		...(amount !== undefined &&
			amount > 0 && { quantity: { amount: Math.round(amount * factor * 100) / 100, unit } }),
	};
}

// Long methods are folded into fewer, longer steps rather than cut short
function foldSteps(web: WebRecipe): string[] {
	let lastSection: string | undefined;
	const lines = web.steps.map((step) => {
		const heading = step.section && step.section !== lastSection ? `${step.section}: ` : "";
		lastSection = step.section;
		return `${heading}${step.text}`;
	});
	const perStep = Math.ceil(lines.length / MAX_STEPS);
	const steps: string[] = [];
	for (let i = 0; i < lines.length; i += perStep) {
		steps.push(
			lines
				.slice(i, i + perStep)
				.join(" ")
				.slice(0, MAX_STEP_CHARS),
		);
	}
	return steps;
}

export function webRecipeToInput(web: WebRecipe): RecipeInput {
	if (web.ingredients.length > MAX_INGREDIENTS) {
		throw new WebRecipeError(
			`That recipe has ${web.ingredients.length} ingredients; Ruoka holds up to ${MAX_INGREDIENTS}`,
			422,
		);
	}
	const steps = foldSteps(web);
	if (steps.length === 0) throw new WebRecipeError("That page has no method to save", 422);
	const notes = [
		web.description,
		`From ${web.source}`,
		web.servings === undefined
			? `The page did not say how many it serves; saved as ${DEFAULT_SERVINGS}.`
			: undefined,
		"Shop search terms are the ingredient names as written; ask Claude to tidy imported recipes.",
	]
		.filter((n): n is string => !!n)
		.join("\n\n")
		.slice(0, 2000);
	const cook =
		web.cookMinutes ??
		(web.totalMinutes !== undefined && web.prepMinutes === undefined
			? web.totalMinutes
			: undefined);
	return {
		name: web.name.slice(0, 120),
		servings: web.servings ?? DEFAULT_SERVINGS,
		ingredients: web.ingredients.map(parseIngredient),
		steps,
		tags: [IMPORT_TAG],
		...(web.prepMinutes !== undefined && { prepMinutes: Math.min(web.prepMinutes, 1440) }),
		...(cook !== undefined && { cookMinutes: Math.min(cook, 1440) }),
		notes,
	};
}
