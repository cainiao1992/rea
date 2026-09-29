import { describe, expect, it } from "vitest";

import { isJsonWithinDepth, isJsonWithinLimits } from "./jsonLimits.js";

const limits = {
  maxDepth: 3,
  maxStringLength: 8,
  maxNodes: 6,
};

describe("JSON limits", () => {
  it("checks depth without rejecting large keys, collections, or strings", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [
        `${"k".repeat(128)}${index}`,
        "v".repeat(4_097),
      ]),
    );

    expect(isJsonWithinDepth(properties, 6)).toBe(true);
    expect(isJsonWithinDepth({ nested: { value: true } }, 1)).toBe(false);
  });

  it("traverses nested object and array values", () => {
    expect(isJsonWithinLimits({ one: ["two", { three: 3 }] }, limits)).toBe(
      true,
    );
    expect(
      isJsonWithinLimits({ one: ["two", { three: "too-long-value" }] }, limits),
    ).toBe(false);
  });

  it("enforces depth, node, and object-key limits", () => {
    expect(
      isJsonWithinLimits(
        { one: { two: { three: null } } },
        {
          ...limits,
          maxDepth: 2,
        },
      ),
    ).toBe(false);
    expect(isJsonWithinLimits([1, 2, 3], { ...limits, maxNodes: 3 })).toBe(
      false,
    );
    expect(isJsonWithinLimits({ "too-long-key": true }, limits)).toBe(false);
  });
});
