import { describe, expect, it } from "vitest";
import { matchAnyGlob, matchGlob } from "./glob.js";

describe("matchGlob", () => {
  it("matches test file globs with brace expansion and recursive wildcards", () => {
    expect(matchGlob("src/auth/login.test.ts", "**/*.test.{ts,tsx,js}")).toBe(true);
    expect(matchGlob("login.test.ts", "**/*.test.{ts,tsx,js}")).toBe(true);
    expect(matchGlob("src/__tests__/util.ts", "**/__tests__/**")).toBe(true);
    expect(matchGlob("src/auth/login.ts", "**/*.test.{ts,tsx,js}")).toBe(false);
  });

  it("matches git branch patterns cleanly", () => {
    expect(matchGlob("agent/fix-login", "agent/*")).toBe(true);
    expect(matchGlob("agent/sub/fix", "agent/*")).toBe(false);
    expect(matchGlob("agent/sub/fix", "agent/**")).toBe(true);
    expect(matchGlob("main", "agent/**")).toBe(false);
    expect(matchAnyGlob("feature/pr-1", ["agent/**", "feature/**"])).toBe(true);
  });
});
