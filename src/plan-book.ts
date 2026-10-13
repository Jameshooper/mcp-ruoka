import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { slugify } from "./recipe-book.ts";
import { ProteinSchema, StoredNutritionSchema } from "./schemas.ts";

const LineSchema = z.object({
	ingredient: z.string(),
	needed: z.string(),
	product: z.string(),
	productId: z.string(),
	url: z.string().nullable(),
	packSize: z.string(),
	packages: z.number(),
	unitPrice: z.string().nullable(),
	cost: z.number(),
	leftover: z.string(),
	leftoverValue: z.number(),
	usedIn: z.array(z.string()),
	location: z.object({ aisle: z.string().nullable(), floor: z.number().nullable() }).nullish(),
});

const MealSchema = z.object({
	name: z.string(),
	servings: z.number(),
	recipe: z.string().optional(),
	protein: ProteinSchema.optional(),
	vegetables: z.boolean().optional(),
	nutrition: StoredNutritionSchema.optional(),
});

const ListSchema = z.object({ total: z.number(), lines: z.array(LineSchema) });

export const PlanSnapshotSchema = z.object({
	store: z.object({ chain: z.enum(["k-ruoka", "s-kaupat"]), storeId: z.string() }),
	budget: z.number().optional(),
	meals: z.array(MealSchema),
	toBuy: ListSchema,
	pantry: ListSchema,
	balance: z.object({
		balanced: z.boolean(),
		issues: z.array(z.string()),
		counts: z.record(z.string(), z.number()),
	}),
	nutrition: z.object({
		average: z.object({ kcalPerPortion: z.number(), proteinPerPortionG: z.number() }).nullable(),
		missing: z.array(z.string()),
	}),
	waste: z.object({ leftoverValue: z.number() }),
	pooling: z.object({ saved: z.number() }),
});

const PlanSchema = PlanSnapshotSchema.extend({
	id: z.string().min(1),
	name: z.string().min(1),
	createdAt: z.string(),
	updatedAt: z.string(),
	// Product ids ticked off in the shopping list
	checked: z.array(z.string()).default([]),
});

const BookSchema = z.object({ plans: z.array(PlanSchema) });

export type MealPlan = z.infer<typeof PlanSchema>;
export type PlanSnapshot = z.infer<typeof PlanSnapshotSchema>;

function planFile(): string {
	const dir = process.env.RUOKA_DATA_DIR ?? join(homedir(), ".mcp-ruoka");
	return join(dir, "plans.json");
}

async function readPlans(): Promise<MealPlan[]> {
	let text: string;
	try {
		text = await readFile(planFile(), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	// A corrupt file must fail loudly: treating it as empty would overwrite the saved plans
	return BookSchema.parse(JSON.parse(text)).plans;
}

async function writePlans(plans: MealPlan[]): Promise<void> {
	const file = planFile();
	await mkdir(join(file, ".."), { recursive: true });
	const temp = `${file}.tmp`;
	await writeFile(temp, JSON.stringify({ plans }, null, 2));
	await rename(temp, file);
}

let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.catch(() => undefined);
	return run;
}

function matches(plan: MealPlan, idOrName: string): boolean {
	const wanted = idOrName.trim().toLowerCase();
	return plan.id === wanted || plan.name.toLowerCase() === wanted;
}

export function listPlans(): Promise<MealPlan[]> {
	return exclusive(readPlans);
}

export function findPlan(idOrName: string): Promise<MealPlan | undefined> {
	return exclusive(async () => (await readPlans()).find((p) => matches(p, idOrName)));
}

export function savePlan(
	name: string,
	snapshot: PlanSnapshot,
): Promise<{ plan: MealPlan; replaced: boolean }> {
	return exclusive(async () => {
		const plans = await readPlans();
		const id = slugify(name);
		const index = plans.findIndex((p) => p.id === id);
		const previous = index >= 0 ? plans[index] : undefined;
		const now = new Date().toISOString();
		const productIds = new Set(
			[...snapshot.toBuy.lines, ...snapshot.pantry.lines].map((l) => l.productId),
		);
		const plan: MealPlan = {
			...snapshot,
			id,
			name,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
			// Keep ticks for products that are still on the replaced plan's list
			checked: (previous?.checked ?? []).filter((c) => productIds.has(c)),
		};
		if (previous) plans[index] = plan;
		else plans.push(plan);
		await writePlans(plans);
		return { plan, replaced: previous !== undefined };
	});
}

export function setChecked(idOrName: string, checked: string[]): Promise<MealPlan | undefined> {
	return exclusive(async () => {
		const plans = await readPlans();
		const index = plans.findIndex((p) => matches(p, idOrName));
		const current = plans[index];
		if (!current) return undefined;
		const productIds = new Set(
			[...current.toBuy.lines, ...current.pantry.lines].map((l) => l.productId),
		);
		const updated = { ...current, checked: [...new Set(checked)].filter((c) => productIds.has(c)) };
		plans[index] = updated;
		await writePlans(plans);
		return updated;
	});
}

export function deletePlan(idOrName: string): Promise<MealPlan | undefined> {
	return exclusive(async () => {
		const plans = await readPlans();
		const index = plans.findIndex((p) => matches(p, idOrName));
		const removed = plans[index];
		if (!removed) return undefined;
		plans.splice(index, 1);
		await writePlans(plans);
		return removed;
	});
}
