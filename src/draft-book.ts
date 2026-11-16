import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import type { InstagramPost } from "./instagram.ts";

// Recipes shared from places with no recipe data (Instagram captions) wait here until Claude
// turns them into proper recipes: the app itself cannot read amounts out of free text or
// translate ingredient names into shop search terms.

const DraftSchema = z.object({
	id: z.string().min(1),
	source: z.string(),
	author: z.string().optional(),
	title: z.string(),
	caption: z.string(),
	createdAt: z.string(),
});

const DraftFileSchema = z.object({ drafts: z.array(DraftSchema) });

export type RecipeDraft = z.infer<typeof DraftSchema>;

const MAX_DRAFTS = 100;

function draftFile(): string {
	const dir = process.env.RUOKA_DATA_DIR ?? join(homedir(), ".mcp-ruoka");
	return join(dir, "drafts.json");
}

async function readDrafts(): Promise<RecipeDraft[]> {
	let text: string;
	try {
		text = await readFile(draftFile(), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	return DraftFileSchema.parse(JSON.parse(text)).drafts;
}

async function writeDrafts(drafts: RecipeDraft[]): Promise<void> {
	const file = draftFile();
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(`${file}.tmp`, JSON.stringify({ drafts }, null, 2));
	await rename(`${file}.tmp`, file);
}

let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.catch(() => undefined);
	return run;
}

export function listDrafts(): Promise<RecipeDraft[]> {
	return exclusive(readDrafts);
}

// Sharing the same post twice keeps the first draft
export function addInstagramDraft(
	post: InstagramPost,
	now = new Date(),
): Promise<{ draft: RecipeDraft; existed: boolean }> {
	return exclusive(async () => {
		const drafts = await readDrafts();
		const existing = drafts.find((d) => d.source === post.source);
		if (existing) return { draft: existing, existed: true };
		const code = /\/p\/([\w-]+)\//.exec(post.source)?.[1] ?? String(now.getTime());
		const draft: RecipeDraft = {
			id: `instagram-${code}`,
			source: post.source,
			...(post.author && { author: post.author }),
			title: post.title,
			caption: post.lines.join("\n"),
			createdAt: now.toISOString(),
		};
		// The oldest drafts give way rather than the file growing without end
		await writeDrafts([...drafts, draft].slice(-MAX_DRAFTS));
		return { draft, existed: false };
	});
}

export function deleteDraft(id: string): Promise<RecipeDraft | undefined> {
	return exclusive(async () => {
		const drafts = await readDrafts();
		const found = drafts.find((d) => d.id === id);
		if (found) await writeDrafts(drafts.filter((d) => d.id !== id));
		return found;
	});
}
