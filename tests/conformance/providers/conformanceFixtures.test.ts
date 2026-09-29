import { describe, expect, it } from "vitest";

import {
  generateLargeFixture,
  LARGE_FIXTURE_COUNT,
  sha256,
  sourceDigest,
} from "../../../scripts/lib/conformance-fixtures.mjs";

describe("source-built conformance fixtures", () => {
  it("generates deterministic large-fixture source", () => {
    const first = generateLargeFixture();
    const second = generateLargeFixture();

    expect(first).toBe(second);
    expect(first).toContain("rea_inventory_0000");
    expect(first).toContain(
      `rea_inventory_${String(LARGE_FIXTURE_COUNT - 1).padStart(4, "0")}`,
    );
  });

  it("hashes source manifests independently of input ordering", () => {
    const left = [
      { path: "b.c", content: "b" },
      { path: "a.c", content: "a" },
    ];
    const right = [...left].reverse();

    expect(sourceDigest(left)).toBe(sourceDigest(right));
    expect(sourceDigest(left)).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256("fixture")).not.toBe(sha256("changed"));
  });
});
