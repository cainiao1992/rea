import { describe, expect, it } from "vitest";

import { openAndVerifyLargeFixture } from "../../../../scripts/lib/real-hopper-exhaustive-search.mjs";

const normalize = (value: unknown): unknown => value;

describe("real Hopper complete inline search", () => {
  it("verifies every procedure and string from one result per search", async () => {
    const client = fixtureClient(205);
    await expect(
      openAndVerifyLargeFixture({
        client,
        options: {},
        normalizedResult: normalize,
        path: "/fixture",
        expectedCount: 205,
        symbolPrefix: "_rea_fixture_",
        stringPrefix: "REA_FIXTURE_",
      }),
    ).resolves.toEqual({
      procedures: { count: 205, calls: 1 },
      strings: { count: 205, calls: 1 },
    });
    expect(client.calls).toEqual([
      "open_binary",
      "search_procedures",
      "search_strings",
    ]);
  });

  it.each(["duplicate", "wrong-count", "missing"] as const)(
    "rejects %s positive evidence",
    async (fault) => {
      await expect(
        openAndVerifyLargeFixture({
          client: fixtureClient(205, fault),
          options: {},
          normalizedResult: normalize,
          path: "/fixture",
          expectedCount: 205,
          symbolPrefix: "_rea_fixture_",
          stringPrefix: "REA_FIXTURE_",
        }),
      ).rejects.toThrow();
    },
  );
});

const fixtureClient = (
  count: number,
  fault?: "duplicate" | "wrong-count" | "missing",
) => {
  const calls: string[] = [];
  return {
    calls,
    callTool: async (request: unknown) => {
      const parsed = request as { name: string };
      calls.push(parsed.name);
      if (parsed.name === "open_binary") return { isError: false };
      const procedures = parsed.name === "search_procedures";
      const resultCount = fault === "wrong-count" ? count - 1 : count;
      const items = Array.from({ length: resultCount }, (_, index) => {
        const duplicateIndex = fault === "duplicate" && index === 1 ? 0 : index;
        return {
          address: `0x${(0x1000 + index).toString(16)}`,
          value: `${procedures ? "_rea_fixture_" : "REA_FIXTURE_"}${String(duplicateIndex).padStart(4, "0")}`,
        };
      });
      if (fault === "missing") items.pop();
      return items;
    },
  };
};
