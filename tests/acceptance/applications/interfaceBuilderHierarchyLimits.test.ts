import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect } from "vitest";

import { interfaceBuilderAnalysisSchema } from "../../../src/domain/apple/interfaceBuilderGraph.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const archive = (objects: readonly string[], hierarchy: readonly string[]) =>
  build({
    "com.apple.ibtool.document.objects": Object.fromEntries(
      objects.map((id) => [id, { class: "UIView" }]),
    ),
    "com.apple.ibtool.document.hierarchy": hierarchy.map((objectID) => ({
      objectID,
    })),
  });

const cases = [
  {
    name: "a later document's root is omitted",
    archives: [
      ["First.nib", archive(["first"], ["first"])],
      ["Second.nib", archive(["second"], ["second"])],
    ] as const,
    hierarchyComplete: [true, false],
    document: "Second.nib",
    omittedEdges: 1,
    unresolvedEdge: false,
  },
  {
    name: "a retained hierarchy edge has an omitted endpoint",
    archives: [
      ["Single.nib", archive(["kept", "omitted"], ["omitted"])],
    ] as const,
    hierarchyComplete: [false],
    document: "Single.nib",
    omittedEdges: 0,
    unresolvedEdge: true,
  },
];

cliTest.for(cases)(
  "reports partial hierarchy through the CLI when $name",
  async (
    { archives, hierarchyComplete, document, omittedEdges, unresolvedEdge },
    { cli },
  ) => {
    const root = await createTestTempDirectory("rea-ib-hierarchy-limits-");
    const app = join(root, "Fixture.app");
    const contents = join(app, "Contents");
    const resources = join(contents, "Resources");
    await mkdir(resources, { recursive: true });
    await mkdir(join(contents, "MacOS"));
    await writeFile(
      join(contents, "MacOS", "Fixture"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    await writeFile(
      join(contents, "Info.plist"),
      build({ CFBundleExecutable: "Fixture" }),
    );
    for (const [name, contents] of archives)
      await writeFile(join(resources, name), contents);

    const output = await cli.run({
      arguments: [
        "decode-interface-builder",
        app,
        "--max-objects",
        "2",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode, output.stdout + output.stderr).toBe(0);
    const evidence = parseEvidence(output.json);
    const report = interfaceBuilderAnalysisSchema.parse(
      evidence.normalized_result,
    );
    expect(
      report.documents.map(({ hierarchy_complete }) => hierarchy_complete),
    ).toEqual(hierarchyComplete);
    expect(report.graph.truncated).toBe(true);
    expect(report.graph.nodes).toHaveLength(2);
    expect(report.graph.edges).toHaveLength(1);
    expect(report.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: `hierarchy:Contents/Resources/${document}`,
        status: "partial",
        reason: "graph_limit_reached",
        examined: 1,
        omitted: omittedEdges,
      }),
    );
    if (unresolvedEdge)
      expect(report.graph.edges[0]).toMatchObject({
        relation: "contains",
        resolution: "unresolved",
        to: null,
        reason: "endpoint_omitted_by_object_limit",
      });

    const viewPath = join(root, "summary.json");
    await writeFile(
      viewPath,
      JSON.stringify({
        source: { kind: "inline", evidence: output.json },
        view: { kind: "summary" },
      }),
    );
    const summaryOutput = await cli.run({
      arguments: ["inspect-analysis-view", viewPath, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(
      summaryOutput.exitCode,
      summaryOutput.stdout + summaryOutput.stderr,
    ).toBe(0);
    expect(parseEvidence(summaryOutput.json).normalized_result).toMatchObject({
      kind: "summary",
      parent_evidence_id: evidence.evidence_id,
      summary: {
        documents: report.documents,
        truncated: true,
        coverage_statuses: { partial: expect.any(Number) },
      },
    });
    for (const [name, contents] of archives)
      expect(await readFile(join(resources, name), "utf8")).toBe(contents);
  },
);
