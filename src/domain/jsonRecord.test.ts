import { expect, it } from "vitest";
import { z } from "zod";
import { jsonRecordSchema } from "./jsonRecord.js";
import type { JsonValue } from "./jsonValue.js";

it("owns every observed key while retaining normalized values", () => {
  const source: unknown = JSON.parse(
    '{"__proto__":"observed","constructor":"source","ordinary":"value"}',
  );
  const schema = jsonRecordSchema(
    z.string().transform((value) => value.toUpperCase()),
  );
  const parsed = schema.parse(source);
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(JSON.stringify(parsed)).toBe(
    '{"__proto__":"OBSERVED","constructor":"SOURCE","ordinary":"VALUE"}',
  );
  expect(JSON.stringify(source)).toBe(
    '{"__proto__":"observed","constructor":"source","ordinary":"value"}',
  );
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
});

it("prefixes value failures with every original key and nested value path", () => {
  const schema = jsonRecordSchema(z.strictObject({ name: z.string() }));
  const source: unknown = JSON.parse(
    '{"__proto__":{"name":7},"ordinary":{"name":false}}',
  );
  const parsed = schema.safeParse(source);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("Expected value validation failure");
  expect(parsed.error.issues.map(({ path }) => path)).toEqual([
    ["__proto__", "name"],
    ["ordinary", "name"],
  ]);
});

it("retains defaults produced within JSON entries without mutating their source", () => {
  const source: unknown = JSON.parse(
    '{"__proto__":{},"ordinary":{"name":"given"}}',
  );
  const schema = jsonRecordSchema(
    z.strictObject({ name: z.string().default("default") }),
  );
  const parsed = schema.parse(source);
  expect(JSON.stringify(parsed)).toBe(
    '{"__proto__":{"name":"default"},"ordinary":{"name":"given"}}',
  );
  expect(JSON.stringify(source)).toBe(
    '{"__proto__":{},"ordinary":{"name":"given"}}',
  );
});

it("keeps the canonical JSON input boundary before per-entry defaults", () => {
  const schema = jsonRecordSchema(z.string().default("default"));
  expect(schema.safeParse({ ordinary: undefined }).success).toBe(false);
  expect(schema.safeParse({ ordinary: Infinity }).success).toBe(false);
  expect(schema.safeParse([]).success).toBe(false);
  expect(schema.parse({})).toEqual({});
});

it.each(["draft-04", "draft-07", "draft-2020-12", "openapi-3.0"] as const)(
  "exports the same typed-record schema in every IO mode for %s",
  (target) => {
    const values: z.ZodType<JsonValue>[] = [
      z.string(),
      z.enum(["unknown", "object", "array"]),
      z.strictObject({ name: z.string().default("default") }),
    ];
    for (const value of values)
      for (const io of ["input", "output"] as const) {
        const actual = z.strictObject({ entries: jsonRecordSchema(value) });
        const expected = z.strictObject({
          entries: z.record(z.string(), value),
        });
        expect(z.toJSONSchema(actual, { target, io })).toEqual(
          z.toJSONSchema(expected, { target, io }),
        );
      }
  },
);

it("preserves input schema projection for a normalizing transform", () => {
  const value = z.string().transform((entry) => entry.toUpperCase());
  expect(z.toJSONSchema(jsonRecordSchema(value), { io: "input" })).toEqual(
    z.toJSONSchema(z.record(z.string(), value), { io: "input" }),
  );
  expect(() =>
    z.toJSONSchema(jsonRecordSchema(value), { io: "output" }),
  ).toThrow();
});

it.each(["draft-04", "draft-07", "draft-2020-12", "openapi-3.0"] as const)(
  "preserves shared schema references through Standard Schema export for %s",
  (target) => {
    const value = z.strictObject({ name: z.string().default("default") });
    const map = jsonRecordSchema(value);
    const record = z.record(z.string(), value);
    const actual = z.strictObject({ left: map, right: map, entry: value });
    const expected = z.strictObject({
      left: record,
      right: record,
      entry: value,
    });
    for (const io of ["input", "output"] as const)
      for (const reused of ["inline", "ref"] as const) {
        expect(z.toJSONSchema(actual, { target, io, reused })).toEqual(
          z.toJSONSchema(expected, { target, io, reused }),
        );
        const options = { target, libraryOptions: { reused } };
        expect(actual["~standard"].jsonSchema[io](options)).toEqual(
          expected["~standard"].jsonSchema[io](options),
        );
      }
  },
);
