import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { importPlans, listPlans, type MealPlan, parsePlanBook, previewPlans } from "./plan-book.ts";
import {
	type ImportCounts,
	importRecipes,
	listRecipes,
	parseRecipeBook,
	previewRecipes,
	type Recipe,
} from "./recipe-book.ts";
import type { ImportMode } from "./schemas.ts";
import { getStoreNames, importStoreNames, parseStoreNames } from "./store-names.ts";
import { unzipFiles, ZipError, zipFiles } from "./zip.ts";

const KEEP_AUTO_BACKUPS = 5;
const KEEP_DAILY_BACKUPS = 7;
const DAILY_PREFIX = "ruoka-daily-";
const BACKUP_FILE_RE = /^ruoka-(daily|before-import)-[0-9A-Za-z-]+\.zip$/;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export class BackupError extends Error {}

const ManifestSchema = z.object({ app: z.literal("ruoka"), exportedAt: z.string() });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function dataDir(): string {
	return process.env.RUOKA_DATA_DIR ?? join(homedir(), ".mcp-ruoka");
}

// Everything the app keeps, as one zip: the same JSON files the app reads, plus a manifest
export async function buildBackup(now = new Date()): Promise<{
	bytes: Uint8Array;
	counts: { recipes: number; plans: number };
}> {
	const [recipes, plans, names] = await Promise.all([listRecipes(), listPlans(), getStoreNames()]);
	const json = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2));
	const bytes = zipFiles(
		[
			{
				name: "manifest.json",
				data: json({ app: "ruoka", format: 1, exportedAt: now.toISOString() }),
			},
			{ name: "recipes.json", data: json({ recipes }) },
			{ name: "plans.json", data: json({ plans }) },
			{ name: "stores.json", data: json({ names }) },
		],
		now,
	);
	return { bytes, counts: { recipes: recipes.length, plans: plans.length } };
}

interface ParsedBackup {
	exportedAt: string | null;
	recipes?: Recipe[];
	plans?: MealPlan[];
	names?: Record<string, string>;
}

function describe(error: unknown): string {
	if (error instanceof z.ZodError) {
		const issue = error.issues[0];
		return issue ? `${issue.path.join(".") || "root"}: ${issue.message}` : "invalid content";
	}
	return error instanceof Error ? error.message : "invalid content";
}

// Everything is validated before anything is written, so a bad file never half-applies
export function parseBackup(bytes: Uint8Array): ParsedBackup {
	let files: Map<string, Uint8Array>;
	try {
		files = unzipFiles(bytes);
	} catch (error) {
		throw new BackupError(error instanceof ZipError ? error.message : "This is not a zip file");
	}

	const parsed: ParsedBackup = { exportedAt: null };
	const manifest = files.get("manifest.json");
	if (manifest) {
		try {
			parsed.exportedAt = ManifestSchema.parse(JSON.parse(decoder.decode(manifest))).exportedAt;
		} catch {
			// The manifest is informational; the data files decide whether this is a backup
		}
	}

	const read = <T>(name: string, parse: (text: string) => T): T | undefined => {
		const data = files.get(name);
		if (!data) return undefined;
		try {
			return parse(decoder.decode(data));
		} catch (error) {
			throw new BackupError(`${name} is not valid (${describe(error)})`);
		}
	};
	const recipes = read("recipes.json", parseRecipeBook);
	const plans = read("plans.json", parsePlanBook);
	const names = read("stores.json", parseStoreNames);
	if (!recipes && !plans && !names) {
		throw new BackupError("This zip does not look like a Ruoka backup");
	}
	return {
		...parsed,
		...(recipes && { recipes }),
		...(plans && { plans }),
		...(names && { names }),
	};
}

export interface BackupPreview {
	exportedAt: string | null;
	recipes: { total: number; existing: number; new: number } | null;
	plans: { total: number; existing: number; new: number } | null;
	storeNames: number | null;
}

export async function previewBackup(bytes: Uint8Array): Promise<BackupPreview> {
	const backup = parseBackup(bytes);
	const withNew = (r: { total: number; existing: number }) => ({ ...r, new: r.total - r.existing });
	return {
		exportedAt: backup.exportedAt,
		recipes: backup.recipes ? withNew(await previewRecipes(backup.recipes)) : null,
		plans: backup.plans ? withNew(await previewPlans(backup.plans)) : null,
		storeNames: backup.names ? Object.keys(backup.names).length : null,
	};
}

// A safety copy of the current data, so a wrong import can be undone by importing it back
async function saveAutoBackup(now: Date): Promise<string> {
	const dir = join(dataDir(), "backups");
	await mkdir(dir, { recursive: true });
	const name = `ruoka-before-import-${now.toISOString().replace(/[:.]/g, "-")}.zip`;
	await writeFile(join(dir, name), (await buildBackup(now)).bytes);

	const old = (await readdir(dir))
		.filter((f) => f.startsWith("ruoka-before-import-") && f.endsWith(".zip"))
		.sort()
		.slice(0, -KEEP_AUTO_BACKUPS);
	await Promise.all(old.map((f) => rm(join(dir, f), { force: true })));
	return name;
}

export interface ImportResult {
	recipes: ImportCounts | null;
	plans: ImportCounts | null;
	safetyCopy: string;
}

export async function applyBackup(
	bytes: Uint8Array,
	mode: ImportMode,
	now = new Date(),
): Promise<ImportResult> {
	const backup = parseBackup(bytes);
	const safetyCopy = await saveAutoBackup(now);
	const recipes = backup.recipes ? await importRecipes(backup.recipes, mode) : null;
	const plans = backup.plans ? await importPlans(backup.plans, mode) : null;
	if (backup.names) await importStoreNames(backup.names, mode);
	return { recipes, plans, safetyCopy };
}

function backupsDir(): string {
	return join(dataDir(), "backups");
}

// One copy per day, written only when the day has none yet, so restarts do not pile up copies
export async function saveDailyBackup(now = new Date()): Promise<string | null> {
	const dir = backupsDir();
	await mkdir(dir, { recursive: true });
	const name = `${DAILY_PREFIX}${now.toISOString().slice(0, 10)}.zip`;
	const existing = await readdir(dir);
	if (existing.includes(name)) return null;

	const { bytes, counts } = await buildBackup(now);
	// An empty copy must not push the last good ones out of the rotation
	if (counts.recipes === 0 && counts.plans === 0) return null;
	await writeFile(join(dir, name), bytes);

	const old = [...existing, name]
		.filter((f) => f.startsWith(DAILY_PREFIX) && f.endsWith(".zip"))
		.sort()
		.slice(0, -KEEP_DAILY_BACKUPS);
	await Promise.all(old.map((f) => rm(join(dir, f), { force: true })));
	return name;
}

export function startDailyBackups(log: (err: unknown) => void): void {
	const run = () => saveDailyBackup().catch(log);
	void run();
	setInterval(run, CHECK_INTERVAL_MS).unref();
}

export interface BackupFile {
	name: string;
	kind: "daily" | "before-import";
	size: number;
	modified: string;
}

export async function listBackupFiles(): Promise<BackupFile[]> {
	const dir = backupsDir();
	const names = await readdir(dir).catch(() => []);
	const files = await Promise.all(
		names
			.filter((n) => BACKUP_FILE_RE.test(n))
			.map(async (name) => {
				const info = await stat(join(dir, name));
				return {
					name,
					kind: name.startsWith(DAILY_PREFIX) ? ("daily" as const) : ("before-import" as const),
					size: info.size,
					modified: info.mtime.toISOString(),
				};
			}),
	);
	return files.sort((a, b) => b.modified.localeCompare(a.modified));
}

// The name is matched against a strict pattern, so it can never point outside the backups folder
export function backupFilePath(name: string): string | null {
	return BACKUP_FILE_RE.test(name) ? join(backupsDir(), name) : null;
}
