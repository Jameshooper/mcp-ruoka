import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

const RecipeJson = z.object({
	rating: z.number().optional(),
	review: z.string().optional(),
	ingredients: z.array(z.object({ quantity: z.object({ amount: z.number() }).optional() })),
});
const ListJson = z.object({ recipes: z.array(RecipeJson) });

let dir = "";

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-ui-"));
	process.env.RUOKA_DATA_DIR = dir;
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const recipe = {
	name: "Kanacurry",
	servings: 4,
	ingredients: [
		{ english: "rice", finnish: ["riisi"], quantity: { amount: 400, unit: "g" as const } },
	],
	steps: ["Cook"],
	tags: ["dinner"],
};

function put(path: string, body: unknown, contentType = "application/json") {
	return new Request(`http://x${path}`, {
		method: "PUT",
		headers: { "Content-Type": contentType },
		body: JSON.stringify(body),
	});
}

test("serves the page, lists, rates, scales and deletes", async () => {
	const { saveRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await saveRecipe(recipe);

	const page = await handleUiRequest(new Request("http://x/"));
	expect(page.headers.get("content-type")).toContain("text/html");
	expect(await page.text()).toContain("<title>Recipes</title>");

	const list = ListJson.parse(
		await (await handleUiRequest(new Request("http://x/api/recipes"))).json(),
	);
	expect(list.recipes).toHaveLength(1);

	const rated = await handleUiRequest(
		put("/api/recipes/kanacurry/rating", { rating: 4, review: "Good" }),
	);
	expect(rated.status).toBe(200);
	expect(RecipeJson.parse(await rated.json()).rating).toBe(4);

	const scaled = RecipeJson.parse(
		await (await handleUiRequest(new Request("http://x/api/recipes/kanacurry?servings=8"))).json(),
	);
	expect(scaled.ingredients[0]?.quantity?.amount).toBe(800);
	expect(scaled.rating).toBe(4);

	const cleared = RecipeJson.parse(
		await (await handleUiRequest(put("/api/recipes/kanacurry/rating", { rating: null }))).json(),
	);
	expect(cleared.rating).toBeUndefined();
	expect(cleared.review).toBe("Good");

	const del = await handleUiRequest(
		new Request("http://x/api/recipes/kanacurry", { method: "DELETE" }),
	);
	expect(del.status).toBe(200);
	expect((await handleUiRequest(new Request("http://x/api/recipes/kanacurry"))).status).toBe(404);
});

test("rejects bad ratings, non-JSON bodies and unknown paths", async () => {
	const { saveRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await saveRecipe(recipe);

	expect((await handleUiRequest(put("/api/recipes/kanacurry/rating", { rating: 9 }))).status).toBe(
		400,
	);
	expect(
		(await handleUiRequest(put("/api/recipes/kanacurry/rating", { rating: 3 }, "text/plain")))
			.status,
	).toBe(415);
	expect((await handleUiRequest(put("/api/recipes/nope/rating", { rating: 3 }))).status).toBe(404);
	expect((await handleUiRequest(new Request("http://x/elsewhere"))).status).toBe(404);
});

test("re-saving a recipe keeps its rating", async () => {
	const { saveRecipe, rateRecipe, findRecipe } = await import("./recipe-book.ts");
	await saveRecipe(recipe);
	await rateRecipe("kanacurry", 5, "Great");
	await saveRecipe({ ...recipe, notes: "tweaked" });
	const again = await findRecipe("kanacurry");
	expect(again?.rating).toBe(5);
	expect(again?.review).toBe("Great");
	expect(again?.notes).toBe("tweaked");
});

const SNAPSHOT = {
	store: { chain: "s-kaupat" as const, storeId: "1", name: "Prisma Linnainmaa" },
	budget: 30,
	meals: [
		{
			name: "Mon",
			dish: "Rice bowl",
			servings: 2,
			steps: ["Cook"],
			cost: { total: 1.6, perPortion: 0.8, complete: true },
			prepMinutes: 10,
			cookMinutes: 35,
			ingredients: [
				{ english: "rice", finnish: ["riisi"], quantity: { amount: 200, unit: "g" as const } },
			],
		},
	],
	toBuy: {
		total: 2.75,
		lines: [
			{
				ingredient: "rice",
				needed: "200 g",
				product: "Rice 1 kg",
				productId: "211",
				url: null,
				packSize: "1 kg",
				packages: 1,
				unitPrice: "2,75 €/kg",
				cost: 2.75,
				leftover: "800 g",
				leftoverValue: 2.2,
				usedIn: ["Mon: 200 g"],
				location: { aisle: "45", floor: 1 },
			},
		],
	},
	pantry: { total: 0, lines: [] },
	balance: { balanced: true, issues: [], counts: { fish: 1 } },
	nutrition: { average: null, missing: ["Mon"] },
	missing: [],
	unquantified: [],
	waste: { leftoverValue: 2.2 },
	pooling: { saved: 0 },
};

test("meal plans can be listed, ticked off and deleted", async () => {
	const { savePlan } = await import("./plan-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await savePlan("Week 42", SNAPSHOT);

	const PlansJson = z.object({
		plans: z.array(z.object({ id: z.string(), checked: z.array(z.string()) })),
	});
	const list = PlansJson.parse(
		await (await handleUiRequest(new Request("http://x/api/plans"))).json(),
	);
	expect(list.plans.map((p) => p.id)).toContain("week-42");

	const ticked = z
		.object({ checked: z.array(z.string()) })
		.parse(
			await (
				await handleUiRequest(put("/api/plans/week-42/checked", { checked: ["211", "x"] }))
			).json(),
		);
	expect(ticked.checked).toEqual(["211"]);

	expect(
		(await handleUiRequest(put("/api/plans/week-42/checked", { checked: [] }, "text/plain")))
			.status,
	).toBe(415);
	expect((await handleUiRequest(put("/api/plans/nope/checked", { checked: [] }))).status).toBe(404);

	const del = await handleUiRequest(
		new Request("http://x/api/plans/week-42", { method: "DELETE" }),
	);
	expect(del.status).toBe(200);
	expect((await handleUiRequest(new Request("http://x/api/plans/week-42"))).status).toBe(404);
});

test("a plan can be rated, and a meal saved as a recipe and linked", async () => {
	const { savePlan, findPlan } = await import("./plan-book.ts");
	const { findRecipe, deleteRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await savePlan("Rate me", SNAPSHOT);

	const rated = z
		.object({ rating: z.number().optional(), review: z.string().optional() })
		.parse(
			await (
				await handleUiRequest(put("/api/plans/rate-me/rating", { rating: 5, review: "Great week" }))
			).json(),
		);
	expect(rated).toEqual({ rating: 5, review: "Great week" });
	expect((await handleUiRequest(put("/api/plans/rate-me/rating", { rating: 7 }))).status).toBe(400);

	// re-saving the plan keeps the rating
	await savePlan("Rate me", SNAPSHOT);
	expect((await findPlan("rate-me"))?.rating).toBe(5);

	const post = (body: unknown) =>
		handleUiRequest(
			new Request("http://x/api/plans/rate-me/meals/0/recipe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	const saved = await post({ name: "Rice bowl special" });
	expect(saved.status).toBe(200);
	const recipe = await findRecipe("rice-bowl-special");
	expect(recipe?.servings).toBe(2);
	expect(recipe?.steps).toEqual(["Cook"]);
	expect([recipe?.prepMinutes, recipe?.cookMinutes]).toEqual([10, 35]);
	expect(recipe?.ingredients[0]?.finnish).toEqual(["riisi"]);
	// the price at the time of the plan stays with the recipe
	expect(recipe?.estimatedCost).toMatchObject({
		total: 1.6,
		perPortion: 0.8,
		chain: "s-kaupat",
		storeId: "1",
		storeName: "Prisma Linnainmaa",
		complete: true,
	});
	expect(recipe?.estimatedCost?.pricedAt).toBe((await findPlan("rate-me"))?.updatedAt);
	expect((await findPlan("rate-me"))?.meals[0]?.recipe).toBe("rice-bowl-special");

	// a name that already exists is not replaced unless asked
	const clash = await post({ name: "Rice bowl special" });
	expect(clash.status).toBe(409);
	expect((await post({ name: "Rice bowl special", replace: true })).status).toBe(200);
	expect(
		(
			await handleUiRequest(
				new Request("http://x/api/plans/rate-me/meals/9/recipe", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				}),
			)
		).status,
	).toBe(404);

	await deleteRecipe("rice-bowl-special");
});

test("remembered store names are served for display", async () => {
	const { rememberStores } = await import("./store-names.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await rememberStores([{ chain: "s-kaupat", id: "613756972", name: "Prisma Linnainmaa" }]);
	const body = z
		.object({ names: z.record(z.string(), z.string()) })
		.parse(await (await handleUiRequest(new Request("http://x/api/stores"))).json());
	expect(body.names["s-kaupat:613756972"]).toBe("Prisma Linnainmaa");
});

test("serves the app manifest and only the listed icons", async () => {
	const { handleUiRequest } = await import("./ui-server.ts");
	const manifest = z
		.object({
			display: z.string(),
			start_url: z.string(),
			icons: z.array(z.object({ src: z.string() })),
		})
		.parse(await (await handleUiRequest(new Request("http://x/manifest.webmanifest"))).json());
	expect(manifest.display).toBe("standalone");
	expect(manifest.start_url).toBe("./");

	const icon = await handleUiRequest(new Request("http://x/icons/apple-touch-icon.png"));
	expect(icon.status).toBe(200);
	expect(icon.headers.get("content-type")).toContain("image/png");
	for (const bad of ["/icons/secret.png", "/icons/..%2findex.html", "/icons/icon-192.png/extra"]) {
		expect((await handleUiRequest(new Request(`http://x${bad}`))).status).toBe(404);
	}
});

test("the standalone listener only admits allowed Tailscale logins", async () => {
	const { isAllowedTailnetUser } = await import("./ui-server.ts");
	const allowed = ["james@example.com"];
	expect(
		isAllowedTailnetUser(new Headers({ "Tailscale-User-Login": "James@Example.com" }), allowed),
	).toBe(true);
	expect(
		isAllowedTailnetUser(new Headers({ "Tailscale-User-Login": "other@example.com" }), allowed),
	).toBe(false);
	expect(isAllowedTailnetUser(new Headers(), allowed)).toBe(false);
	expect(isAllowedTailnetUser(new Headers({ "Tailscale-User-Login": "" }), allowed)).toBe(false);
});

test("the config endpoint gives the buttons that open Claude their defaults", async () => {
	const { handleUiRequest } = await import("./ui-server.ts");
	const Config = z.object({
		defaultStore: z
			.object({ chain: z.string(), id: z.string(), name: z.string().nullable() })
			.nullable(),
		promptNote: z.string(),
	});
	delete process.env.RUOKA_DEFAULT_STORE_ID;
	expect(
		Config.parse(await (await handleUiRequest(new Request("http://x/api/config"))).json())
			.defaultStore,
	).toBeNull();

	process.env.RUOKA_DEFAULT_STORE_ID = "613756972";
	process.env.RUOKA_DEFAULT_STORE_NAME = "Prisma Linnainmaa";
	process.env.RUOKA_CLAUDE_NOTE = "Avoid cashew.";
	const config = Config.parse(
		await (await handleUiRequest(new Request("http://x/api/config"))).json(),
	);
	expect(config.defaultStore).toEqual({
		chain: "s-kaupat",
		id: "613756972",
		name: "Prisma Linnainmaa",
	});
	expect(config.promptNote).toBe("Avoid cashew.");
	delete process.env.RUOKA_DEFAULT_STORE_ID;
	delete process.env.RUOKA_DEFAULT_STORE_NAME;
	delete process.env.RUOKA_CLAUDE_NOTE;
});

test("the backup can be downloaded, previewed and imported over HTTP", async () => {
	const { handleUiRequest } = await import("./ui-server.ts");
	const { saveRecipe, deleteRecipe, findRecipe } = await import("./recipe-book.ts");
	await saveRecipe(recipe);

	const download = await handleUiRequest(new Request("http://x/api/backup"));
	expect(download.headers.get("content-type")).toBe("application/zip");
	expect(download.headers.get("content-disposition")).toContain("ruoka-backup-");
	const bytes = new Uint8Array(await download.arrayBuffer());
	await deleteRecipe("kanacurry");

	const post = (path: string, body: Uint8Array | string, type = "application/zip") =>
		handleUiRequest(
			new Request(`http://x${path}`, { method: "POST", headers: { "Content-Type": type }, body }),
		);

	const preview = z
		.object({ recipes: z.object({ total: z.number(), new: z.number() }).nullable() })
		.parse(await (await post("/api/backup/preview", bytes)).json());
	expect(preview.recipes?.new).toBeGreaterThan(0);

	expect((await post("/api/backup/preview", bytes, "text/plain")).status).toBe(415);
	expect((await post("/api/backup/import?mode=oops", bytes)).status).toBe(400);
	expect((await post("/api/backup/preview", "not a zip")).status).toBe(400);

	const done = await post("/api/backup/import?mode=add", bytes);
	expect(done.status).toBe(200);
	expect(await findRecipe("kanacurry")).toBeDefined();
});

test("saved backups are listed and downloadable, and names cannot escape the folder", async () => {
	const { handleUiRequest } = await import("./ui-server.ts");
	const { saveDailyBackup } = await import("./backup.ts");
	const { saveRecipe } = await import("./recipe-book.ts");
	await saveRecipe(recipe);
	await saveDailyBackup(new Date("2026-02-01T10:00:00Z"));

	const listed = z
		.object({ backups: z.array(z.object({ name: z.string(), kind: z.string() })) })
		.parse(await (await handleUiRequest(new Request("http://x/api/backups"))).json());
	expect(listed.backups.map((b) => b.name)).toContain("ruoka-daily-2026-02-01.zip");

	const file = await handleUiRequest(
		new Request("http://x/api/backups/ruoka-daily-2026-02-01.zip"),
	);
	expect(file.status).toBe(200);
	expect(file.headers.get("content-type")).toBe("application/zip");

	expect((await handleUiRequest(new Request("http://x/api/backups/recipes.json"))).status).toBe(
		404,
	);
	expect(
		(await handleUiRequest(new Request("http://x/api/backups/..%2Frecipes.json"))).status,
	).toBe(404);
});

test("other websites cannot make changes, even with a body that looks like JSON", async () => {
	const { savePlan } = await import("./plan-book.ts");
	const { findRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest, isCrossSiteChange } = await import("./ui-server.ts");
	await savePlan("Csrf target", SNAPSHOT);
	const attempt = (headers: Record<string, string>) =>
		handleUiRequest(
			new Request("https://ruoka.example.ts.net:8443/api/plans/csrf-target/meals/0/recipe", {
				method: "POST",
				headers,
				body: JSON.stringify({ name: "Planted", replace: true }),
			}),
		);

	// a form or fetch from another site without a preflight
	expect(
		(await attempt({ "Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site" })).status,
	).toBe(403);
	// another tailnet host counts as another site too
	expect(
		(await attempt({ "Content-Type": "text/plain", "Sec-Fetch-Site": "same-site" })).status,
	).toBe(403);
	// a client that sends no browser label but a foreign Origin
	expect(
		(await attempt({ "Content-Type": "text/plain", Origin: "https://evil.example" })).status,
	).toBe(403);
	// no label, no origin, but not JSON either
	expect((await attempt({ "Content-Type": "text/plain" })).status).toBe(415);
	expect(await findRecipe("planted")).toBeUndefined();

	// the app's own page still works
	expect(
		(await attempt({ "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" })).status,
	).toBe(200);

	const notify = (headers: Record<string, string>) =>
		handleUiRequest(new Request("http://x/api/notify/test", { method: "POST", headers }));
	expect((await notify({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
	expect((await notify({})).status).toBe(415);

	// reading is never refused: the browser already keeps other sites from seeing the answer
	expect(
		isCrossSiteChange(
			new Request("http://x/api/recipes", { headers: { "Sec-Fetch-Site": "cross-site" } }),
		),
	).toBe(false);
	expect(
		isCrossSiteChange(
			new Request("http://x/api/recipes/x", { method: "DELETE", headers: { Origin: "null" } }),
		),
	).toBe(true);
	expect(
		isCrossSiteChange(
			new Request("http://x/api/recipes/x", { method: "DELETE", headers: { Origin: "http://x" } }),
		),
	).toBe(false);
});

// INP-03
test("hostile paths give a clean 400 or 404, never a file or a crash", async () => {
	const { saveRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await saveRecipe(recipe);
	const statusOf = async (path: string, method = "GET") =>
		(await handleUiRequest(new Request(`http://x${path}`, { method }))).status;

	for (const path of [
		"/api/recipes/%E0%A4%A",
		"/api/plans/%ZZ",
		"/api/backups/%E0%A4%A",
		"/api/plans/%E0/rating",
	]) {
		expect(await statusOf(path)).toBe(400);
	}
	for (const path of [
		"/icons/..%2Findex.html",
		"/api/backups/..%2Frecipes.json",
		"/api/backups/ruoka-daily-x.zip%00.json",
		"/api/recipes/..%2F..%2Fetc%2Fpasswd",
		`/api/recipes/${"a".repeat(5000)}`,
	]) {
		expect([400, 404]).toContain(await statusOf(path));
	}
	expect(await statusOf("/api/recipes/%E0%A4%A", "DELETE")).toBe(400);
});

// API-01
test("unexpected methods are refused and change nothing", async () => {
	const { saveRecipe, listRecipes } = await import("./recipe-book.ts");
	const { savePlan, listPlans } = await import("./plan-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await saveRecipe(recipe);
	await savePlan("Method target", SNAPSHOT);
	const before = JSON.stringify([await listRecipes(), await listPlans()]);
	const json = { "Content-Type": "application/json" };
	const attempts: Array<[string, string]> = [
		["POST", "/api/recipes/kanacurry"],
		["PUT", "/api/recipes/kanacurry"],
		["PATCH", "/api/recipes/kanacurry/rating"],
		["DELETE", "/api/recipes/kanacurry/rating"],
		["PUT", "/api/plans/method-target"],
		["POST", "/api/plans/method-target/checked"],
		["DELETE", "/api/plans/method-target/rating"],
		["DELETE", "/api/backup"],
		["PUT", "/api/backups/ruoka-daily-2026-01-01.zip"],
	];
	for (const [method, path] of attempts) {
		const response = await handleUiRequest(
			new Request(`http://x${path}`, { method, headers: json, body: "{}" }),
		);
		expect([404, 405]).toContain(response.status);
	}
	expect(JSON.stringify([await listRecipes(), await listPlans()])).toBe(before);
});

// API-06
test("request bodies cannot set fields beyond the ones each endpoint allows", async () => {
	const { saveRecipe, findRecipe } = await import("./recipe-book.ts");
	const { savePlan, findPlan } = await import("./plan-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await saveRecipe(recipe);
	const original = await findRecipe("kanacurry");
	await handleUiRequest(
		put("/api/recipes/kanacurry/rating", {
			rating: 5,
			id: "hijacked",
			name: "Renamed",
			createdAt: "1999-01-01T00:00:00.000Z",
			steps: [],
			servings: 99,
		}),
	);
	const after = await findRecipe("kanacurry");
	expect(after?.rating).toBe(5);
	expect([after?.id, after?.name, after?.createdAt, after?.servings]).toEqual([
		original?.id,
		original?.name,
		original?.createdAt,
		original?.servings,
	]);
	expect(after?.steps).toEqual(original?.steps);
	expect(await findRecipe("hijacked")).toBeUndefined();

	await savePlan("Mass target", SNAPSHOT);
	const ticked = z
		.object({ checked: z.array(z.string()) })
		.parse(
			await (
				await handleUiRequest(
					put("/api/plans/mass-target/checked", { checked: ["211", "999", "../x"] }),
				)
			).json(),
		);
	// only products that are on the plan's list can be ticked
	expect(ticked.checked).toEqual(["211"]);
	await handleUiRequest(
		put("/api/plans/mass-target/rating", { rating: 4, name: "Other", meals: [] }),
	);
	const plan = await findPlan("mass-target");
	expect([plan?.rating, plan?.name, plan?.meals.length]).toEqual([4, "Mass target", 1]);
});

// INP-06
test("scaling only accepts the same servings range a recipe can have", async () => {
	const { saveRecipe } = await import("./recipe-book.ts");
	const { handleUiRequest } = await import("./ui-server.ts");
	await saveRecipe(recipe);
	const amountAt = async (servings: string) =>
		RecipeJson.parse(
			await (
				await handleUiRequest(new Request(`http://x/api/recipes/kanacurry?servings=${servings}`))
			).json(),
		).ingredients[0]?.quantity?.amount;
	expect(await amountAt("100")).toBe(10_000);
	for (const servings of ["101", "1e308", "100000", "-4", "0", "2.5", "abc"]) {
		expect(await amountAt(servings)).toBe(400);
	}
});

// INP-07
test("plans whose names slugify alike stay separate", async () => {
	const { savePlan, listPlans } = await import("./plan-book.ts");
	const first = await savePlan("Week 1", SNAPSHOT);
	const second = await savePlan("Week 1!", SNAPSHOT);
	expect(second.replaced).toBe(false);
	expect(second.plan.id).toBe(`${first.plan.id}-2`);
	const again = await savePlan("WEEK 1", SNAPSHOT);
	expect([again.replaced, again.plan.id]).toEqual([true, first.plan.id]);
	expect(
		(await listPlans())
			.filter((p) => p.name.toLowerCase().startsWith("week 1"))
			.map((p) => p.name)
			.sort(),
	).toEqual(["WEEK 1", "Week 1!"]);
});

// AZ-02, SESS-05, SESS-06, SESS-07
test("each front door checks its own identity and sends the right protective headers", async () => {
	const { createIngressFetch, createStandaloneFetch } = await import("./ui-server.ts");
	const ingress = createIngressFetch(false);
	const page = new Request("http://x/", { headers: { Origin: "https://evil.example" } });

	for (const peer of ["127.0.0.1", "172.30.32.1", "172.30.33.5", "192.168.1.10", undefined]) {
		expect((await ingress(page, peer)).status).toBe(403);
	}
	const viaIngress = await ingress(page, "172.30.32.2");
	expect(viaIngress.status).toBe(200);
	expect(viaIngress.headers.get("x-content-type-options")).toBe("nosniff");
	// Home Assistant shows the panel in its own page, so ingress must stay frameable
	expect(viaIngress.headers.get("x-frame-options")).toBeNull();

	const standalone = createStandaloneFetch(["owner@example.com"]);
	const asOwner = (path: string, init: RequestInit = {}) =>
		standalone(
			new Request(`https://ruoka.example.ts.net:8443${path}`, {
				...init,
				headers: { "Tailscale-User-Login": "owner@example.com", ...init.headers },
			}),
		);
	const app = await asOwner("/");
	expect(app.status).toBe(200);
	expect(app.headers.get("x-frame-options")).toBe("DENY");
	expect(app.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
	expect(
		(await standalone(new Request("https://ruoka.example.ts.net:8443/api/recipes"))).status,
	).toBe(403);
	expect(
		(
			await standalone(
				new Request("https://ruoka.example.ts.net:8443/api/recipes", {
					headers: { "Tailscale-User-Login": "someone@else.com" },
				}),
			)
		).status,
	).toBe(403);
	// a browser's preflight carries no login header, so a foreign page cannot add one
	expect(
		(
			await standalone(
				new Request("https://ruoka.example.ts.net:8443/api/recipes", {
					method: "OPTIONS",
					headers: {
						Origin: "https://evil.example",
						"Access-Control-Request-Headers": "tailscale-user-login",
					},
				}),
			)
		).status,
	).toBe(403);

	// no route grants cross-origin reads or sets cookies
	for (const path of [
		"/",
		"/api/recipes",
		"/api/plans",
		"/api/config",
		"/api/stores",
		"/api/backups",
		"/api/backup",
	]) {
		const response = await asOwner(path, { headers: { Origin: "https://evil.example" } });
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(response.headers.get("set-cookie")).toBeNull();
		await response.body?.cancel();
	}
});

// CONF-04, DEV-01
test("the Supervisor token and other secrets never appear in answers, backups or logs", async () => {
	const canaries = {
		SUPERVISOR_TOKEN: "canary-supervisor-7f3a",
		OAUTH_CLIENT_SECRET_CANARY: "canary-oauth-secret-91c2",
		MCP_AUTH_TOKEN_CANARY: "canary-static-token-55d0",
	};
	const saved = { ...process.env };
	Object.assign(process.env, canaries, { RUOKA_NOTIFY_SERVICE: "notify.mobile_app_phone" });
	const lines: string[] = [];
	const realFetch = globalThis.fetch;
	const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
		lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	const seen: string[] = [];
	try {
		const { saveRecipe } = await import("./recipe-book.ts");
		const { handleUiRequest } = await import("./ui-server.ts");
		const { resetNotifyCooldowns } = await import("./notify.ts");
		const { unzipFiles } = await import("./zip.ts");
		await saveRecipe(recipe);
		// the Supervisor failing in every way the notify code handles
		for (const answer of [
			() => new Response("no", { status: 401 }),
			() => new Response("err", { status: 500 }),
			() => {
				throw new Error("down");
			},
		]) {
			resetNotifyCooldowns();
			globalThis.fetch = Object.assign(async () => answer(), { preconnect: () => {} });
			const r = await handleUiRequest(
				new Request("http://x/api/notify/test", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				}),
			);
			seen.push(await r.text());
		}
		globalThis.fetch = realFetch;
		for (const path of [
			"/",
			"/api/recipes",
			"/api/config",
			"/api/stores",
			"/api/plans",
			"/api/backups",
			"/api/recipes/kanacurry",
		]) {
			seen.push(await (await handleUiRequest(new Request(`http://x${path}`))).text());
		}
		const backup = await handleUiRequest(new Request("http://x/api/backup"));
		const files = unzipFiles(new Uint8Array(await backup.arrayBuffer()));
		expect([...files.keys()].sort()).toEqual([
			"manifest.json",
			"plans.json",
			"recipes.json",
			"stores.json",
		]);
		for (const data of files.values()) seen.push(new TextDecoder().decode(data));
	} finally {
		stderr.mockRestore();
		globalThis.fetch = realFetch;
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
	const everything = [...seen, ...lines].join("\n");
	for (const canary of Object.values(canaries)) expect(everything).not.toContain(canary);
});
