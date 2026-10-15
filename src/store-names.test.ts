import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "ruoka-stores-"));
	process.env.RUOKA_DATA_DIR = dir;
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("names are remembered per chain and a given name wins", async () => {
	const { rememberStores, getStoreNames, resolveStoreName } = await import("./store-names.ts");
	await rememberStores([{ chain: "s-kaupat", id: "613756972", name: "Prisma Linnainmaa" }]);
	expect((await getStoreNames())["s-kaupat:613756972"]).toBe("Prisma Linnainmaa");
	expect(await resolveStoreName("s-kaupat", "613756972")).toBe("Prisma Linnainmaa");
	expect(await resolveStoreName("k-ruoka", "613756972")).toBeUndefined();
	expect(await resolveStoreName("s-kaupat", "1", "Prisma Kaleva")).toBe("Prisma Kaleva");
	expect(await resolveStoreName("s-kaupat", "1")).toBe("Prisma Kaleva");
});

test("a damaged file does not break lookups", async () => {
	const { getStoreNames } = await import("./store-names.ts");
	await writeFile(join(dir, "stores.json"), "{nope");
	expect(await getStoreNames()).toEqual({});
});
