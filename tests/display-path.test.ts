import { describe, expect, it } from "vitest";
import { toDisplayPath } from "../src/display-path.js";

describe("toDisplayPath", () => {
	it("uses forward slashes for Windows UI-facing paths", () => {
		expect(toDisplayPath("packages\\api\\src", "\\")).toBe("packages/api/src");
		expect(toDisplayPath("C:\\repo\\src\\state.ts", "\\")).toBe("C:/repo/src/state.ts");
	});

	it("preserves backslashes that are valid POSIX filename characters", () => {
		expect(toDisplayPath("src/file\\name.ts", "/")).toBe("src/file\\name.ts");
	});
});
