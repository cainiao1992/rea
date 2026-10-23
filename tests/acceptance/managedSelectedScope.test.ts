import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../src/domain/managed/managedArtifact.js";
import { managedMemberComparisonResultSchema } from "../../src/domain/managed/managedMemberComparison.js";
import { namespaceBearingNestedTypes } from "../fixtures/managedSelectedScope.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "compares actual selected type scope from public CLI Evidence through stdio MCP after source removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-selected-scope-");
    const path = join(root, "selected.dll");
    const bytes = namespaceBearingNestedTypes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path, bytes);
    const sources: ReturnType<typeof parseEvidence>[] = [];
    for (const selection of [
      ["Inner"],
      ["Inner", "Fixture.Inner"],
      ["Fixture.Inner"],
    ]) {
      const output = await cli.sharedCliRun!({
        arguments: [
          "inspect-managed-members",
          path,
          ...selection.flatMap((name) => ["--type", name]),
          "--json",
        ],
      });
      expect(output.exitCode, output.stderr).toBe(0);
      const evidence = parseEvidence(output.json);
      const report = managedMemberInspectionSchema.parse(
        evidence.normalized_result,
      );
      expect(report.artifact).toMatchObject({ path, sha256 });
      expect(report.selection).toEqual({
        type_names: selection,
        unmatched_type_names: [],
      });
      expect(report.coverage.state).toBe("complete");
      sources.push(evidence);
    }
    expect(await readFile(path)).toEqual(bytes);
    await rm(path);
    const call = await cli.sharedMcpCall!();
    for (const [index, right] of sources.slice(1).entries()) {
      const response = await call("compare_managed_members", {
        left: sources[0]!,
        right,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const evidence = parseEvidence(response.structuredContent);
      const report = managedMemberComparisonResultSchema.parse(
        evidence.normalized_result,
      );
      expect(report.evidence_links).toEqual([
        sources[0]!.evidence_id,
        right.evidence_id,
      ]);
      expect(report.coverage.status).toBe(
        index === 0 ? "complete-within-inputs" : "partial",
      );
      expect(report.summary).toMatchObject({ added: 0, removed: 0 });
      if (index === 0)
        expect(report.limitations).toContain(
          "Both observations cover only the selected declaring types (Fixture.Inner, Inner); member totals and statuses describe those types, not the whole assembly.",
        );
      else {
        expect(report.summary.unknown).toBeGreaterThan(0);
        expect(report.limitations).toContain(
          "The observations select different declaring types; a member outside the other side's selection is unknown, not added or removed.",
        );
      }
    }
  },
);
