import { dayLabel, dinnersByDate, localIsoDate, mealDate } from "../dinners.ts";
import type { InstagramPost } from "../instagram.ts";
import { listPlans } from "../plan-book.ts";
import { findRecipe, listRecipes, type Recipe, scaleRecipe, slugify } from "../recipe-book.ts";
import type { WebRecipe } from "../web-recipe.ts";
import {
	buildCaptionBook,
	buildMealBook,
	buildRecipeBook,
	buildWebRecipeBook,
} from "./cookbook.ts";
import { type KindleRequest, outbox, type Sendable } from "./outbox.ts";

// Everything that can go to the Kindle, each turned into a ready book. The outbox does not care
// where a book came from.

const MAX_SERVINGS = 100;

function sendable(key: string, name: string, servings: number, book: Uint8Array): Sendable {
	return { key: key.slice(0, 60), name, servings, book };
}

function savedRecipe(recipe: Recipe, servings: number | undefined): Sendable {
	const wanted =
		servings !== undefined && Number.isInteger(servings) && servings > 0 && servings <= MAX_SERVINGS
			? servings
			: recipe.servings;
	const scaled = wanted === recipe.servings ? recipe : scaleRecipe(recipe, wanted);
	return sendable(recipe.id, recipe.name, wanted, buildRecipeBook(scaled));
}

export async function requestOpenOnKindle(
	recipeId: string,
	servings: number | undefined,
	now = Date.now(),
): Promise<KindleRequest | null> {
	const recipe = await findRecipe(recipeId);
	return recipe ? outbox.send(savedRecipe(recipe, servings), { from: "app" }, now) : null;
}

export function requestOpenWebRecipe(web: WebRecipe, now = Date.now()): KindleRequest {
	const book = buildWebRecipeBook(web, new Date(now));
	return outbox.send(
		sendable(`web-${slugify(web.name)}`, web.name, web.servings ?? 0, book),
		{
			from: "app",
		},
		now,
	);
}

export function requestOpenInstagram(post: InstagramPost, now = Date.now()): KindleRequest {
	const book = buildCaptionBook(post, new Date(now));
	return outbox.send(
		sendable(`instagram-${slugify(post.title)}`, post.title, 0, book),
		{
			from: "app",
		},
		now,
	);
}

export type DinnerSendResult =
	| { ok: true; message: string; date: string; request: KindleRequest }
	| { ok: false; message: string; date: string | null };

// The dinner-menu display's Cook button sends the evening it is showing: as a date from firmware
// that reads day_N_full, as the label it shows ("Mon 16 Nov") from older firmware. Messages are
// short because the display shows them.
export async function requestOpenDinner(
	day: string,
	now = Date.now(),
	from: "home-assistant" | "evening" = "home-assistant",
): Promise<DinnerSendResult> {
	const date = mealDate({ name: day, date: day }, new Date(now).toISOString());
	if (!date) return { ok: false, message: "Unknown day", date: null };
	const [y, m, d] = date.split("-").map(Number);
	const label = dayLabel(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1));
	const found = dinnersByDate(await listPlans()).get(date);
	if (!found) return { ok: false, message: `Nothing planned for ${label}`, date };
	const { meal } = found;
	const dish = meal.dish ?? meal.name;

	// Like the cookbook, prefer the saved recipe: it is the one that gets edited and rated
	const recipes = await listRecipes();
	const saved =
		(meal.recipe ? recipes.find((r) => r.id === meal.recipe) : undefined) ??
		recipes.find((r) => r.name.toLowerCase() === dish.toLowerCase());
	let item: Sendable | null = null;
	if (saved) item = savedRecipe(saved, meal.servings);
	else if (meal.steps.length || meal.ingredients.length) {
		item = sendable(
			`plan-${slugify(dish)}`,
			dish,
			meal.servings,
			buildMealBook(meal, dish, new Date(now)),
		);
	}
	if (!item) return { ok: false, message: `No recipe for ${label}`, date };
	const request = outbox.send(item, { from, date }, now);
	return {
		ok: true,
		// A Kindle that has not asked lately is asleep or out of KOReader, and gets the recipe
		// only if it asks within the next 10 minutes
		message: outbox.seenRecently(now) ? "Sent to the Kindle" : "Open KOReader on the Kindle",
		date,
		request,
	};
}

// From late afternoon the Kindle opens tonight's dinner by itself: the plugin already asks for a
// request every few seconds while KOReader is open and right after the Kindle wakes, so the first
// time someone picks it up in the evening the recipe is there, with no change to the plugin.
// Anything sent to the Kindle since the evening began (this dinner, or a recipe someone chose
// instead) counts as handled, so it is handed over once and never takes over a book picked later.
const EVENING_START_HOUR = 16;
const EVENING_END_HOUR = 21;
// The plans are read from disk; with nothing planned, look again now and then rather than on
// every poll
const EVENING_RETRY_MS = 5 * 60_000;
let lastEveningTry: number | null = null;

export async function sendTonightIfDue(now = Date.now()): Promise<void> {
	const at = new Date(now);
	const hour = at.getHours();
	if (hour < EVENING_START_HOUR || hour >= EVENING_END_HOUR) return;
	const eveningStart = new Date(
		at.getFullYear(),
		at.getMonth(),
		at.getDate(),
		EVENING_START_HOUR,
	).getTime();
	// An unopened request that expired is gone from the outbox, so a Kindle that never fetched
	// tonight's dinner is offered it again
	const latest = outbox.current(now);
	if (latest && latest.requestedAt >= eveningStart) return;
	if (lastEveningTry !== null && now - lastEveningTry < EVENING_RETRY_MS) return;
	lastEveningTry = now;
	await requestOpenDinner(localIsoDate(at), now, "evening");
}

export function kindleStatus(now = Date.now()) {
	return outbox.status(now);
}

export function resetKindleState(): void {
	outbox.reset();
	lastEveningTry = null;
}
