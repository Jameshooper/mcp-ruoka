import { expect, test } from "bun:test";
import { crc32, unzipFiles, ZipError, zipFiles } from "./zip.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("files survive a zip round trip, including non-ASCII names and content", () => {
	const zip = zipFiles([
		{ name: "recipes.json", data: enc.encode('{"name":"Pääsiäislaatikko ✓"}') },
		{ name: "empty.txt", data: new Uint8Array() },
		{ name: "big.txt", data: enc.encode("abc".repeat(50_000)) },
	]);
	const files = unzipFiles(zip);
	expect([...files.keys()]).toEqual(["recipes.json", "empty.txt", "big.txt"]);
	expect(dec.decode(files.get("recipes.json"))).toBe('{"name":"Pääsiäislaatikko ✓"}');
	expect(files.get("empty.txt")?.length).toBe(0);
	expect(files.get("big.txt")?.length).toBe(150_000);
});

test("the crc matches the standard check value", () => {
	expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
});

test("things that are not a zip, or are damaged, are rejected", () => {
	expect(() => unzipFiles(enc.encode("hello"))).toThrow(ZipError);
	const zip = zipFiles([{ name: "a.txt", data: enc.encode("hello world hello world") }]);
	expect(() => unzipFiles(zip.slice(0, zip.length - 30))).toThrow(ZipError);

	// flip a byte inside the compressed data
	const damaged = zip.slice();
	damaged[40] = (damaged[40] ?? 0) ^ 0xff;
	expect(() => unzipFiles(damaged)).toThrow(ZipError);
});

test("an archive claiming to expand beyond the limit is refused", () => {
	const zip = zipFiles([{ name: "a.txt", data: enc.encode("x".repeat(10_000)) }]);
	expect(() => unzipFiles(zip, { maxEntries: 5, maxTotalBytes: 1_000 })).toThrow("too large");
	expect(() => unzipFiles(zip, { maxEntries: 0, maxTotalBytes: 1_000_000 })).toThrow("too many");
});
