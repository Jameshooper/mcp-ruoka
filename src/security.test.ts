import { expect, test } from "bun:test";
import {
	allowedRedirects,
	clientAddress,
	FailureLimiter,
	ipAllowed,
	parseCidrs,
} from "./security.ts";

test("IPv4 and IPv6 ranges match by prefix", () => {
	const cidrs = parseCidrs("160.79.104.0/21, 2607:6bc0::/48, 203.0.113.7");
	expect(ipAllowed("160.79.104.1", cidrs)).toBe(true);
	expect(ipAllowed("160.79.111.255", cidrs)).toBe(true);
	expect(ipAllowed("160.79.112.0", cidrs)).toBe(false);
	expect(ipAllowed("2607:6bc0:0:1::5", cidrs)).toBe(true);
	expect(ipAllowed("2607:6bc1::1", cidrs)).toBe(false);
	expect(ipAllowed("203.0.113.7", cidrs)).toBe(true);
	expect(ipAllowed("203.0.113.8", cidrs)).toBe(false);
	expect(ipAllowed("::ffff:160.79.104.9", cidrs)).toBe(true);
	expect(ipAllowed(null, cidrs)).toBe(false);
	expect(ipAllowed("not an ip", cidrs)).toBe(false);
});

test("a bad allowlist entry fails loudly instead of being ignored", () => {
	expect(() => parseCidrs("160.79.104.0/40")).toThrow();
	expect(() => parseCidrs("banana")).toThrow();
	expect(parseCidrs("")).toEqual([]);
	expect(parseCidrs(undefined)).toEqual([]);
});

test("the forwarded header is believed only from the local proxy, and only its last entry", () => {
	const forged = new Headers({ "X-Forwarded-For": "160.79.104.5, 198.51.100.9" });
	expect(clientAddress(forged, "127.0.0.1")).toEqual({
		ip: "198.51.100.9",
		source: "x-forwarded-for",
	});
	// from anywhere else it is just a header the caller wrote
	expect(clientAddress(forged, "198.51.100.9")).toEqual({ ip: "198.51.100.9", source: "socket" });
	expect(clientAddress(new Headers(), "127.0.0.1")).toEqual({ ip: "127.0.0.1", source: "socket" });
	expect(clientAddress(new Headers(), undefined)).toEqual({ ip: null, source: null });
});

test("the limiter blocks after repeated failures and recovers after the window", () => {
	const limiter = new FailureLimiter(3, 1_000);
	for (const t of [0, 100, 200]) limiter.record(t);
	expect(limiter.blocked(300)).toBe(true);
	expect(limiter.blocked(1_300)).toBe(false);
});

test("only Claude's callbacks are allowed unless more are configured", () => {
	expect(allowedRedirects("")).toContain("https://claude.ai/api/mcp/auth_callback");
	expect(allowedRedirects("")).not.toContain("https://evil.example/cb");
	expect(allowedRedirects("https://app.example/cb")).toContain("https://app.example/cb");
});
