import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { presentAdvertisedInputSchema } from "./compactInputSchema.js";
import {
  ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  fitAdvertisedInputSchema,
  presentAdvertisedInputProfile,
  presentInputJsonSchema,
} from "./inputSchemaPresentation.js";

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const ajv = () => new Ajv2020({ strict: false, validateFormats: false });

/** A strict object `levels` deep with `width` distinct padded string leaves. */
const record = (
  levels: number,
  width: number,
  pad = 80,
  path = "f",
): Record<string, unknown> => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: width }, (_, index) => [
      `field_${index}`,
      levels <= 1
        ? {
            type: "string",
            minLength: 1,
            description: `Leaf ${path}.${index} ${"x".repeat(pad)}`,
          }
        : {
            ...record(levels - 1, width, pad, `${path}.${index}`),
            description: `Level ${index}`,
          },
    ]),
  ),
  required: ["field_0"],
  additionalProperties: false,
});

const instance = (levels: number, width: number): Record<string, any> =>
  Object.fromEntries(
    Array.from({ length: width }, (_, index) => [
      `field_${index}`,
      levels <= 1 ? "value" : instance(levels - 1, width),
    ]),
  );

const expectWidened = (
  original: Record<string, unknown>,
  fitted: Record<string, unknown>,
  inputs: readonly unknown[],
) => {
  const validateOriginal = ajv().compile(original);
  const validateFitted = ajv().compile(fitted);
  for (const input of inputs)
    if (validateOriginal(input))
      expect(validateFitted(input), JSON.stringify(validateFitted.errors)).toBe(
        true,
      );
};

it("returns schemas that already fit unchanged", () => {
  const schema = {
    type: "object",
    properties: { capture: record(3, 4) },
    examples: [{ capture: instance(3, 4) }],
  };
  expect(bytes(schema)).toBeLessThan(ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES);
  expect(fitAdvertisedInputSchema(schema)).toBe(schema);
});

it("points repeated sibling properties at the first instead of repeating them", () => {
  const capture = record(3, 7, 40);
  const schema = {
    type: "object",
    description: "Compare two captures.",
    properties: {
      before: { ...capture, description: "Earlier capture." },
      after: { ...capture, description: "Later capture." },
      unrelated: { type: "string" },
    },
    required: ["before", "after"],
    additionalProperties: false,
    examples: [{ before: instance(3, 7), after: instance(3, 7) }],
  };
  expect(bytes(schema)).toBeGreaterThan(ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES);
  expect(bytes(capture)).toBeLessThan(ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES);

  const fitted = fitAdvertisedInputSchema(schema);
  expect(bytes(fitted)).toBeLessThanOrEqual(
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  expect(fitted).toMatchObject({
    description: expect.stringMatching(
      /^Compare two captures\. .*summarized form.*complete canonical inputs\.$/u,
    ),
    properties: {
      before: schema.properties.before,
      after: {
        type: "object",
        description: "Later capture. Same schema as `before`.",
      },
      unrelated: { type: "string" },
    },
    required: ["before", "after"],
    additionalProperties: false,
    examples: schema.examples,
  });
  expect(Object.keys(fitted.properties as object)).toEqual([
    "before",
    "after",
    "unrelated",
  ]);
  expect(ajv().validateSchema(fitted)).toBe(true);
  expectWidened(schema, fitted, [
    ...schema.examples,
    { before: instance(3, 7), after: { field_0: { field_0: {} } } },
  ]);
});

it("keeps the deepest instance level that fits and summarizes below it", () => {
  const schema = {
    type: "object",
    properties: { capture: record(4, 6) },
    additionalProperties: false,
  };
  expect(bytes(schema)).toBeGreaterThan(ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES);
  const fitted = fitAdvertisedInputSchema(schema);
  expect(bytes(fitted)).toBeLessThanOrEqual(
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  const capture = (fitted.properties as Record<string, any>).capture;
  // Third-level objects keep their properties; fourth-level ones are summarized.
  const third = capture.properties.field_1.properties.field_2;
  expect(third).toMatchObject({
    required: ["field_0"],
    additionalProperties: false,
  });
  expect(third.properties.field_3).toEqual({
    type: "object",
    description: "Level 3",
  });
  expectWidened(schema, fitted, [
    { capture: instance(4, 6) },
    { capture: { field_0: { field_0: { field_0: { field_0: "" } } } } },
  ]);
});

it("counts combinator and conditional branches at their instance level", () => {
  const branch = (kind: string) => ({
    type: "object",
    properties: {
      kind: { type: "string", enum: [kind] },
      body: record(3, 9),
    },
    required: ["kind", "body"],
    additionalProperties: false,
  });
  const schema = {
    type: "object",
    properties: {
      value: { anyOf: [branch("a"), branch("b"), { type: "null" }] },
    },
  };
  expect(bytes(schema)).toBeGreaterThan(ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES);
  const fitted = fitAdvertisedInputSchema(schema);
  const value = (fitted.properties as Record<string, any>).value;
  // The union keeps every branch and its own properties at level two.
  expect(value.anyOf).toHaveLength(3);
  expect(value.anyOf[0].properties.kind).toEqual({
    type: "string",
    enum: ["a"],
  });
  expect(value.anyOf[2]).toEqual({ type: "null" });
});

it("relaxes nonmonotone positions instead of narrowing them", () => {
  const deep = record(3, 7);
  const schema = {
    type: "object",
    properties: {
      exactly_one: {
        oneOf: [
          { ...deep, required: ["field_0"] },
          { ...deep, required: ["field_1"] },
        ],
      },
      excluded: { type: "object", not: deep },
      conditional: {
        type: "object",
        if: deep,
        then: { required: ["field_0"] },
        else: { required: ["field_1"] },
      },
      bounded: { type: "array", contains: deep, maxContains: 1 },
    },
  };
  expect(bytes(schema)).toBeGreaterThan(ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES);
  const fitted = fitAdvertisedInputSchema(schema);
  expect(bytes(fitted)).toBeLessThanOrEqual(
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  const properties = fitted.properties as Record<string, any>;
  expect(properties.exactly_one.oneOf).toBeUndefined();
  expect(properties.exactly_one.anyOf).toHaveLength(2);
  expect(properties.excluded).not.toHaveProperty("not");
  expect(properties.conditional).not.toHaveProperty("if");
  expect(properties.conditional).not.toHaveProperty("then");
  expect(properties.bounded).not.toHaveProperty("maxContains");
  const valid = instance(3, 7);
  expectWidened(schema, fitted, [
    { exactly_one: { field_0: valid.field_0 } },
    { exactly_one: { field_1: valid.field_1 } },
    { excluded: { other: true } },
    { conditional: { field_1: valid.field_1 } },
    { conditional: valid },
    { bounded: [valid, { field_0: 1 }] },
  ]);
});

it("advertises items only beside the single array type", () => {
  const rows = {
    type: "array",
    items: { type: "object", properties: { id: { type: "string" } } },
    minItems: 1,
    description: "Rows.",
  };
  const schema = {
    type: "object",
    properties: {
      // Its large leaf one level deeper limits the retained depth to two.
      large: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: {
              text: { type: "string", description: "x".repeat(70_000) },
            },
          },
        },
      },
      arrays: {
        type: "object",
        properties: {
          rows,
          optional_rows: { anyOf: [rows, { type: "null" }] },
          cube: { type: "array", items: { type: "array", items: rows } },
        },
      },
    },
  };
  const fitted = fitAdvertisedInputSchema(schema);
  expect(bytes(fitted)).toBeLessThanOrEqual(
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  expect((fitted.properties as Record<string, any>).arrays).toEqual({
    type: "object",
    properties: {
      rows: {
        type: "array",
        items: { type: "object" },
        minItems: 1,
        description: "Rows.",
      },
      optional_rows: {
        anyOf: [{ type: "array", items: { type: "object" } }, { type: "null" }],
      },
      cube: { type: "array", items: {} },
    },
  });
  expectWidened(schema, fitted, [
    {
      arrays: {
        rows: [{ id: "a" }],
        optional_rows: null,
        cube: [[[{ id: "c" }]]],
      },
    },
    { arrays: { optional_rows: [{ id: "b" }] } },
  ]);
});

it("falls back to the compact projection for schemas with local references", () => {
  const schema = {
    type: "object",
    $defs: { capture: record(3, 12) },
    properties: {
      before: { $ref: "#/$defs/capture" },
      after: { $ref: "#/$defs/capture" },
    },
  };
  const fitted = fitAdvertisedInputSchema(schema);
  expect(bytes(fitted)).toBeLessThanOrEqual(
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  expect(JSON.stringify(fitted)).not.toContain("$ref");
  expect(ajv().validateSchema(fitted)).toBe(true);
});

it("presents the compact profile from the complete projection", () => {
  const capture = record(3, 7);
  const complete = {
    type: "object",
    properties: {
      before: { ...capture, description: "Earlier capture." },
      after: { ...capture, description: "Later capture." },
    },
  };
  const fitted = fitAdvertisedInputSchema(complete);
  expect(fitted).not.toEqual(complete);
  const budget = { budgetBytes: 13 * 1024 };
  expect(presentAdvertisedInputProfile(fitted, budget)).toEqual(
    presentAdvertisedInputSchema(complete, budget),
  );
  expect(presentAdvertisedInputProfile(fitted, undefined)).toBe(fitted);
});

describe("advertised numeric literals", () => {
  it("relaxes numeric const and enum members without narrowing", () => {
    const schema = {
      type: "object",
      properties: {
        version: { type: "integer", const: 2 },
        ratio: { const: 0.5 },
        level: { enum: [1, 2, 3] },
        mixed: { enum: ["auto", 7] },
        not_two: { type: "integer", not: { const: 2 } },
      },
    };
    const presented = presentInputJsonSchema(schema, () => undefined);
    expect(presented.properties).toEqual({
      version: { type: "integer" },
      ratio: { type: "number" },
      level: { type: "integer" },
      mixed: { type: ["string", "integer"] },
      not_two: { type: "integer" },
    });
    expectWidened(schema, presented, [
      { version: 2, ratio: 0.5, level: 3, mixed: "auto", not_two: 3 },
      { mixed: 7 },
    ]);
  });

  it("drops unevaluated keywords when relaxing an applicator they depend on", () => {
    const schema = {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: { mode: { type: "integer" } },
          if: { properties: { mode: { const: 2 } }, required: ["mode"] },
          then: { properties: { extra: { type: "string" } } },
          unevaluatedProperties: false,
        },
      },
    };
    const presented = presentInputJsonSchema(schema, () => undefined);
    expect(presented.properties).toEqual({
      options: { type: "object", properties: { mode: { type: "integer" } } },
    });
    expectWidened(schema, presented, [
      { options: { mode: 2, extra: "kept" } },
      { options: { mode: 1 } },
    ]);
  });
});
