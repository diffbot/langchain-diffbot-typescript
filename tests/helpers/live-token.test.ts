import { describe, expect, it } from "vitest";
import { DiffbotClient } from "@diffbot/typescript";
import { diffbotLiveClientToken, resolveDiffbotLiveToken } from "./live-token.js";

describe("resolveDiffbotLiveToken", () => {
  it("returns undefined when unset", () => {
    expect(resolveDiffbotLiveToken(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveDiffbotLiveToken("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only", () => {
    expect(resolveDiffbotLiveToken("   \t  ")).toBeUndefined();
  });

  it("returns trimmed token when non-empty", () => {
    const value = "abc";
    expect(resolveDiffbotLiveToken(value)).toBe(value);
    expect(resolveDiffbotLiveToken(`  ${value}  `)).toBe(value);
  });
});

describe("diffbotLiveClientToken", () => {
  it("uses placeholder when token is missing", () => {
    expect(diffbotLiveClientToken(undefined)).toBe("unused-token-suite-skipped");
  });

  it("passes through a resolved token", () => {
    const value = "resolved-token-value";
    expect(diffbotLiveClientToken(value)).toBe(value);
  });
});

describe("DiffbotClient construction for skip-path tokens", () => {
  it.each([undefined, "", "   "])(
    "does not throw when the env value is missing, empty, or whitespace",
    (value) => {
      expect(() => {
        new DiffbotClient({
          token: diffbotLiveClientToken(resolveDiffbotLiveToken(value)),
        });
      }).not.toThrow();
    },
  );
});
