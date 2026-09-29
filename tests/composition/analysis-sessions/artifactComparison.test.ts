import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { inventoryArtifact } from "../../../src/application/ArtifactInventory.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import {
  artifactComparisonResultSchema,
  compareArtifacts,
} from "../../../src/domain/artifactComparison.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";

const PROVIDER = {
  id: "rea-artifact-graph",
  name: "REA artifact graph",
  version: "1",
} as const;

const observe = async (path: string) => {
  const inventory = await inventoryArtifact(path);
  return createEvidence(
    {
      path,
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    PROVIDER,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: jsonValueSchema.parse(inventory),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

describe("artifact comparison", () => {
  it("classifies deterministic path changes and cites both inventories", async () => {
    const parent = await createTestTempDirectory("rea-artifact-compare-");
    const leftPath = join(parent, "left.app");
    const rightPath = join(parent, "right.app");
    await Promise.all([mkdir(leftPath), mkdir(rightPath)]);
    await Promise.all([
      writeFile(join(leftPath, "main.js"), "old();"),
      writeFile(join(leftPath, "same.txt"), "same"),
      writeFile(join(rightPath, "main.js"), "newer();"),
      writeFile(join(rightPath, "same.txt"), "same"),
      writeFile(join(rightPath, "added.txt"), "added"),
    ]);
    const left = await observe(leftPath);
    const right = await observe(rightPath);
    const first = compareArtifacts(left, right);
    const second = compareArtifacts(left, right);
    expect(first).toEqual(second);
    expect(artifactComparisonResultSchema.parse(first)).toMatchObject({
      status: "changed",
      summary: { added: 1, changed: 2, unknown: 0 },
      changes: expect.arrayContaining([
        expect.objectContaining({ logical_path: "added.txt" }),
      ]),
    });
    expect(first.changes[0]?.evidence_links).toEqual([
      left.evidence_id,
      right.evidence_id,
    ]);
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_path: "added.txt",
          classification: "added",
        }),
        expect.objectContaining({
          logical_path: "main.js",
          classification: "changed",
          dimensions: expect.arrayContaining(["content", "size"]),
        }),
      ]),
    );
  });

  it("reports incomplete inventory as truncated, never unchanged", async () => {
    const root = await createTestTempDirectory("rea-artifact-truncated-");
    await writeFile(join(root, "one.txt"), "one");
    const complete = await observe(root);
    const completeInventory = artifactInventoryResultSchema.parse(
      complete.normalized_result,
    );
    const incomplete = createEvidence(
      {
        path: root,
        sha256: complete.subject?.digest.sha256 ?? "0".repeat(64),
        format: "directory",
      },
      PROVIDER,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: jsonValueSchema.parse({
          ...completeInventory,
          nodes: [],
        }),
        confidence: "observed",
        authority: "shipped-artifact",
        limitations: ["Inventory node observations are unavailable."],
      },
    );
    const comparison = compareArtifacts(incomplete, incomplete);
    expect(comparison).toMatchObject({
      status: "truncated",
      summary: { unchanged: 0, unknown: 2 },
    });
    expect(comparison.limitations).toContain(
      "Left artifact inventory is incomplete.",
    );
  });

  it("compares every graph member for inventories larger than 500 entries", async () => {
    const root = await createTestTempDirectory("rea-artifact-pages-");
    await Promise.all(
      Array.from({ length: 501 }, async (_, index) =>
        writeFile(
          join(root, `file-${String(index).padStart(3, "0")}.txt`),
          String(index),
        ),
      ),
    );
    const complete = await observe(root);
    expect(complete.normalized_result).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ kind: expect.any(String) }),
      ]),
      occurrences: expect.any(Array),
      edges: expect.any(Array),
    });
    expect(compareArtifacts(complete, complete)).toMatchObject({
      status: "unchanged",
      summary: { unchanged: 502, unknown: 0 },
      changes: [],
    });
  }, 15_000);

  it("rejects non-inventory and tampered Evidence", async () => {
    const root = await createTestTempDirectory("rea-artifact-invalid-");
    const evidence = await observe(root);
    expect(() =>
      compareArtifacts({ ...evidence, operation: "binary_overview" }, evidence),
    ).toThrow(/identifier/u);
    const wrongOperation = createEvidence(undefined, PROVIDER, {
      operation: "binary_overview",
      parameters: {},
      result: evidence.normalized_result,
    });
    expect(() => compareArtifacts(wrongOperation, evidence)).toThrow(
      /inspect_artifact/u,
    );
    const mismatchedSubject = createEvidence(
      { path: root, sha256: "f".repeat(64), format: "directory" },
      PROVIDER,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: evidence.normalized_result,
      },
    );
    expect(() => compareArtifacts(mismatchedSubject, evidence)).toThrow(
      /root digest/u,
    );
  });
});
