import { expect, test } from "bun:test";
import { shouldUseSandbox } from "./session.ts";

// DEV-05
test("the Chromium sandbox is used whenever the process is not root", () => {
	expect(shouldUseSandbox(1000)).toBe(true);
	expect(shouldUseSandbox(0)).toBe(false);
	expect(shouldUseSandbox(undefined)).toBe(false);
});
