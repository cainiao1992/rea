import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  jsonObjectSchema,
  jsonValueSchema,
  MAX_JSON_DEPTH,
} from "./jsonValue.js";

const values = [
  "text",
  0,
  false,
  null,
  [],
  {},
  { nested: [{ deeper: [1, "two", null, { three: true }] }] },
];

it("projects JSON values without recursive definitions", () => {
  for (const io of ["input", "output"] as const) {
    const schema = z.toJSONSchema(
      z.object({ value: jsonValueSchema, map: jsonObjectSchema }),
      { io },
    );
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(schema).not.toHaveProperty("$defs");
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const value of values)
      expect(validate({ value, map: { value } })).toBe(true);
    expect(validate({ value: 1, map: [] })).toBe(false);
  }
});

it("still parses only JSON values at runtime", () => {
  for (const value of values)
    expect(jsonValueSchema.safeParse(value).success).toBe(true);
  for (const value of [undefined, Number.NaN, Infinity, () => 0, [undefined]])
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
});

const deepObject = (depth: number): unknown => {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
};

describe("jsonValueSchema depth bound", () => {
  it("accepts values nested to the maximum depth", () => {
    expect(jsonValueSchema.safeParse(deepObject(MAX_JSON_DEPTH)).success).toBe(
      true,
    );
  });

  it("rejects values nested past the maximum depth without throwing", () => {
    const result = jsonValueSchema.safeParse(deepObject(MAX_JSON_DEPTH + 1));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("maximum nesting depth");
  });

  it.each(["object", "array"])(
    "rejects the original 10000-level %s crash without throwing",
    (kind) => {
      let value: unknown = 1;
      for (let index = 0; index < 10_000; index += 1)
        value = kind === "object" ? { nested: value } : [value];
      const result = jsonValueSchema.safeParse(value);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]?.message).toContain(
        "maximum nesting depth",
      );
    },
  );

  it("rejects cyclic values instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = jsonValueSchema.safeParse(cyclic);
    expect(result.success).toBe(false);
  });

  it("keeps json semantics for non-JSON values", () => {
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse({ a: Number.NaN }).success).toBe(false);
    expect(
      jsonValueSchema.safeParse({ a: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(jsonValueSchema.safeParse({ a: 1n }).success).toBe(false);
  });

  it("accepts ordinary nested JSON", () => {
    expect(
      jsonValueSchema.safeParse({
        list: [1, "two", null, true, { deep: { further: [{}] } }],
      }).success,
    ).toBe(true);
  });
});
