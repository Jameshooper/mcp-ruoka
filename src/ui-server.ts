import { join } from "node:path";
import * as z from "zod/v4";
import { logger } from "./logger.ts";
import { deletePlan, findPlan, listPlans, setChecked } from "./plan-book.ts";
import { deleteRecipe, findRecipe, listRecipes, rateRecipe, scaleRecipe } from "./recipe-book.ts";

const indexPath = join(import.meta.dirname, "ui", "index.html");

const CheckedBodySchema = z.object({ checked: z.array(z.string()).max(200) });

const RatingBodySchema = z.object({
	rating: z.number().int().min(1).max(5).nullable(),
	review: z.string().max(2000).optional(),
});

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// Paths are relative so the page works behind Home Assistant's ingress prefix
export async function handleUiRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.replace(/\/+$/, "") || "/";

	if (req.method === "GET" && (path === "/" || path === "/index.html")) {
		return new Response(Bun.file(indexPath), {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	}

	if (path === "/api/recipes" && req.method === "GET") {
		return json({ recipes: await listRecipes() });
	}

	if (path === "/api/plans" && req.method === "GET") {
		return json({ plans: await listPlans() });
	}

	const planMatch = /^\/api\/plans\/([^/]+)(\/checked)?$/.exec(path);
	if (planMatch?.[1]) {
		const planId = decodeURIComponent(planMatch[1]);
		if (!planMatch[2] && req.method === "GET") {
			const plan = await findPlan(planId);
			return plan ? json(plan) : json({ error: "Plan not found" }, 404);
		}
		if (!planMatch[2] && req.method === "DELETE") {
			const removed = await deletePlan(planId);
			return removed ? json({ deleted: removed.id }) : json({ error: "Plan not found" }, 404);
		}
		if (planMatch[2] && req.method === "PUT") {
			if (!req.headers.get("content-type")?.includes("application/json")) {
				return json({ error: "Expected JSON" }, 415);
			}
			const body = CheckedBodySchema.safeParse(await req.json().catch(() => null));
			if (!body.success) return json({ error: "Expected a list of product ids" }, 400);
			const updated = await setChecked(planId, body.data.checked);
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

export function startUiServer(port: number): void {
	Bun.serve({
		hostname: "0.0.0.0",
		port,
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
