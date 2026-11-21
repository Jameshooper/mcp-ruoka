import { join } from "node:path";
import * as z from "zod/v4";
import {
	applyBackup,
	BackupError,
	backupFilePath,
	buildBackup,
	listBackupFiles,
	previewBackup,
} from "./backup.ts";
import { addInstagramDraft, deleteDraft, listDrafts } from "./draft-book.ts";
import {
	cookStatus,
	startCook,
	startManual,
	stopCook,
	stopManual,
} from "./home-assistant/sous-vide.ts";
import { fetchInstagramPost, isInstagramLink } from "./instagram.ts";
import {
	kindleStatus,
	requestOpenInstagram,
	requestOpenOnKindle,
	requestOpenWebRecipe,
} from "./kindle/send.ts";
import { logger } from "./logger.ts";
import { sendNotification } from "./notify.ts";
import {
	deletePlan,
	findPlan,
	linkMealRecipe,
	listPlans,
	ratePlan,
	setChecked,
} from "./plan-book.ts";
import {
	deleteRecipe,
	findRecipe,
	listRecipes,
	type RecipeInput,
	rateRecipe,
	saveRecipe,
	scaleRecipe,
} from "./recipe-book.ts";
import { ImportModeSchema } from "./schemas.ts";
import {
	findPreset,
	ManualBathSchema,
	resolveSousVide,
	SOUS_VIDE_PRESETS,
	SousVideOverridesSchema,
} from "./sous-vide.ts";
import { getStoreNames } from "./store-names.ts";
import { IMPORT_TAG, webRecipeToInput } from "./web-import.ts";
import { fetchWebRecipe, type WebFetch, WebRecipeError } from "./web-recipe.ts";

// Replaced in tests so no real site is contacted
let webFetch: WebFetch = fetch;
export function setWebFetchForTests(fn: WebFetch): void {
	webFetch = fn;
}

const uiDir = join(import.meta.dirname, "ui");
const indexPath = join(uiDir, "index.html");

// Home-screen app description. URLs are relative so it works behind Home Assistant's ingress
// prefix as well as at the root of the standalone address.
const MANIFEST = {
	name: "Ruoka",
	short_name: "Ruoka",
	description: "Recipes, meal plans and shopping lists",
	start_url: "./",
	scope: "./",
	display: "standalone",
	background_color: "#f4f1ec",
	theme_color: "#f4f1ec",
	icons: [
		{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
		{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
	],
};

// Only these icon files are served, so a path can never reach anything else on disk
const ICON_RE = /^\/icons\/(apple-touch-icon\.png|icon-192\.png|icon-512\.png|icon\.svg)$/;

const SaveMealBodySchema = z.object({
	name: z.string().min(1).max(120).optional(),
	replace: z.boolean().optional(),
});

const CheckedBodySchema = z.object({ checked: z.array(z.string()).max(200) });

const KindleOpenBodySchema = z.object({
	recipe: z.string().min(1).max(200),
	servings: z.number().int().positive().max(100).optional(),
});

const ManualBodySchema = z.union([
	ManualBathSchema.extend({ on: z.literal(true) }),
	z.object({ on: z.literal(false) }),
]);

// Either a saved recipe, or a preset with the cook's adjustments (thickness of the actual cut)
// meater: false times the cook from Baldwin's table in Home Assistant instead of the probe
const SousVideStartBodySchema = z.union([
	z.object({ recipe: z.string().min(1).max(200), meater: z.boolean().optional() }),
	SousVideOverridesSchema.extend({
		preset: z.string().min(1).max(60),
		meater: z.boolean().optional(),
	}),
]);

const KindleUrlBodySchema = z.object({ url: z.string().min(1).max(2000) });

const RatingBodySchema = z.object({
	rating: z.number().int().min(1).max(5).nullable(),
	review: z.string().max(2000).optional(),
});

// The iPhone Shortcut reads `message` only from a successful answer (it shows an error answer as
// raw JSON), so share-sheet answers are always HTTP 200 with `ok` saying whether it worked
function shareReply(ok: boolean, message: string, extra: Record<string, unknown> = {}): Response {
	return json({ ok, message, ...(ok ? {} : { error: message }), ...extra });
}

function shareError(error: WebRecipeError): Response {
	return shareReply(false, error.message, { status: error.status });
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// A malformed escape (e.g. "%E0%A4%A") makes decodeURIComponent throw; that is the caller's mistake
class BadPathError extends Error {}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new BadPathError("Malformed path");
	}
}

// Same limit as a recipe's own servings
const MAX_SCALED_SERVINGS = 100;

// Saves one meal of a plan to the recipe book and links the meal to it. An existing recipe with
// the same name is only replaced when the caller says so.
async function saveMealAsRecipe(
	planId: string,
	mealIndex: number,
	payload: unknown,
): Promise<Response> {
	const body = SaveMealBodySchema.safeParse(payload);
	if (!body.success) return json({ error: "Invalid request" }, 400);
	const plan = await findPlan(planId);
	const meal = plan?.meals[mealIndex];
	if (!plan || !meal) return json({ error: "Meal not found" }, 404);
	if (meal.ingredients.length === 0) {
		return json(
			{ error: "This meal has no ingredients saved; re-run the plan and save it again" },
			400,
		);
	}

	const name = body.data.name ?? meal.dish ?? meal.name;
	if (!body.data.replace && (await findRecipe(name))) {
		return json({ error: `A recipe called "${name}" already exists`, exists: true }, 409);
	}

	const n = meal.nutrition;
	// A partial figure undercounts, so it is not stored as the recipe's nutrition
	const nutrition =
		n && n.carbsG !== undefined && n.fatG !== undefined && !n.partial
			? {
					kcal: n.kcal,
					proteinG: n.proteinG,
					carbsG: n.carbsG,
					fatG: n.fatG,
					...(n.source && { source: n.source }),
				}
			: undefined;
	// The price the meal had when the plan was priced, kept with the recipe
	const estimatedCost = meal.cost
		? {
				total: meal.cost.total,
				perPortion: meal.cost.perPortion,
				chain: plan.store.chain,
				storeId: plan.store.storeId,
				...(plan.store.name && { storeName: plan.store.name }),
				pricedAt: plan.updatedAt,
				...(meal.cost.complete !== undefined && { complete: meal.cost.complete }),
			}
		: undefined;
	const input: RecipeInput = {
		name,
		servings: meal.servings,
		ingredients: meal.ingredients,
		steps: meal.steps,
		tags: [],
		...(meal.prepMinutes !== undefined && { prepMinutes: meal.prepMinutes }),
		...(meal.cookMinutes !== undefined && { cookMinutes: meal.cookMinutes }),
		...(meal.protein && { protein: meal.protein }),
		...(meal.vegetables !== undefined && { vegetables: meal.vegetables }),
		...(nutrition && { nutrition }),
		...(estimatedCost && { estimatedCost }),
	};
	const { recipe } = await saveRecipe(input);
	const updated = await linkMealRecipe(plan.id, mealIndex, recipe.id);
	return json({ recipe, plan: updated });
}

const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

// A zip content type forces a CORS preflight, so other sites cannot upload a file blindly
async function handleBackupUpload(req: Request, apply: boolean, url: URL): Promise<Response> {
	if (!req.headers.get("content-type")?.includes("application/zip")) {
		return json({ error: "Expected a zip file" }, 415);
	}
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.length === 0 || bytes.length > MAX_BACKUP_BYTES) {
		return json({ error: "The file is empty or too large" }, 413);
	}
	try {
		if (!apply) return json(await previewBackup(bytes));
		const mode = ImportModeSchema.safeParse(url.searchParams.get("mode"));
		if (!mode.success) return json({ error: "Mode must be add, update or replace" }, 400);
		return json(await applyBackup(bytes, mode.data));
	} catch (error) {
		if (error instanceof BackupError) return json({ error: error.message }, 400);
		throw error;
	}
}

// Browsers label every request with where it came from. Changes are only accepted from the app's
// own pages: on the standalone address Tailscale vouches for every request from your device, so a
// web page you visit could otherwise make changes in your name. Clients that send no label (curl,
// older browsers, proxies that drop it) are judged by Origin instead.
export function isCrossSiteChange(req: Request): boolean {
	if (req.method === "GET" || req.method === "HEAD") return false;
	const site = req.headers.get("sec-fetch-site");
	if (site) return site !== "same-origin" && site !== "none";
	const origin = req.headers.get("origin");
	if (!origin || origin === "null") return origin === "null";
	try {
		return new URL(origin).host !== new URL(req.url).host;
	} catch {
		return true;
	}
}

// Paths are relative so the page works behind Home Assistant's ingress prefix
export async function handleUiRequest(req: Request): Promise<Response> {
	try {
		return await routeUiRequest(req);
	} catch (error) {
		if (error instanceof BadPathError) return json({ error: error.message }, 400);
		throw error;
	}
}

async function routeUiRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.replace(/\/+$/, "") || "/";

	if (isCrossSiteChange(req)) {
		logger.warn({ method: req.method, path }, "Refused a cross-site change to the recipe app");
		return json({ error: "Cross-site requests are not allowed" }, 403);
	}

	if (req.method === "GET" && (path === "/" || path === "/index.html")) {
		return new Response(Bun.file(indexPath), {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	}

	if (path === "/api/recipes" && req.method === "GET") {
		return json({ recipes: await listRecipes() });
	}

	if (req.method === "GET" && path === "/manifest.webmanifest") {
		return new Response(JSON.stringify(MANIFEST), {
			headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" },
		});
	}

	if (req.method === "GET" && ICON_RE.test(path)) {
		return new Response(Bun.file(join(uiDir, path)), {
			headers: { "Cache-Control": "public, max-age=86400" },
		});
	}

	if (path === "/api/backup" && req.method === "GET") {
		const { bytes } = await buildBackup();
		const day = new Date().toISOString().slice(0, 10);
		return new Response(bytes, {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="ruoka-backup-${day}.zip"`,
				"Cache-Control": "no-store",
			},
		});
	}

	if (path === "/api/notify/test" && req.method === "POST") {
		if (!req.headers.get("content-type")?.includes("application/json")) {
			return json({ error: "Expected JSON" }, 415);
		}
		const result = await sendNotification(
			"test",
			"Ruoka: test notification",
			"Security alerts from the Ruoka app will arrive like this.",
		);
		return json(result, result.ok ? 200 : 502);
	}

	if (path === "/api/backups" && req.method === "GET") {
		return json({ backups: await listBackupFiles() });
	}

	const backupFile = /^\/api\/backups\/([^/]+)$/.exec(path);
	if (backupFile?.[1] && req.method === "GET") {
		const name = decodeSegment(backupFile[1]);
		const file = backupFilePath(name);
		if (!file || !(await Bun.file(file).exists())) return json({ error: "Backup not found" }, 404);
		return new Response(Bun.file(file), {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${name}"`,
				"Cache-Control": "no-store",
			},
		});
	}

	if ((path === "/api/backup/preview" || path === "/api/backup/import") && req.method === "POST") {
		return handleBackupUpload(req, path.endsWith("/import"), url);
	}

	if (path === "/api/config" && req.method === "GET") {
		// Defaults the buttons that open Claude put into their messages, since a new chat does not
		// carry the project instructions
		const id = process.env.RUOKA_DEFAULT_STORE_ID;
		return json({
			defaultStore: id
				? { chain: "s-kaupat", id, name: process.env.RUOKA_DEFAULT_STORE_NAME ?? null }
				: null,
			promptNote: process.env.RUOKA_CLAUDE_NOTE ?? "",
		});
	}

	if (path === "/api/stores" && req.method === "GET") {
		return json({ names: await getStoreNames() });
	}

	if (path === "/api/kindle/status" && req.method === "GET") {
		return json(kindleStatus());
	}

	if (path === "/api/sous-vide/presets" && req.method === "GET") {
		return json({ presets: SOUS_VIDE_PRESETS });
	}

	if (path === "/api/sous-vide/status" && req.method === "GET") {
		const status = await cookStatus();
		return "error" in status ? json(status, 503) : json(status);
	}

	if (path === "/api/sous-vide/manual" && req.method === "POST") {
		if (!req.headers.get("content-type")?.includes("application/json")) {
			return json({ error: "Expected JSON" }, 415);
		}
		const body = ManualBodySchema.safeParse(await req.json().catch(() => null));
		if (!body.success) return json({ error: "Invalid request" }, 400);
		const result = body.data.on
			? await startManual(body.data.bathC, body.data.minutes)
			: await stopManual();
		return result.ok ? json({ ok: true }) : json({ error: result.error }, 502);
	}

	if (
		(path === "/api/sous-vide/start" || path === "/api/sous-vide/stop") &&
		req.method === "POST"
	) {
		// A JSON content type forces a CORS preflight, so other sites cannot switch the cooker on
		if (!req.headers.get("content-type")?.includes("application/json")) {
			return json({ error: "Expected JSON" }, 415);
		}
		if (path.endsWith("/stop")) {
			const stopped = await stopCook();
			return stopped.ok ? json({ stopped: true }) : json({ error: stopped.error }, 502);
		}
		const body = SousVideStartBodySchema.safeParse(await req.json().catch(() => null));
		if (!body.success) return json({ error: "Invalid request" }, 400);
		let settings: ReturnType<typeof resolveSousVide>;
		if ("recipe" in body.data) {
			const recipe = await findRecipe(body.data.recipe);
			if (!recipe) return json({ error: "Recipe not found" }, 404);
			if (!recipe.sousVide) return json({ error: "This recipe has no sous vide settings" }, 400);
			settings = resolveSousVide({ recipe: recipe.sousVide });
		} else {
			const { preset: presetName, meater: _meater, ...overrides } = body.data;
			const preset = findPreset(presetName);
			if (!preset) return json({ error: "Preset not found" }, 404);
			settings = resolveSousVide({ preset }, overrides);
		}
		if ("error" in settings) return json(settings, 400);
		const started = await startCook(settings, body.data.meater ?? true);
		return started.ok ? json({ started: true, ...settings }) : json({ error: started.error }, 502);
	}

	if (path === "/api/kindle/open" && req.method === "POST") {
		// A JSON content type forces a CORS preflight, so other sites cannot send this blindly
		if (!req.headers.get("content-type")?.includes("application/json")) {
			return json({ error: "Expected JSON" }, 415);
		}
		const body = KindleOpenBodySchema.safeParse(await req.json().catch(() => null));
		if (!body.success) return json({ error: "Invalid request" }, 400);
		const request = await requestOpenOnKindle(body.data.recipe, body.data.servings);
		return request ? json(kindleStatus()) : json({ error: "Recipe not found" }, 404);
	}

	// The phone's share sheet (an iOS Shortcut) sends a recipe page found on the web
	if (path === "/api/kindle/open-url" && req.method === "POST") {
		if (!req.headers.get("content-type")?.includes("application/json")) {
			return json({ error: "Expected JSON" }, 415);
		}
		const body = KindleUrlBodySchema.safeParse(await req.json().catch(() => null));
		if (!body.success) return json({ error: "Send the page's address as url" }, 400);
		try {
			if (isInstagramLink(body.data.url)) {
				const post = await fetchInstagramPost(body.data.url, webFetch);
				requestOpenInstagram(post);
				return json({
					ok: true,
					sent: true,
					name: post.title,
					site: "instagram.com",
					message: `Sent "${post.title}" to the Kindle`,
					...kindleStatus(),
				});
			}
			const web = await fetchWebRecipe(body.data.url, webFetch);
			requestOpenWebRecipe(web);
			return json({
				ok: true,
				sent: true,
				name: web.name,
				site: web.site,
				message: `Sent "${web.name}" to the Kindle`,
				...kindleStatus(),
			});
		} catch (error) {
			if (error instanceof WebRecipeError) return shareError(error);
			throw error;
		}
	}

	// The share sheet's other target: keep a recipe found on the web in the recipe book
	if (path === "/api/recipes/import-url" && req.method === "POST") {
		if (!req.headers.get("content-type")?.includes("application/json")) {
			return json({ error: "Expected JSON" }, 415);
		}
		const body = KindleUrlBodySchema.safeParse(await req.json().catch(() => null));
		if (!body.success) return json({ error: "Send the page's address as url" }, 400);
		try {
			// A caption has no recipe data, so it waits in the inbox for Claude to turn into one
			if (isInstagramLink(body.data.url)) {
				const post = await fetchInstagramPost(body.data.url, webFetch);
				const { draft, existed } = await addInstagramDraft(post);
				const message = existed
					? `"${draft.title}" is already in Ruoka's inbox`
					: `Saved "${draft.title}" to Ruoka's inbox. Open Ruoka and tap Add to app`;
				return shareReply(!existed, message, {
					saved: !existed,
					draft: draft.id,
					name: draft.title,
					exists: existed,
				});
			}
			const input = webRecipeToInput(await fetchWebRecipe(body.data.url, webFetch));
			// A recipe of the same name may have been edited or rated here; never overwrite it
			const existing = await findRecipe(input.name);
			if (existing) {
				const message = `"${existing.name}" is already in Ruoka`;
				return shareReply(false, message, { exists: true, id: existing.id });
			}
			const { recipe } = await saveRecipe(input);
			logger.info({ recipe: recipe.id, tag: IMPORT_TAG }, "Recipe imported from the web");
			return json({
				ok: true,
				saved: true,
				id: recipe.id,
				name: recipe.name,
				message: `Saved "${recipe.name}" to Ruoka`,
			});
		} catch (error) {
			if (error instanceof WebRecipeError) return shareError(error);
			throw error;
		}
	}

	// The inbox: Instagram posts shared to Ruoka, waiting for Claude to make recipes of them
	if (path === "/api/drafts" && req.method === "GET") {
		return json({ drafts: await listDrafts() });
	}
	const draftMatch = /^\/api\/drafts\/([^/]+)$/.exec(path);
	if (draftMatch?.[1] && req.method === "DELETE") {
		const removed = await deleteDraft(decodeSegment(draftMatch[1]));
		return removed ? json({ deleted: removed.id }) : json({ error: "Not in the inbox" }, 404);
	}

	if (path === "/api/plans" && req.method === "GET") {
		return json({ plans: await listPlans() });
	}

	const mealMatch = /^\/api\/plans\/([^/]+)\/meals\/(\d+)\/recipe$/.exec(path);
	if (mealMatch?.[1] && mealMatch[2] && req.method === "POST") {
		// A JSON content type forces a CORS preflight, so other sites cannot send this blindly
		if (!req.headers.get("content-type")?.includes("application/json")) {
			return json({ error: "Expected JSON" }, 415);
		}
		return saveMealAsRecipe(
			decodeSegment(mealMatch[1]),
			Number(mealMatch[2]),
			await req.json().catch(() => ({})),
		);
	}

	const planMatch = /^\/api\/plans\/([^/]+)(\/checked|\/rating)?$/.exec(path);
	if (planMatch?.[1]) {
		const planId = decodeSegment(planMatch[1]);
		const sub = planMatch[2];
		if (!sub && req.method === "GET") {
			const plan = await findPlan(planId);
			return plan ? json(plan) : json({ error: "Plan not found" }, 404);
		}
		if (!sub && req.method === "DELETE") {
			const removed = await deletePlan(planId);
			return removed ? json({ deleted: removed.id }) : json({ error: "Plan not found" }, 404);
		}
		if (sub && req.method === "PUT") {
			if (!req.headers.get("content-type")?.includes("application/json")) {
				return json({ error: "Expected JSON" }, 415);
			}
			const payload = await req.json().catch(() => null);
			if (sub === "/checked") {
				const body = CheckedBodySchema.safeParse(payload);
				if (!body.success) return json({ error: "Expected a list of product ids" }, 400);
				const updated = await setChecked(planId, body.data.checked);
				return updated ? json(updated) : json({ error: "Plan not found" }, 404);
			}
			const body = RatingBodySchema.safeParse(payload);
			if (!body.success) return json({ error: "Rating must be 1-5 or null" }, 400);
			const updated = await ratePlan(planId, body.data.rating, body.data.review);
			return updated ? json(updated) : json({ error: "Plan not found" }, 404);
		}
		return json({ error: "Method not allowed" }, 405);
	}

	const match = /^\/api\/recipes\/([^/]+)(\/rating)?$/.exec(path);
	if (!match?.[1]) return json({ error: "Not found" }, 404);
	const id = decodeSegment(match[1]);

	if (!match[2] && req.method === "GET") {
		const recipe = await findRecipe(id);
		if (!recipe) return json({ error: "Recipe not found" }, 404);
		const servings = Number(url.searchParams.get("servings"));
		return json(
			Number.isInteger(servings) && servings > 0 && servings <= MAX_SCALED_SERVINGS
				? scaleRecipe(recipe, servings)
				: recipe,
		);
	}

	if (!match[2] && req.method === "DELETE") {
		const removed = await deleteRecipe(id);
		return removed ? json({ deleted: removed.id }) : json({ error: "Recipe not found" }, 404);
	}

	if (match[2] && req.method === "PUT") {
		// A JSON content type forces a CORS preflight, so other sites cannot change ratings blindly
		if (!req.headers.get("content-type")?.includes("application/json")) {
			return json({ error: "Expected JSON" }, 415);
		}
		const body = RatingBodySchema.safeParse(await req.json().catch(() => null));
		if (!body.success) return json({ error: "Rating must be 1-5 or null" }, 400);
		const updated = await rateRecipe(id, body.data.rating, body.data.review);
		return updated ? json(updated) : json({ error: "Recipe not found" }, 404);
	}

	return json({ error: "Method not allowed" }, 405);
}

// Applied to every answer. Framing is refused only on the standalone address: Home Assistant shows
// the ingress panel inside its own page, but nothing should frame the standalone app, where another
// site could otherwise overlay it while Tailscale vouches for the visitor.
export function withSecurityHeaders(response: Response, denyFraming: boolean): Response {
	const headers = new Headers(response.headers);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "no-referrer");
	if (denyFraming) {
		headers.set("X-Frame-Options", "DENY");
		headers.set("Content-Security-Policy", "frame-ancestors 'none'");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// Home Assistant's ingress proxy always connects from this address; everything else is refused
const INGRESS_ADDRESS = "172.30.32.2";

// Behind `tailscale serve`, requests from tailnet members carry the sender's login in a header that
// Tailscale sets itself (and strips from anything the client sends); Funnel traffic has none. The
// listener is bound to a loopback address only the Tailscale proxy is pointed at.
export function isAllowedTailnetUser(headers: Headers, allowedLogins: string[]): boolean {
	const login = headers.get("tailscale-user-login")?.trim().toLowerCase();
	return !!login && allowedLogins.includes(login);
}

// The two front doors share the routes; each checks its own kind of identity first
export function createStandaloneFetch(
	allowedLogins: string[],
): (req: Request) => Promise<Response> {
	const allowed = allowedLogins.map((l) => l.trim().toLowerCase()).filter(Boolean);
	return async (req) => {
		if (!isAllowedTailnetUser(req.headers, allowed)) {
			logger.warn("Refused standalone recipe app request without an allowed Tailscale login");
			return withSecurityHeaders(new Response("Forbidden", { status: 403 }), true);
		}
		try {
			return withSecurityHeaders(await handleUiRequest(req), true);
		} catch (error) {
			logger.error({ err: error }, "Recipe app request failed");
			return withSecurityHeaders(json({ error: "Server error" }, 500), true);
		}
	};
}

export function createIngressFetch(
	allowAny = process.env.RUOKA_UI_ALLOW_ANY === "1",
): (req: Request, peer: string | null | undefined) => Promise<Response> {
	return async (req, peer) => {
		if (peer !== INGRESS_ADDRESS && !allowAny) {
			logger.warn({ peer }, "Refused recipe UI request outside ingress");
			return withSecurityHeaders(new Response("Forbidden", { status: 403 }), false);
		}
		try {
			return withSecurityHeaders(await handleUiRequest(req), false);
		} catch (error) {
			logger.error({ err: error }, "Recipe UI request failed");
			return withSecurityHeaders(json({ error: "Server error" }, 500), false);
		}
	};
}

export function startStandaloneUi(port: number, allowedLogins: string[]): void {
	if (!allowedLogins.some((l) => l.trim())) {
		logger.warn("Standalone recipe app disabled: no allowed Tailscale login");
		return;
	}
	const fetch = createStandaloneFetch(allowedLogins);
	Bun.serve({
		maxRequestBodySize: MAX_BACKUP_BYTES,
		// 127.0.0.2, not 127.0.0.1: Tailscale's userspace networking forwards direct tailnet
		// connections to 127.0.0.1, where a caller could set the login header themselves
		hostname: process.env.RUOKA_UI_STANDALONE_HOST || "127.0.0.2",
		port,
		development: false,
		fetch: (req) => fetch(req),
	});
	logger.info({ port }, "Standalone recipe app listening (Tailscale only)");
}

export function startUiServer(port: number): void {
	const fetch = createIngressFetch();
	Bun.serve({
		maxRequestBodySize: MAX_BACKUP_BYTES,
		hostname: "0.0.0.0",
		port,
		development: false,
		fetch: (req, server) => fetch(req, server.requestIP(req)?.address),
	});
	logger.info({ port }, "Recipe UI listening (Home Assistant ingress)");
}
