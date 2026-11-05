import { ZodError } from "zod/v4";

// The weekly live check (scripts/live-check.ts) calls each chain once. A chain can fail for two
// very different reasons: it refused or could not be reached from the CI runner (inconclusive:
// shared cloud addresses are often challenged), or it answered and the answer no longer reads as
// expected (the format changed: the app is broken for real users and needs fixing).

export type CheckStatus = "ok" | "blocked" | "skipped" | "broken";

export interface CheckResult {
	chain: string;
	check: string;
	status: CheckStatus;
	detail: string;
}

const BLOCKED_RE =
	/\b(401|403|429|503)\b|cloudflare|challenge|blocked|timed? ?out|timeout|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|net::ERR_/i;

export class CheckFailure extends Error {}
// A check that could not run because the one it depends on failed; that one carries the verdict
export class CheckSkipped extends Error {}

export function classify(error: unknown): { status: Exclude<CheckStatus, "ok">; detail: string } {
	if (error instanceof ZodError) {
		const issue = error.issues[0];
		const where = issue?.path.join(".") || "response";
		return {
			status: "broken",
			detail: `Response format changed at ${where}: ${issue?.message ?? "invalid"}`,
		};
	}
	if (error instanceof CheckFailure) return { status: "broken", detail: error.message };
	if (error instanceof CheckSkipped) return { status: "skipped", detail: error.message };
	// Browser errors carry a multi-line banner; the first line says what happened
	const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
	if (BLOCKED_RE.test(message)) return { status: "blocked", detail: message.slice(0, 200) };
	// Anything else is a failure in our own code path and is treated as broken
	return { status: "broken", detail: message.slice(0, 200) };
}

export async function runCheck(
	chain: string,
	check: string,
	body: () => Promise<string>,
): Promise<CheckResult> {
	try {
		return { chain, check, status: "ok", detail: await body() };
	} catch (error) {
		return { chain, check, ...classify(error) };
	}
}

export function expectThat(condition: boolean, message: string): asserts condition {
	if (!condition) throw new CheckFailure(message);
}

export function requires<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new CheckSkipped(message);
	return value;
}

const ICON: Record<CheckStatus, string> = { ok: "✅", blocked: "⚠️", skipped: "⏭️", broken: "❌" };

export function summarize(results: CheckResult[]): { markdown: string; exitCode: number } {
	const broken = results.filter((r) => r.status === "broken");
	const blocked = results.filter((r) => r.status === "blocked");
	const rows = results.map(
		(r) =>
			`| ${ICON[r.status]} | ${r.chain} | ${r.check} | ${r.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
	);
	const verdict =
		broken.length > 0
			? `**${broken.length} check(s) broken**: a retailer's answer no longer reads as expected, or the check itself could not run (see each result). A format change means real searches in the app fail until the client is updated (see src/browser/fixtures/README.md).`
			: blocked.length > 0
				? `No format changes found. ${blocked.length} check(s) were blocked or unreachable from the CI runner, so those chains are unverified this week.`
				: "All retailer responses read as expected.";
	return {
		markdown: [
			"## Weekly retailer live check",
			"",
			verdict,
			"",
			"| | Chain | Check | Result |",
			"|---|---|---|---|",
			...rows,
		].join("\n"),
		exitCode: broken.length > 0 ? 1 : 0,
	};
}
