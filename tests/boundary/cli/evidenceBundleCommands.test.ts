import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import {
  createResidualUnknown,
  updateResidualUnknown,
} from "../../../src/domain/residualUnknown.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const revisionBundle = () => {
  const records = ["open", "investigate"].map((operation) =>
    createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation, parameters: {}, result: { observed: operation } },
    ),
  );
  const [opened, investigated] = records;
  if (opened === undefined || investigated === undefined)
    throw new Error("Missing mutation Evidence");
  const details = {
    severity: "high" as const,
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    required_authority: null,
    required_confidence: "observed" as const,
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  };
  const initial = createResidualUnknown(
    { question: "How is this input handled?", domain: "protocol", ...details },
    opened.evidence_id,
    null,
  );
  const revised = updateResidualUnknown(
    initial,
    {
      unknown_id: initial.unknown_id,
      expected_revision: initial.revision,
      status: "investigating",
      ...details,
      resolution: null,
    },
    investigated.evidence_id,
  );
  return createEvidenceBundle(records, [initial, revised]);
};

cliTest.for([
  "export_evidence_bundle",
  "compare_bundles",
  "get_evidence_bundle",
])("attributes an early heap refusal to $0", async (operation, { cli }) => {
  const root = await createTestTempDirectory("rea-bundle-operation-");
  const path = join(root, "parent.json");
  const output = join(root, "output.json");
  await writeFile(path, JSON.stringify(revisionBundle()));
  const preload =
    "import v8 from 'node:v8';import {syncBuiltinESMExports} from 'node:module';const read=v8.getHeapStatistics;v8.getHeapStatistics=()=>({...read(),total_available_size:0});syncBuiltinESMExports();";
  const arguments_ =
    operation === "export_evidence_bundle"
      ? ["evidence-export", path, output]
      : operation === "compare_bundles"
        ? ["compare", path, path]
        : ["inspect-evidence-bundle", JSON.stringify({ path })];
  const result = await cli.run({
    arguments: [...arguments_, "--json"],
    environment: {
      REA_LOG_LEVEL: "silent",
      NODE_OPTIONS: `--max-old-space-size=2048 --import=data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`,
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "resource_constraint",
    details: { operation },
  });
  expect(await readdir(root)).toEqual(["parent.json"]);
});

cliTest(
  "reports standalone import counts for every unknown revision",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-import-");
    const path = join(root, "bundle.json");
    await writeFile(path, JSON.stringify(revisionBundle()));
    const result = await cli.run({
      arguments: ["evidence-import", path, "--json"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ imported: 2, unknowns_added: 2, total: 2 });
  },
);

cliTest(
  "reports a standalone Evidence record as the wrong input file kind",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-record-input-");
    const path = join(root, "record.json");
    const record = revisionBundle().records[0];
    if (record === undefined) throw new Error("Missing fixture Evidence");
    await writeFile(path, JSON.stringify(record));
    const result = await cli.run({
      arguments: ["evidence-import", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: { path },
      message: expect.stringContaining("this JSON is one Evidence record"),
    });
  },
);

cliTest(
  "rejects altered Evidence and incomplete unknown history before reporting counts",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-import-invalid-");
    const path = join(root, "bundle.json");
    const bundle = revisionBundle();
    for (const invalid of [
      {
        ...bundle,
        records: bundle.records.map((record) => ({
          ...record,
          normalized_result: "altered",
        })),
      },
      { ...bundle, unknowns: bundle.unknowns.slice(1) },
    ]) {
      await writeFile(path, JSON.stringify(invalid));
      const result = await cli.run({
        arguments: ["evidence-import", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "evidence_integrity_mismatch",
      });
      expect(result.json).not.toHaveProperty("imported");
    }
  },
);

cliTest(
  "preserves a selected own __proto__ member from complete bundle data",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-filter-proto-");
    const path = join(root, "bundle.json");
    const result = jsonValueSchema.parse(
      JSON.parse('{"__proto__":{"answer":7},"normal":{"answer":7}}'),
    );
    const record = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "ordinary-json", parameters: {}, result },
    );
    await writeFile(path, JSON.stringify(createEvidenceBundle([record])));

    const output = await cli.run({
      arguments: [
        "inspect-evidence-bundle",
        JSON.stringify({ path, detail: "complete" }),
        "--json",
        "--filter-output",
        "records[0,1].normalized_result.__proto__.answer",
      ],
    });

    expect(output.exitCode).toBe(0);
    const records = (
      output.json as {
        records: Array<{ normalized_result: unknown }>;
      }
    ).records;
    const normalizedResult = records[0]?.normalized_result;
    expect(typeof normalizedResult).toBe("object");
    expect(normalizedResult).not.toBeNull();
    expect(Object.hasOwn(normalizedResult as object, "__proto__")).toBe(true);
    expect((normalizedResult as Record<string, unknown>)["__proto__"]).toEqual({
      answer: 7,
    });
  },
);

cliTest(
  "preserves cell text when formatting retained Evidence as Markdown",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-markdown-cells-");
    const path = join(root, "bundle.json");
    const result = { text: "left|right\\tail\nnext" };
    const record = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "ordinary-json",
        parameters: {},
        result,
      },
    );
    await writeFile(path, JSON.stringify(createEvidenceBundle([record])));
    const base = [
      "inspect-evidence-bundle",
      JSON.stringify({ path, detail: "complete" }),
      "--filter-output",
      "records.0.normalized_result",
    ];
    const json = await cli.run({ arguments: [...base, "--json"] });
    expect(json.exitCode, json.stderr).toBe(0);
    expect(json.stdout).toContain(JSON.stringify(result.text));
    const markdown = await cli.run({ arguments: [...base, "--format", "md"] });
    expect(markdown.exitCode, markdown.stderr).toBe(0);
    expect(markdown.stdout).toContain("left\\|right\\\\tail<br>next");
  },
);
