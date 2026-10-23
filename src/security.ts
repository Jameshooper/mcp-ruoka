// Defences for the public (Funnel) endpoint that do not depend on Tailscale.

// Where Claude's connector flow is allowed to send the user back after authorising
export const CLAUDE_REDIRECT_URIS = [
	"https://claude.ai/api/mcp/auth_callback",
	"https://claude.com/api/mcp/auth_callback",
];

export function allowedRedirects(extra = process.env.OAUTH_REDIRECT_URIS ?? ""): string[] {
	return [
		...CLAUDE_REDIRECT_URIS,
		...extra
			.split(",")
			.map((u) => u.trim())
			.filter(Boolean),
	];
}

// Failed secret or code attempts are counted together: after `max` failures within the window the
// OAuth endpoints answer 429 until it has passed. Tokens that are already valid are unaffected.
export class FailureLimiter {
	private failures: number[] = [];

	constructor(
		private readonly max = 10,
		private readonly windowMs = 5 * 60_000,
	) {}

	private prune(now: number): void {
		this.failures = this.failures.filter((t) => now - t < this.windowMs);
	}

	record(now = Date.now()): void {
		this.prune(now);
		this.failures.push(now);
	}

	reset(): void {
		this.failures = [];
	}

	blocked(now = Date.now()): boolean {
		this.prune(now);
		return this.failures.length >= this.max;
	}
}

// ---- IP allowlist -------------------------------------------------------------------------

interface Cidr {
	family: 4 | 6;
	network: bigint;
	bits: number;
}

function parseIp(text: string): { family: 4 | 6; value: bigint } | null {
	const ip = text.trim().replace(/^\[|\]$/g, "");
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (v4) {
		const parts = v4.slice(1).map(Number);
		if (parts.some((p) => p > 255)) return null;
		return { family: 4, value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
	}
	// IPv4-mapped IPv6 (::ffff:1.2.3.4) is treated as the IPv4 address
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
	if (mapped?.[1]) return parseIp(mapped[1]);
	if (!ip.includes(":")) return null;

	const [head = "", tail, ...rest] = ip.split("::");
	if (rest.length > 0) return null;
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const missing = 8 - left.length - right.length;
	if (tail === undefined ? left.length !== 8 : missing < 1) return null;
	const groups =
		tail === undefined ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
	let value = 0n;
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
		value = (value << 16n) | BigInt(Number.parseInt(group, 16));
	}
	return { family: 6, value };
}

export function parseCidrs(list: string | undefined): Cidr[] {
	const cidrs: Cidr[] = [];
	for (const entry of (list ?? "")
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean)) {
		const [address = "", prefix] = entry.split("/");
		const ip = parseIp(address);
		if (!ip) throw new Error(`Invalid IP or range in the allowlist: ${entry}`);
		const total = ip.family === 4 ? 32 : 128;
		const bits = prefix === undefined ? total : Number(prefix);
		if (!Number.isInteger(bits) || bits < 0 || bits > total) {
			throw new Error(`Invalid prefix length in the allowlist: ${entry}`);
		}
		const shift = BigInt(total - bits);
		cidrs.push({ family: ip.family, network: (ip.value >> shift) << shift, bits });
	}
	return cidrs;
}

export function ipAllowed(ip: string | null, cidrs: Cidr[]): boolean {
	if (!ip) return false;
	const parsed = parseIp(ip);
	if (!parsed) return false;
	return cidrs.some((cidr) => {
		if (cidr.family !== parsed.family) return false;
		const total = cidr.family === 4 ? 32n : 128n;
		const shift = total - BigInt(cidr.bits);
		return (parsed.value >> shift) << shift === cidr.network;
	});
}

export interface ClientAddress {
	ip: string | null;
	source: "x-forwarded-for" | "socket" | null;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// The Tailscale proxy runs on this machine, so it is the connection's peer. Only then is the
// forwarded header believed, and only its last entry (the one the trusted proxy added), because
// anything earlier in the list can be written by the caller.
export function clientAddress(headers: Headers, peer: string | null | undefined): ClientAddress {
	const forwarded = headers.get("x-forwarded-for");
	if (peer && LOOPBACK.has(peer) && forwarded) {
		const last = forwarded
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)
			.pop();
		if (last) return { ip: last, source: "x-forwarded-for" };
	}
	return peer ? { ip: peer, source: "socket" } : { ip: null, source: null };
}
