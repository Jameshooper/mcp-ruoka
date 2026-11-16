import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import {
	checkUrl,
	cleanText,
	durationMinutes,
	extractRecipe,
	fetchWebRecipe,
} from "./web-recipe.ts";
import { unzipFiles } from "./zip.ts";

let dir = "";
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-web-"));
	process.env.RUOKA_DATA_DIR = dir;
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

// The shape many WordPress recipe plugins publish: a @graph with the recipe among other nodes,
// instructions in sections, HTML entities in strings
const PAGE = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Blog"}</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"Article","headline":"My lasagne"},
 {"@type":["Recipe","NewsArticle"],"name":"Best Lasagne &amp; Salad",
  "description":"A <b>classic</b> for Sundays.",
  "recipeYield":["6","6 servings"],"prepTime":"PT30M","cookTime":"PT1H15M","totalTime":"PT1H45M",
  "nutrition":{"@type":"NutritionInformation","calories":"612 kcal"},
  "recipeIngredient":["500 g beef mince","2 tbsp olive oil","1&#8260;2 tsp salt"],
  "recipeInstructions":[
   {"@type":"HowToSection","name":"Sauce","itemListElement":[
     {"@type":"HowToStep","text":"Brown the mince."},{"@type":"HowToStep","text":"Add tomatoes &amp; simmer."}]},
   {"@type":"HowToSection","name":"Assemble","itemListElement":[{"@type":"HowToStep","text":"Layer and bake at 180&deg;C."}]}
  ]}
]}
</script></head><body>Lasagne</body></html>`;

test("reads a recipe from schema.org data, including @graph, sections and entities", () => {
	const recipe = extractRecipe(PAGE, "https://www.example.com/lasagne/");
	expect(recipe).toMatchObject({
		name: "Best Lasagne & Salad",
		site: "example.com",
		description: "A classic for Sundays.",
		servings: 6,
		prepMinutes: 30,
		cookMinutes: 75,
		totalMinutes: 105,
		kcal: 612,
		ingredients: ["500 g beef mince", "2 tbsp olive oil", "1⁄2 tsp salt"],
	});
	expect(recipe?.steps).toEqual([
		{ section: "Sauce", text: "Brown the mince." },
		{ section: "Sauce", text: "Add tomatoes & simmer." },
		{ section: "Assemble", text: "Layer and bake at 180°C." },
	]);
});

test("accepts instructions as one block of text and a page without a recipe gives null", () => {
	const page = `<script type='application/ld+json'>{"@type":"Recipe","name":"Toast","recipeIngredient":["bread"],"recipeInstructions":"Toast the bread.\\nButter it."}</script>`;
	expect(extractRecipe(page, "https://a.example/t")?.steps).toEqual([
		{ text: "Toast the bread." },
		{ text: "Butter it." },
	]);
	expect(
		extractRecipe(
			'<html><script type="application/ld+json">{broken</script></html>',
			"https://a.example",
		),
	).toBeNull();
	expect(
		extractRecipe(
			'<script type="application/ld+json">{"@type":"Article","name":"x"}</script>',
			"https://a.example",
		),
	).toBeNull();
});

test("durations and text clean-up", () => {
	expect(durationMinutes("PT1H30M")).toBe(90);
	expect(durationMinutes("P0DT2H")).toBe(120);
	expect(durationMinutes("PT0M")).toBeUndefined();
	expect(durationMinutes("20 minutes")).toBeUndefined();
	expect(cleanText("Mix<br/>well &amp; <a href='x'>serve</a> &#x27;hot&#x27;")).toBe(
		"Mix well & serve 'hot'",
	);
});

test("only public http(s) pages can be fetched", () => {
	for (const bad of [
		"file:///etc/passwd",
		"ftp://example.com/x",
		"http://localhost:8123/api",
		"http://127.0.0.1/",
		"http://192.168.86.86:8123/",
		"http://10.0.0.1/",
		"http://172.30.32.2/",
		"http://100.86.191.43/",
		"http://supervisor/core/api/states",
		"http://homeassistant.local:8123/",
		"http://[::1]/",
		"https://user:pw@example.com/",
		"not a url",
	]) {
		expect(() => checkUrl(bad)).toThrow();
	}
	expect(checkUrl("https://www.bbcgoodfood.com/recipes/lasagne").hostname).toBe(
		"www.bbcgoodfood.com",
	);
});

test("a redirect to the home network is refused like the first link", async () => {
	const redirecting = async () =>
		new Response(null, { status: 302, headers: { location: "http://192.168.86.86:8123/" } });
	await expect(fetchWebRecipe("https://example.com/r", redirecting)).rejects.toThrow(
		"Only public web pages",
	);
});

const SentJson = z.object({ sent: z.literal(true), name: z.string(), message: z.string() });
const RequestJson = z.object({
	id: z.string(),
	recipe: z.string(),
	servings: z.number(),
	url: z.string(),
});

test("share sheet to Kindle: the page is read, sent, and served to the Kindle as a book", async () => {
	const { handleUiRequest, setWebFetchForTests } = await import("./ui-server.ts");
	const { handleKindleRequest, resetKindleState } = await import("./kindle.ts");
	resetKindleState();
	const fetched: string[] = [];
	setWebFetchForTests(async (url) => {
		fetched.push(url.toString());
		return new Response(PAGE, { headers: { "Content-Type": "text/html" } });
	});

	const sent = await handleUiRequest(
		new Request("http://x/api/kindle/open-url", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "https://www.example.com/lasagne/" }),
		}),
	);
	expect(sent.status).toBe(200);
	expect(SentJson.parse(await sent.json()).message).toBe(
		'Sent "Best Lasagne & Salad" to the Kindle',
	);
	expect(fetched).toEqual(["https://www.example.com/lasagne/"]);

	const request = RequestJson.parse(
		await (await handleKindleRequest(new Request("http://kindle/kindle/request"))).json(),
	);
	expect(request.recipe).toBe("web-best-lasagne-salad");
	expect(request.servings).toBe(6);
	const book = await handleKindleRequest(new Request(`http://kindle${request.url}`));
	const page = new TextDecoder().decode(
		unzipFiles(new Uint8Array(await book.arrayBuffer())).get("OEBPS/recipe.xhtml"),
	);
	expect(page).toContain("<h1>Best Lasagne &amp; Salad</h1>");
	expect(page).toContain("<h3>Assemble</h3>");
	expect(page).toContain("From example.com");

	const noRecipe = await (async () => {
		setWebFetchForTests(async () => new Response("<html>No data</html>"));
		return handleUiRequest(
			new Request("http://x/api/kindle/open-url", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: "https://example.com/blog" }),
			}),
		);
	})();
	expect(noRecipe.status).toBe(200);
	expect(await noRecipe.json()).toMatchObject({
		ok: false,
		message: "No recipe found on that page",
	});
	setWebFetchForTests(fetch);
});

test("a site that blocks plain requests is loaded in the browser instead", async () => {
	const blocked = async () => new Response("Forbidden", { status: 403 });
	const opened: string[] = [];
	const recipe = await fetchWebRecipe(
		"https://www.k-ruoka.fi/reseptit/lohikeitto",
		blocked,
		async (url) => {
			opened.push(url.toString());
			return PAGE;
		},
	);
	expect(opened).toEqual(["https://www.k-ruoka.fi/reseptit/lohikeitto"]);
	expect(recipe.name).toBe("Best Lasagne & Salad");
	await expect(fetchWebRecipe("https://example.com/x", blocked, async () => null)).rejects.toThrow(
		"HTTP 403",
	);
});
