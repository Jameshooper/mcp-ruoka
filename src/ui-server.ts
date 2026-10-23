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
import { getStoreNames } from "./store-names.ts";

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

const RatingBodySchema = z.object({
	rating: z.number().int().min(1).max(5).nullable(),
	review: z.string().max(2000).optional(),
});

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

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
		const name = decodeURIComponent(backupFile[1]);
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
			decodeURIComponent(mealMatch[1]),
			Number(mealMatch[2]),
			await req.json().catch(() => ({})),
		);
	}

	const planMatch = /^\/api\/plans\/([^/]+)(\/checked|\/rating)?$/.exec(path);
	if (planMatch?.[1]) {
		const planId = decodeURIComponent(planMatch[1]);
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
	const id = decodeURIComponent(match[1]);

	if (!match[2] && req.method === "GET") {
		const recipe = await findRecipe(id);
		if (!recipe) return json({ error: "Recipe not found" }, 404);
		const servings = Number(url.searchParams.get("servings"));
		return json(
			Number.isInteger(servings) && servings > 0 ? scaleRecipe(recipe, servings) : recipe,
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

// Home Assistant's ingress proxy always connects from this address; everything else is refused
const INGRESS_ADDRESS = "172.30.32.2";

// Behind `tailscale serve`, requests from tailnet members carry the sender's login in a header that
// Tailscale sets itself (and strips from anything the client sends); Funnel traffic has none. The
// listener is bound to a loopback address only the Tailscale proxy is pointed at.
export function isAllowedTailnetUser(headers: Headers, allowedLogins: string[]): boolean {
	const login = headers.get("tailscale-user-login")?.trim().toLowerCase();
	return !!login && allowedLogins.includes(login);
}

export function startStandaloneUi(port: number, allowedLogins: string[]): void {
	const allowed = allowedLogins.map((l) => l.trim().toLowerCase()).filter(Boolean);
	if (allowed.length === 0) {
		logger.warn("Standalone recipe app disabled: no allowed Tailscale login");
		return;
	}
	Bun.serve({
		maxRequestBodySize: MAX_BACKUP_BYTES,
		// 127.0.0.2, not 127.0.0.1: Tailscale's userspace networking forwards direct tailnet
		// connections to 127.0.0.1, where a caller could set the login header themselves
		hostname: process.env.RUOKA_UI_STANDALONE_HOST || "127.0.0.2",
		port,
		development: false,
		async fetch(req) {
			if (!isAllowedTailnetUser(req.headers, allowed)) {
				logger.warn("Refused standalone recipe app request without an allowed Tailscale login");
				return new Response("Forbidden", { status: 403 });
			}
			try {
				return await handleUiRequest(req);
			} catch (error) {
				logger.error({ err: error }, "Recipe app request failed");
				return json({ error: "Server error" }, 500);
			}
		},
	});
	logger.info({ port }, "Standalone recipe app listening (Tailscale only)");
}

export function startUiServer(port: number): void {
	Bun.serve({
		maxRequestBodySize: MAX_BACKUP_BYTES,
		hostname: "0.0.0.0",
		port,
		development: false,
		async fetch(req, server) {
			const peer = server.requestIP(req)?.address;
			if (peer !== INGRESS_ADDRESS && process.env.RUOKA_UI_ALLOW_ANY !== "1") {
				logger.warn({ peer }, "Refused recipe UI request outside ingress");
				return new Response("Forbidden", { status: 403 });
			}
			try {
				return await handleUiRequest(req);
			} catch (error) {
				logger.error({ err: error }, "Recipe UI request failed");
				return json({ error: "Server error" }, 500);
			}
		},
	});
	logger.info({ port }, "Recipe UI listening (Home Assistant ingress)");
}
