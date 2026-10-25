import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { advertisedInputExamples } from "./advertisedInputExamples.js";
import {
  ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  fitAdvertisedInputSchema,
  presentInputJsonSchema,
  summarizedInputSchemaCandidate,
  summarizedSchema,
} from "./inputSchemaPresentation.js";
import {
  schemaArrays,
  schemaChildren,
  schemaLiteralValues,
  schemaMaps,
} from "./jsonSchemaKeywords.js";
import { TOOL_CONTRACTS } from "./toolContracts.js";

type Schema = Record<string, unknown>;

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const isObject = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The self-contained projection before fitting, with its advertised examples. */
const completeProjection = (
  contract: (typeof TOOL_CONTRACTS)[number],
): Schema => {
  const inline = contract.inputSchema["~standard"].jsonSchema.input({
    target: "draft-2020-12",
    libraryOptions: { reused: "inline" },
  }) as Schema;
  const examples = advertisedInputExamples(contract);
  return {
    ...presentInputJsonSchema(inline, () => undefined),
    ...(examples.length === 0 ? {} : { examples }),
  };
};

/** Every subschema in a schema position, ignoring literal data. */
const subschemas = function* (schema: unknown): Generator<Schema> {
  if (!isObject(schema)) return;
  yield schema;
  for (const [key, child] of Object.entries(schema)) {
    if (schemaLiteralValues.has(key)) continue;
    if (schemaMaps.has(key) && isObject(child))
      for (const nested of Object.values(child)) yield* subschemas(nested);
    else if (schemaArrays.has(key) && Array.isArray(child))
      for (const nested of child) yield* subschemas(nested);
    else if (schemaChildren.has(key))
      for (const nested of Array.isArray(child) ? child : [child])
        yield* subschemas(nested);
  }
};

/** Every JSON value nested in a value, including the value itself. */
const values = function* (value: unknown): Generator<unknown> {
  yield value;
  if (Array.isArray(value)) for (const item of value) yield* values(item);
  else if (isObject(value))
    for (const item of Object.values(value)) yield* values(item);
};

const GENERIC_PROBES: readonly unknown[] = [
  null,
  true,
  false,
  0,
  1,
  -1,
  1.5,
  "",
  "a",
  [],
  [null],
  [1],
  ["a"],
  ["a", 1],
  [[]],
  [{}],
  {},
  { kind: "a" },
];

/** Assert a summary accepts every probe the complete schema accepts. */
const expectSummaryWidens = (
  schemas: Iterable<Schema>,
  probes: readonly unknown[],
  dialect: "draft-2020-12" | "draft-07" = "draft-2020-12",
): number => {
  const options = { strict: false, validateFormats: false };
  const ajv = dialect === "draft-07" ? new Ajv(options) : new Ajv2020(options);
  const seen = new Set<string>();
  const failures: string[] = [];
  for (const schema of schemas) {
    const key = JSON.stringify(schema);
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = summarizedSchema(schema);
    const complete = ajv.compile(schema);
    const summarized = ajv.compile(summary);
    for (const probe of probes)
      if (complete(probe) && !summarized(probe))
        failures.push(
          `${key.slice(0, 200)} -> ${JSON.stringify(summary)} rejects ${JSON.stringify(probe).slice(0, 200)}`,
        );
    ajv.removeSchema();
  }
  expect(failures).toEqual([]);
  return seen.size;
};

const SYNTHETIC_SUMMARIES: readonly Schema[] = [
  // 2020-12 tuple positions with a differently typed rest.
  {
    type: "array",
    prefixItems: [{ type: "string" }],
    items: { type: "number" },
  },
  { type: "array", prefixItems: [{ type: "string" }] },
  { type: "array", prefixItems: [{ type: "string" }], items: false },
  { type: "array", items: { type: "string" }, contains: { const: "a" } },
  {
    anyOf: [
      { type: "array", prefixItems: [{ type: "boolean" }] },
      { type: "null" },
    ],
  },
  { type: ["array", "null"], items: { type: "string" }, minItems: 1 },
  { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  { not: { type: "string" } },
  { allOf: [{ type: "string" }, { minLength: 1 }] },
  { oneOf: [{ const: 1 }, { enum: ["a", null] }] },
  {
    if: { type: "string" },
    then: { minLength: 1 },
    else: { type: "number" },
  },
];

const DRAFT_07_TUPLES: readonly Schema[] = [
  {
    type: "array",
    items: [{ type: "string" }],
    additionalItems: { type: "number" },
  },
  { type: "array", items: [{ type: "string" }] },
  { type: "array", items: [{ type: "string" }], additionalItems: false },
];

it("summarizes synthetic schemas without rejecting values they accept", () => {
  expect(
    summarizedSchema({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    }),
  ).toEqual({ type: "array", items: { type: ["string", "number"] } });
  expectSummaryWidens(SYNTHETIC_SUMMARIES, [
    ...GENERIC_PROBES,
    [true],
    ["a", "b", 2],
    [1, "a"],
    [false, null],
  ]);
  expectSummaryWidens(
    DRAFT_07_TUPLES,
    [...GENERIC_PROBES, ["a", 2], ["a", "b"]],
    "draft-07",
  );
});

it("summarizes every catalog input subschema without rejecting values it accepts", () => {
  const projections = TOOL_CONTRACTS.map(completeProjection);
  // Canonical example values reach deep nested subschemas with valid data.
  const probes = [
    ...GENERIC_PROBES,
    ...new Map(
      projections
        .flatMap((schema) =>
          Array.isArray(schema.examples) ? schema.examples : [],
        )
        .flatMap((example) => [...values(example)])
        .map((value) => [JSON.stringify(value), value] as const),
    ).values(),
  ];
  const checked = expectSummaryWidens(
    projections.flatMap((schema) =>
      [...subschemas(schema)].filter((node) => node !== schema),
    ),
    probes,
  );
  expect(checked).toBeGreaterThan(1000);
}, 120_000);

/** Assert no candidate keeping more levels than the fitted one also fits. */
const expectDeepestFittingCandidate = (schema: Schema): void => {
  const fitted = fitAdvertisedInputSchema(schema);
  expect(bytes(fitted)).toBeLessThanOrEqual(
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  const described = { ...schema, description: fitted.description };
  const candidates = Array.from({ length: 40 }, (_, index) =>
    summarizedInputSchemaCandidate(described, index + 1),
  );
  const deepest = candidates.findLastIndex(
    (candidate) => bytes(candidate) <= ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  expect(deepest).toBeGreaterThanOrEqual(0);
  expect(fitted).toEqual(candidates[deepest]);
};

it("keeps a deeper fitting candidate when a shallower summary is longer", () => {
  // A nullable array summary needs anyOf, so it is longer than the schema.
  const nullable = { type: ["array", "null"], items: { type: "string" } };
  const schema = {
    type: "object",
    properties: {
      ...Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [
          `list_${index}`,
          nullable,
        ]),
      ),
      // Retaining its third level would overflow; its second level fits.
      large: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: {
              text: { type: "string", description: "x".repeat(30_000) },
            },
          },
        },
      },
    },
  };
  // Summarizing every list at the first level would overflow by itself.
  expect(1_000 * bytes(summarizedSchema(nullable))).toBeGreaterThan(
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  expect(bytes(schema)).toBeGreaterThan(ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES);
  const fitted = fitAdvertisedInputSchema(schema);
  expect(bytes(fitted)).toBeLessThanOrEqual(
    ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  const properties = fitted.properties as Record<string, any>;
  expect(properties.list_0).toEqual(nullable);
  expect(properties.large.properties.inner).toEqual({ type: "object" });
  expectDeepestFittingCandidate(schema);
});

it("fits oversized catalog input schemas at their deepest fitting level", () => {
  const oversized = TOOL_CONTRACTS.map(completeProjection).filter(
    (schema) => bytes(schema) > ADVERTISED_INPUT_SCHEMA_LIMIT_BYTES,
  );
  expect(oversized.length).toBeGreaterThan(0);
  for (const schema of oversized) expectDeepestFittingCandidate(schema);
}, 120_000);
