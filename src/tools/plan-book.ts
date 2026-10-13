import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { deletePlan, findPlan, listPlans, ratePlan } from "../plan-book.ts";

function text(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function notFound(idOrName: string) {
	return {
		isError: true,
		content: [
			{
				type: "text" as const,
				text: `No saved meal plan matches "${idOrName}". Call list_meal_plans to see what is saved.`,
			},
		],
	};
}

export function registerPlanBookTools(server: McpServer): void {
	server.registerTool(
		"list_meal_plans",
		{
			description:
				"List the saved weekly meal plans (id, name, meals, shopping total, budget, whether balanced, how many ingredients are not priced and so missing from the total). Plans are saved by calling plan_meals with saveAs.",
			inputSchema: z.object({}),
		},
		async () => {
			const plans = await listPlans();
			return text({
				count: plans.length,
				plans: plans.map((p) => ({
					id: p.id,
					name: p.name,
					updatedAt: p.updatedAt,
					store: p.store,
					meals: p.meals.map((m) => m.name),
					toBuyTotal: p.toBuy.total,
					budget: p.budget ?? null,
					balanced: p.balance.balanced,
					rating: p.rating ?? null,
					notPriced: p.missing.length + p.unquantified.length,
				})),
			});
		},
	);

	server.registerTool(
		"get_meal_plan",
		{
			description:
				"Get one saved meal plan by id or name, with its meals, shopping list, totals and balance report.",
			inputSchema: z.object({ plan: z.string().min(1).describe("Plan id or name") }),
		},
		async ({ plan }) => {
			const found = await findPlan(plan);
			return found ? text(found) : notFound(plan);
		},
	);

	server.registerTool(
		"rate_meal_plan",
		{
			description:
				"Rate a saved meal plan 1-5 stars, with an optional short review, when the user says how the week went. The same rating can be set in the Meal plans panel.",
			inputSchema: z.object({
				plan: z.string().min(1).describe("Plan id or name"),
				rating: z.number().int().min(1).max(5),
				review: z.string().max(2000).optional().describe("What worked or what to change"),
			}),
		},
		async ({ plan, rating, review }) => {
			const updated = await ratePlan(plan, rating, review);
			return updated
				? text({ rated: updated.id, rating, review: updated.review ?? null })
				: notFound(plan);
		},
	);

	server.registerTool(
		"delete_meal_plan",
		{
			description: "Delete a saved meal plan by id or name. Only do this when the user asks.",
			inputSchema: z.object({ plan: z.string().min(1).describe("Plan id or name") }),
		},
		async ({ plan }) => {
			const removed = await deletePlan(plan);
			return removed ? text({ deleted: removed.id }) : notFound(plan);
		},
	);
}
