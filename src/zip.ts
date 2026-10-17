import { deflateRawSync, inflateRawSync } from "node:zlib";

// A small zip writer and reader (deflate or stored, no zip64) so backups need no dependency.

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; day: number } {
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		day:
			((Math.max(date.getFullYear(), 1980) - 1980) << 9) |
			((date.getMonth() + 1) << 5) |
			date.getDate(),
	};
}

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

export function zipFiles(files: ZipEntry[], now = new Date()): Uint8Array {
	const { time, day } = dosDateTime(now);
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const compressed = deflateRawSync(file.data);
		const crc = crc32(file.data);

		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(day, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(day, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(file.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);

		locals.push(local, compressed);
		centrals.push(central);
		offset += local.length + compressed.length;
	}

	const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

export interface UnzipLimits {
	maxEntries: number;
	maxTotalBytes: number;
}

export const DEFAULT_LIMITS: UnzipLimits = { maxEntries: 50, maxTotalBytes: 20 * 1024 * 1024 };

export class ZipError extends Error {}

// Reads every file entry. The declared sizes are checked before and after inflating, so a crafted
// archive cannot make the server expand far more than the limit.
export function unzipFiles(
	bytes: Uint8Array,
	limits: UnzipLimits = DEFAULT_LIMITS,
): Map<string, Uint8Array> {
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) throw new ZipError("This is not a zip file");

	const count = buf.readUInt16LE(end + 10);
	const centralSize = buf.readUInt32LE(end + 12);
	let pos = buf.readUInt32LE(end + 16);
	if (count > limits.maxEntries) throw new ZipError("The zip has too many files");
	if (pos === 0xffffffff || centralSize === 0xffffffff)
		throw new ZipError("Zip64 files are not supported");

	const files = new Map<string, Uint8Array>();
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50)
			throw new ZipError("The zip is damaged");
		const method = buf.readUInt16LE(pos + 10);
		const crc = buf.readUInt32LE(pos + 16);
		const compressedSize = buf.readUInt32LE(pos + 20);
		const size = buf.readUInt32LE(pos + 24);
		const nameLength = buf.readUInt16LE(pos + 28);
		const extraLength = buf.readUInt16LE(pos + 30);
		const commentLength = buf.readUInt16LE(pos + 32);
		const localOffset = buf.readUInt32LE(pos + 42);
		const name = buf.toString("utf8", pos + 46, pos + 46 + nameLength);
		pos += 46 + nameLength + extraLength + commentLength;

		if (name.endsWith("/")) continue;
		if (compressedSize === 0xffffffff || size === 0xffffffff)
			throw new ZipError("Zip64 files are not supported");
		total += size;
		if (total > limits.maxTotalBytes) throw new ZipError("The zip is too large");

		if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
			throw new ZipError("The zip is damaged");
		}
		const start =
			localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
		const raw = buf.subarray(start, start + compressedSize);
		if (raw.length !== compressedSize) throw new ZipError("The zip is damaged");

		let data: Buffer;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) {
			try {
				data = inflateRawSync(raw, { maxOutputLength: size + 1 });
			} catch {
				throw new ZipError("The zip is damaged");
			}
		} else throw new ZipError("Unsupported zip compression");

		if (data.length !== size || crc32(data) !== crc) throw new ZipError("The zip is damaged");
		files.set(name, new Uint8Array(data));
	}
	return files;
}
