import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

let dir = "";

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-kindle-"));
	process.env.RUOKA_DATA_DIR = dir;
	const { saveRecipe } = await import("./recipe-book.ts");
	await saveRecipe({
		name: "Salmon soup",
		servings: 8,
		ingredients: [
			{ english: "salmon fillet", finnish: ["lohi"], quantity: { amount: 1200, unit: "g" } },
		],
		steps: ["Simmer"],
		tags: [],
	});
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
	const { resetKindleState } = await import("./kindle.ts");
	resetKindleState();
});

const RequestJson = z.object({
	id: z.string(),
	recipe: z.string(),
	servings: z.number(),
	url: z.string(),
});
const StatusJson = z.object({
	request: z.object({ status: z.enum(["waiting", "opened"]), servings: z.number() }).nullable(),
	seenRecently: z.boolean(),
});

const get = (path: string, init?: RequestInit) => new Request(`http://kindle${path}`, init);

test("serves the cookbook with an ETag and answers 304 when nothing changed", async () => {
	const { handleKindleRequest } = await import("./kindle.ts");
	const first = await handleKindleRequest(get("/cookbook.epub"));
	expect(first.status).toBe(200);
	expect(first.headers.get("content-type")).toBe("application/epub+zip");
	const etag = first.headers.get("etag") ?? "";
	expect(etag).toMatch(/^"[0-9a-f]{40}"$/);

	const again = await handleKindleRequest(
		get("/cookbook.epub", { headers: { "If-None-Match": etag } }),
	);
	expect(again.status).toBe(304);

	const head = await handleKindleRequest(get("/cookbook.epub", { method: "HEAD" }));
	expect(head.status).toBe(200);
	expect(head.headers.get("etag")).toBe(etag);
	expect(await head.text()).toBe("");
});

test("open on Kindle: the request is picked up, served scaled, then marked opened", async () => {
	const { handleKindleRequest } = await import("./kindle.ts");
	const { handleUiRequest } = await import("./ui-server.ts");

	expect((await handleKindleRequest(get("/kindle/request"))).status).toBe(204);

	const sent = await handleUiRequest(
		new Request("http://x/api/kindle/open", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ recipe: "salmon-soup", servings: 4 }),
		}),
	);
	expect(sent.status).toBe(200);
	expect(StatusJson.parse(await sent.json()).request?.status).toBe("waiting");

	const polled = await handleKindleRequest(get("/kindle/request"));
	const request = RequestJson.parse(await polled.json());
	expect(request).toMatchObject({ recipe: "salmon-soup", servings: 4 });

	const book = await handleKindleRequest(get(request.url));
	expect(book.status).toBe(200);
	const { unzipFiles } = await import("./zip.ts");
	const files = unzipFiles(new Uint8Array(await book.arrayBuffer()));
	const page = new TextDecoder().decode(files.get("OEBPS/recipe.xhtml"));
	expect(page).toContain("Serves 4");
	expect(page).toContain("600 g");

	const opened = await handleKindleRequest(get(`/kindle/opened/${request.id}`, { method: "POST" }));
	expect(opened.status).toBe(204);
	expect((await handleKindleRequest(get("/kindle/request"))).status).toBe(204);

	const status = StatusJson.parse(
		await (await handleUiRequest(new Request("http://x/api/kindle/status"))).json(),
	);
	expect(status.request?.status).toBe("opened");
	expect(status.seenRecently).toBe(true);
});

test("a request nobody picks up expires", async () => {
	const { handleKindleRequest, requestOpenOnKindle } = await import("./kindle.ts");
	const sentAt = Date.now();
	await requestOpenOnKindle("salmon-soup", undefined, sentAt);
	expect((await handleKindleRequest(get("/kindle/request"), sentAt + 60_000)).status).toBe(200);
	expect((await handleKindleRequest(get("/kindle/request"), sentAt + 11 * 60_000)).status).toBe(
		204,
	);
});

test("the home-network listener serves nothing else", async () => {
	const { handleKindleRequest, requestOpenOnKindle } = await import("./kindle.ts");
	await requestOpenOnKindle("salmon-soup", undefined);
	for (const path of [
		"/",
		"/api/recipes",
		"/api/backup",
		"/kindle/recipe/salmon-soup.epub",
		"/kindle/recipe/00000000-0000-0000-0000-000000000000.epub",
		"/kindle/opened/00000000-0000-0000-0000-000000000000",
		"/cookbook.epub/../api/recipes",
	]) {
		const method = path.startsWith("/kindle/opened") ? "POST" : "GET";
		expect((await handleKindleRequest(get(path, { method }))).status).toBe(404);
	}
	expect((await handleKindleRequest(get("/cookbook.epub", { method: "POST" }))).status).toBe(404);
});

test("the app refuses unknown recipes and requests without JSON", async () => {
	const { handleUiRequest } = await import("./ui-server.ts");
	const missing = await handleUiRequest(
		new Request("http://x/api/kindle/open", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ recipe: "nope" }),
		}),
	);
	expect(missing.status).toBe(404);
	const form = await handleUiRequest(
		new Request("http://x/api/kindle/open", { method: "POST", body: "recipe=salmon-soup" }),
	);
	expect(form.status).toBe(415);
});

function planSnapshot(meals: Array<Record<string, unknown>>) {
	const emptyList = { total: 0, lines: [] };
	return {
		store: { chain: "s-kaupat" as const, storeId: "1" },
		meals: meals.map((m) => ({ name: "dinner", servings: 1, ingredients: [], steps: [], ...m })),
		toBuy: emptyList,
		pantry: emptyList,
		balance: { balanced: true, issues: [], counts: {} },
		nutrition: { average: null, missing: [] },
		missing: [],
		unquantified: [],
		waste: { leftoverValue: 0 },
		pooling: { saved: 0 },
	};
}

test("the dinner-menu display sends the evening it shows", async () => {
	const { savePlan } = await import("./plan-book.ts");
	const { handleKindleRequest, requestOpenDinner } = await import("./kindle.ts");
	await savePlan(
		"Dinners 16-17 Nov",
		planSnapshot([
			{
				name: "Mon 16 Nov dinner",
				dish: "Teriyaki chicken stir-fry",
				date: "2026-11-16",
				ingredients: [
					{ english: "chicken strips", finnish: ["kana"], quantity: { amount: 200, unit: "g" } },
				],
				steps: ["Fry the chicken", "Add the sauce"],
			},
			{ name: "Tue 17 Nov dinner", dish: "Salmon soup", date: "2026-11-17", servings: 4 },
			{ name: "Wed 18 Nov dinner", dish: "Leftovers", date: "2026-11-18" },
		]),
	);
	const now = new Date(2026, 10, 16, 17, 0).getTime();

	// A planned dinner never saved as a recipe goes over as its own book
	const tonight = await requestOpenDinner("Mon 16 Nov", now);
	expect(tonight.ok).toBe(true);
	expect(tonight.message).toBe("Open KOReader on the Kindle");
	const handed = RequestJson.parse(
		await (await handleKindleRequest(get("/kindle/request"), now)).json(),
	);
	expect(handed.recipe).toBe("plan-teriyaki-chicken-stir-fry");
	const book = await handleKindleRequest(get(handed.url), now);
	expect(book.status).toBe(200);
	expect(book.headers.get("content-type")).toBe("application/epub+zip");

	// A dish with a saved recipe sends that recipe, at the plan's servings, and the Kindle has just
	// asked, so it counts as listening
	const tomorrow = await requestOpenDinner("2026-11-17", now);
	expect(tomorrow).toMatchObject({ ok: true, message: "Sent to the Kindle" });
	if (tomorrow.ok) expect(tomorrow.request).toMatchObject({ recipe: "salmon-soup", servings: 4 });

	expect(await requestOpenDinner("Wed 18 Nov", now)).toEqual({
		ok: false,
		message: "No recipe for Wed 18 Nov",
	});
	expect(await requestOpenDinner("Thu 19 Nov", now)).toEqual({
		ok: false,
		message: "Nothing planned for Thu 19 Nov",
	});
	expect(await requestOpenDinner("someday", now)).toEqual({ ok: false, message: "Unknown day" });
});
