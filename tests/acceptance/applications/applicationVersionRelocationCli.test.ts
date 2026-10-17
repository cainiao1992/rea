import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { applicationVersionComparisonResultSchema } from "../../../src/domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "retains unchanged bundled modules after an earlier edit shifts their source offsets",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-version-relocation-");
    const bundle =
      "globalThis.webpackChunkApp.push([[1], {11(module,exports){exports.value=11;},22(module,exports){exports.value=22;}}]);";
    const versions = [];
    for (const side of [1, 2]) {
      const application = join(root, String(side));
      await mkdir(application);
      await writeFile(
        join(application, "main.js"),
        `${side === 1 ? "" : "/* earlier bundle edit */\n"}${bundle}`,
      );
      const response = await cli.run({
        arguments: ["analyze-javascript-application", application, "--json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(response.exitCode, response.stderr).toBe(0);
      versions.push(parseEvidence(response.json));
    }
    const [left, right] = versions;
    if (left === undefined || right === undefined)
      throw new Error("Missing analyzed versions");
    const analyses = versions.map((value) =>
      javascriptApplicationAnalysisResultSchema.parse(value.normalized_result),
    );
    const modules = analyses.map((value) =>
      value.graph.nodes.filter(
        (node) =>
          node.kind === "javascript-module" &&
          node.observations.some(
            ({ properties }) => properties.module_key !== undefined,
          ),
      ),
    );
    expect(modules[0]).toHaveLength(2);
    expect(modules[1]).toHaveLength(2);
    const input = join(root, "comparison.json");
    await writeFile(input, JSON.stringify({ left, right }));
    const response = await cli.run({
      arguments: ["compare-application-versions", input, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const result = applicationVersionComparisonResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    expect(result.coverage.status).toBe("complete-within-inputs");
    const moduleItems = result.items.filter((item) =>
      modules[0]?.some((node) => node.node_id === item.left_node_id),
    );
    expect(moduleItems).toHaveLength(2);
    for (const item of moduleItems) {
      expect(item).toMatchObject({
        status: "unchanged",
        dimensions: ["location"],
        match: { basis: "exact-module-source-digest" },
      });
      const a = modules[0]?.find((node) => node.node_id === item.left_node_id),
        b = modules[1]?.find((node) => node.node_id === item.right_node_id);
      expect(typeof a?.observations[0]?.properties.source_sha256).toBe(
        "string",
      );
      expect(a?.observations[0]?.properties.source_sha256).toBe(
        b?.observations[0]?.properties.source_sha256,
      );
      expect(a?.observations[0]?.evidence.location).not.toEqual(
        b?.observations[0]?.evidence.location,
      );
      expect(
        result.graph.nodes.find((node) => node.node_id === item.left_node_id),
      ).toEqual(a);
      expect(
        result.graph.nodes.find((node) => node.node_id === item.right_node_id),
      ).toEqual(b);
    }
    expect(result.summary.unchanged).toBeGreaterThanOrEqual(2);
    expect(
      result.items.find((item) => item.node_kind === "javascript-asset"),
    ).toMatchObject({
      status: "changed",
      dimensions: expect.arrayContaining(["content"]),
    });
  },
);
