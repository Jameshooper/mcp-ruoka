import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { deletePlan, findPlan, listPlans } from "../plan-book.ts";

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
				"List the saved weekly meal plans (id, name, meals, shopping total, budget, whether balanced). Plans are saved by calling plan_meals with saveAs.",
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
