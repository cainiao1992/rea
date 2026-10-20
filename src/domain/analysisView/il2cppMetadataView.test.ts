import { afterEach, expect, it, vi } from "vitest";
import {
  IL2CPP_METADATA_SECTION_NAMES,
  il2cppMetadataParentSchema,
  type Il2cppMetadata,
} from "../il2cpp/il2cppMetadata.js";
import { createEvidence } from "../evidence.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import { jsonObjectSchema } from "../jsonValue.js";
import { projectIl2cppMetadataView } from "./il2cppMetadataView.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const report: Il2cppMetadata = {
  artifact: {
    path: "/artifacts/global-metadata.dat",
    sha256: "a".repeat(64),
    bytes: 1024,
  },
  magic: 0xfab11baf,
  metadata_version: 39,
  index_widths: {
    type_definition: 1,
    generic_container: 1,
    parameter: 1,
    type: 1,
    type_width_source: "interface-offsets-record",
  },
  sections: IL2CPP_METADATA_SECTION_NAMES.map((name) => ({
    name,
    offset: 380,
    size: 0,
    count: 0,
  })),
  images: [{ name: "A.dll", type_start: 0, type_count: 2 }],
  types: [
    {
      name: "Outer",
      namespace: "N",
      method_start: 0,
      method_count: 1,
      nested_type_start: 0,
      nested_type_count: 1,
      declaring_type: -1,
    },
    {
      name: "Inner",
      namespace: "",
      method_start: -1,
      method_count: 0,
      nested_type_start: -1,
      nested_type_count: 0,
      declaring_type: 0,
    },
  ],
  methods: [{ name: "Run", declaring_type: 0 }],
  fields: [{ name: "value", declaring_type: 0 }],
  properties: [],
  events: [],
  parameters: [{ name: "times", method: 0 }],
  string_literals: [{ value: "Go", value_base64: null }],
  limitations: [],
};

const parent = (normalizedResult: unknown, sealedResult: boolean) => ({
  evidenceId: `ev_${"b".repeat(64)}`,
  operation: "inspect_il2cpp_metadata",
  normalizedResult,
  sealedResult,
  limitations: [],
});

const page = {
  kind: "il2cpp-metadata",
  collection: "types",
  offset: 0,
  limit: 1,
} as const;

it("validates a sealed parent once across pages and keeps counts exact", () => {
  const parse = vi.spyOn(il2cppMetadataParentSchema, "safeParse");
  const sealed = parent(freezeJsonSnapshot(structuredClone(report)), true);
  for (const offset of [0, 1]) {
    const view = projectIl2cppMetadataView(sealed, { ...page, offset });
    if (!view.ok) throw view.error;
    expect(view.value).toMatchObject({
      items: [{ index: offset, ...report.types[offset] }],
      counts: {
        sections: report.sections.length,
        images: 1,
        types: 2,
        methods: 1,
        nested_types: 1,
        fields: 1,
        properties: 0,
        events: 0,
        parameters: 1,
        string_literals: 1,
      },
    });
  }
  expect(parse).toHaveBeenCalledTimes(1);
});

it("revalidates unsealed inline input on every page", () => {
  const parse = vi.spyOn(il2cppMetadataParentSchema, "safeParse");
  const inline = parent(structuredClone(report), false);
  projectIl2cppMetadataView(inline, page);
  projectIl2cppMetadataView(inline, page);
  expect(parse).toHaveBeenCalledTimes(2);
});

it("preserves historical omission as unknown while keeping existing metadata queries usable", () => {
  const historical = jsonObjectSchema.parse(report);
  for (const key of [
    "fields",
    "properties",
    "events",
    "parameters",
    "string_literals",
  ])
    delete historical[key];
  const source = parent(freezeJsonSnapshot(historical), true);
  const summary = projectIl2cppMetadataView(source, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value).toMatchObject({
    summary: {
      counts: { types: 2, methods: 1, fields: null, parameters: null },
    },
    unknowns: expect.arrayContaining([
      expect.stringContaining("did not collect fields"),
    ]),
  });
  const existing = projectIl2cppMetadataView(source, page);
  if (!existing.ok) throw existing.error;
  expect(existing.value).toMatchObject({
    items: [{ index: 0, name: "Outer" }],
  });
  const unavailable = projectIl2cppMetadataView(source, {
    kind: "il2cpp-metadata",
    collection: "parameters",
    offset: 0,
    limit: 1,
  });
  expect(unavailable.ok).toBe(false);
});

it.each([
  { fields: [{ name: "bad", declaring_type: 2 }] },
  { parameters: [{ name: "bad", method: 1 }] },
  { string_literals: [{ value: null, value_base64: null }] },
  { string_literals: [{ value: "Go", value_base64: "R28=" }] },
])(
  "rejects inconsistent member ownership or literal representation in authenticated parent facts: %j",
  (changed) => {
    const result = projectIl2cppMetadataView(
      parent({ ...report, ...changed }, false),
      { kind: "summary" },
    );
    expect(result.ok).toBe(false);
  },
);

it("selects a batch of parameter owners before paging and intersects exact identities and names", () => {
  const source = parent(
    freezeJsonSnapshot({
      ...report,
      parameters: [
        { name: "first", method: 0 },
        { name: "unclaimed", method: -1 },
        { name: "last", method: 0 },
      ],
    }),
    true,
  );
  const query = {
    kind: "il2cpp-metadata",
    collection: "parameters",
    method_indices: [0, 0, 99],
    fields: ["name", "method"],
    offset: 1,
    limit: 1,
  } as const;
  const result = projectIl2cppMetadataView(source, {
    ...query,
    method_indices: [...query.method_indices],
    fields: [...query.fields],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    items: [{ index: 2, name: "last", method: 0 }],
    coverage: { total: 2, exhausted: true, next_offset: null },
  });
  for (const selection of [
    { method_indices: [] },
    { method_indices: [99] },
    { method_indices: [0], indices: [1] },
    { method_indices: [0], names: ["unclaimed"] },
  ]) {
    const empty = projectIl2cppMetadataView(source, {
      ...query,
      ...selection,
      offset: 0,
      fields: [...query.fields],
    });
    if (!empty.ok) throw empty.error;
    expect(empty.value).toMatchObject({
      items: [],
      coverage: { total: 0, exhausted: true },
    });
  }
});

it("intersects batch identities, fields, image ranges and exact names in source order", () => {
  const source = parent(freezeJsonSnapshot(structuredClone(report)), true);
  const result = projectIl2cppMetadataView(source, {
    ...page,
    indices: [1, 0, 1, 100],
    image_indices: [0],
    names: ["Inner"],
    namespaces: [""],
    declaring_types: [0],
    fields: ["name"],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    items: [{ index: 1, name: "Inner" }],
    coverage: { total: 1, exhausted: true },
    counts: { images: 1, types: 2, methods: 1 },
  });
  const identityOnly = projectIl2cppMetadataView(source, {
    ...page,
    fields: [],
  });
  if (!identityOnly.ok) throw identityOnly.error;
  expect(identityOnly.value).toMatchObject({ items: [{ index: 0 }] });
});

it.each([
  "indices",
  "image_indices",
  "names",
  "namespaces",
  "declaring_types",
] as const)("keeps an empty %s selection empty", (field) => {
  const result = projectIl2cppMetadataView(parent(report, false), {
    ...page,
    [field]: [],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    items: [],
    coverage: { total: 0, exhausted: true },
  });
});

it("does not trust a forged seal flag or a shallow frozen mutable report", () => {
  const mutable = structuredClone(report);
  Object.freeze(mutable);
  const source = parent(mutable, true);
  const first = projectIl2cppMetadataView(source, page);
  if (!first.ok) throw first.error;
  mutable.types[0]!.name = "Changed";
  const second = projectIl2cppMetadataView(source, page);
  if (!second.ok) throw second.error;
  expect(second.value).toMatchObject({
    items: [{ index: 0, name: "Changed" }],
  });
});

it("refuses a parent whose subject contradicts the recorded artifact identity", () => {
  const result = projectIl2cppMetadataView(
    {
      ...parent(report, false),
      subject: createEvidence(
        { path: report.artifact.path, format: "file", sha256: "c".repeat(64) },
        { id: "fixture", name: "fixture", version: "1" },
        {
          operation: "inspect_il2cpp_metadata",
          parameters: {},
          result: report,
        },
      ).subject,
    },
    page,
  );
  expect(result.ok).toBe(false);
});
