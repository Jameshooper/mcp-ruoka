import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { logger } from "./logger.ts";

const BookSchema = z.object({ names: z.record(z.string(), z.string()) });

function namesFile(): string {
	const dir = process.env.RUOKA_DATA_DIR ?? join(homedir(), ".mcp-ruoka");
	return join(dir, "stores.json");
}

const keyOf = (chain: string, id: string) => `${chain}:${id}`;

let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.catch(() => undefined);
	return run;
}

async function read(): Promise<Record<string, string>> {
	try {
		return BookSchema.parse(JSON.parse(await readFile(namesFile(), "utf8"))).names;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		// Names are a convenience for display; a damaged file is rebuilt as stores are seen again
		logger.warn({ err: error }, "Store name file unreadable, starting empty");
		return {};
	}
}

// Names the user has seen (from get_stores or passed by the model), keyed by chain and store id, so
// saved prices can say "Prisma Linnainmaa" instead of a number
export function rememberStores(
	stores: Array<{ chain: string; id: string; name: string }>,
): Promise<void> {
	return exclusive(async () => {
		const names = await read();
		let changed = false;
		for (const store of stores) {
			const key = keyOf(store.chain, store.id);
			if (store.name && names[key] !== store.name) {
				names[key] = store.name;
				changed = true;
			}
		}
		if (!changed) return;
		const file = namesFile();
		await mkdir(join(file, ".."), { recursive: true });
		const temp = `${file}.tmp`;
		await writeFile(temp, JSON.stringify({ names }, null, 2));
		await rename(temp, file);
	});
}

export function getStoreNames(): Promise<Record<string, string>> {
	return exclusive(read);
}

// A name given by the caller wins and is remembered; otherwise one seen earlier is used
export async function resolveStoreName(
	chain: string,
	id: string,
	given?: string,
): Promise<string | undefined> {
	if (given) {
		await rememberStores([{ chain, id, name: given }]).catch((err) =>
			logger.warn({ err }, "Could not remember store name"),
		);
		return given;
	}
	return (await getStoreNames())[keyOf(chain, id)];
}
