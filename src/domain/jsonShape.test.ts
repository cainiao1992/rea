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
