import { describe, expect, it } from "vitest";

import { inferJsonShape } from "./jsonShape.js";

describe("inferJsonShape", () => {
  it("retains paths and types without retaining JSON values", () => {
    const shape = inferJsonShape(
      JSON.stringify({
        token: "super-secret",
        users: [
          { id: 1, active: true },
          { id: "second-secret", active: false },
        ],
        optional: null,
      }),
    );

    expect(shape).toMatchObject({
      root_type: "object",
      properties: expect.arrayContaining([
        { path: "/token", types: ["string"], observations: 1 },
        {
          path: "/users/*/id",
          types: ["number", "string"],
          observations: 2,
        },
        {
          path: "/users/*/active",
          types: ["boolean"],
          observations: 2,
        },
      ]),
    });
    expect(JSON.stringify(shape)).not.toContain("super-secret");
    expect(JSON.stringify(shape)).not.toContain("second-secret");
  });

  it("rejects malformed JSON", () => {
    expect(inferJsonShape("not-json")).toBeNull();
  });

  it("preserves pointer escaping and code-point ordering independently of key insertion order", () => {
    for (const reverse of [false, true]) {
      const object = (number: number, value: unknown) => {
        const entries = [
          ["é/~", number],
          ["e\u0301/~", value],
          ["e\u0341/~", true],
          ["A", false],
          ["_", false],
          ["a", false],
          ["z", false],
          ["\u{10000}", false],
          ["\uE000", false],
        ];
        return Object.fromEntries(reverse ? entries.reverse() : entries);
      };
      const shape = inferJsonShape(
        JSON.stringify({ nested: [object(1, null), object(2, [null])] }),
      );

      expect(shape).toEqual({
        root_type: "object",
        node_count: 23,
        max_depth_observed: 4,
        properties: [
          { path: "/nested", types: ["array"], observations: 1 },
          { path: "/nested/*/A", types: ["boolean"], observations: 2 },
          { path: "/nested/*/_", types: ["boolean"], observations: 2 },
          { path: "/nested/*/a", types: ["boolean"], observations: 2 },
          {
            path: "/nested/*/e\u0301~1~0",
            types: ["array", "null"],
            observations: 2,
          },
          {
            path: "/nested/*/e\u0341~1~0",
            types: ["boolean"],
            observations: 2,
          },
          { path: "/nested/*/z", types: ["boolean"], observations: 2 },
          { path: "/nested/*/é~1~0", types: ["number"], observations: 2 },
          { path: "/nested/*/\uE000", types: ["boolean"], observations: 2 },
          { path: "/nested/*/\u{10000}", types: ["boolean"], observations: 2 },
        ],
      });
    }
  });

  it("retains every parsed property beyond the former shape-node limit", () => {
    const content = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [`field_${index}`, index]),
    );
    const shape = inferJsonShape(JSON.stringify(content));

    expect(shape?.properties).toHaveLength(5_001);
    expect(shape?.node_count).toBe(5_002);
    expect(shape?.properties).toContainEqual({
      path: "/field_5000",
      types: ["number"],
      observations: 1,
    });
  });
});
