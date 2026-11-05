import { existsSync } from "node:fs";
import { type Browser, chromium } from "playwright";

// For tests: the browser that matches the installed Playwright, or a preinstalled one (CI images,
// sandboxes). Null when neither starts, so browser tests can be skipped rather than fail.
export async function launchTestBrowser(): Promise<Browser | null> {
	try {
		return await chromium.launch();
	} catch {
		const fallback = process.env.RUOKA_TEST_CHROMIUM ?? "/opt/pw-browsers/chromium";
		if (!existsSync(fallback)) return null;
		return chromium.launch({ executablePath: fallback }).catch(() => null);
	}
}
