import { describe, expect, it } from "vitest";

import { ok } from "../domain/result.js";
import { traceLiteralFeature } from "./EnhancedLiteralTracing.js";

describe("literal feature tracing", () => {
  it("searches procedure and string names before following references", async () => {
    const calls: string[] = [];
    const result = await traceLiteralFeature(
      async (name) => {
        calls.push(name);
        if (name === "search_strings")
          return ok([{ address: "0x1000", value: "launch feature" }]);
        if (name === "search_procedures")
          return ok([{ address: "0x2000", value: "launchFeature" }]);
        if (name === "xrefs") return ok([]);
        if (name === "resolve_containing_procedure") return ok(null);
        throw new Error(`Unexpected analysis call: ${name}`);
      },
      { query: "launch feature", case_sensitive: false },
      "feature",
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        matches: [
          { type: "string", address: "0x1000", value: "launch feature" },
          { type: "procedure", address: "0x2000", value: "launchFeature" },
        ],
        references: [],
      },
    });
    expect(calls).toEqual([
      "search_strings",
      "search_procedures",
      "search_strings",
      "search_procedures",
      "xrefs",
      "xrefs",
    ]);
  });

  it("keeps string-code tracing scoped to string labels", async () => {
    const calls: string[] = [];
    await traceLiteralFeature(
      async (name) => {
        calls.push(name);
        if (name === "search_strings")
          return ok([{ address: "0x1000", value: "launch feature" }]);
        if (name === "xrefs") return ok([]);
        throw new Error(`Unexpected analysis call: ${name}`);
      },
      { query: "launch", case_sensitive: false },
      "string",
    );

    expect(calls).toEqual(["search_strings", "xrefs"]);
  });
});
