import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../../support/javascriptApplicationScope.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";

const analyzeMaps = async (maps: Readonly<Record<string, string>>) => {
  const root = await createTestTempDirectory("rea-app-source-map-mappings-");
  await Promise.all(
    Object.entries(maps).map(([path, text]) =>
      writeFile(join(root, path), text),
    ),
  );
  const result = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!result.ok) throw result.error;
  const analysis = javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
  return analysis.graph;
};

it("marks missing regular-map mappings unavailable and accepts empty or populated strings", async () => {
  const original = "export const answer: number = 42;";
  const maps = {
    "missing.js.map": JSON.stringify({
      version: 3,
      sources: ["original.ts"],
      sourcesContent: [original],
      names: [],
    }),
    "empty.js.map": JSON.stringify({
      version: 3,
      sources: ["original.ts"],
      sourcesContent: [original],
      names: [],
      mappings: "",
    }),
    "mapped.js.map": JSON.stringify({
      version: 3,
      sources: ["original.ts"],
      sourcesContent: [original],
      names: [],
      mappings: "AAAA",
    }),
  };
  const graph = await analyzeMaps(maps);
  const missingDigest = createHash("sha256")
    .update(maps["missing.js.map"])
    .digest("hex");
  expect(graph.coverage.status).toBe("partial");
  expect(graph.nodes).toContainEqual(
    expect.objectContaining({
      kind: "unknown",
      observations: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            operation: "parse-local-source-map",
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({ sha256: missingDigest }),
            limitations: ["Source map has no mappings string."],
          }),
        }),
      ]),
    }),
  );
  const originals = graph.nodes.filter(
    (node) => node.identity.strategy === "source-map-original",
  );
  expect(originals).toHaveLength(3);
  expect(originals).toContainEqual(
    expect.objectContaining({
      kind: "source-module",
      identity: expect.objectContaining({
        source_map_sha256: missingDigest,
        original_source: "original.ts",
        source_sha256: createHash("sha256").update(original).digest("hex"),
      }),
      observations: expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({ sha256: missingDigest }),
            limitations: ["Source map has no mappings string."],
          }),
        }),
      ]),
    }),
  );
  for (const mapPath of ["empty.js.map", "mapped.js.map"] as const) {
    const digest = createHash("sha256").update(maps[mapPath]).digest("hex");
    expect(originals).toContainEqual(
      expect.objectContaining({
        kind: "source-module",
        identity: expect.objectContaining({ source_map_sha256: digest }),
        observations: expect.arrayContaining([
          expect.objectContaining({
            evidence: expect.objectContaining({ limitations: [] }),
          }),
        ]),
      }),
    );
  }
});

it("retains declarations before and after an invalid indexed-map leaf", async () => {
  const mapText = JSON.stringify({
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          version: 3,
          sources: ["before.ts"],
          sourcesContent: ["export const before = 1;"],
          names: [],
          mappings: "AAAA",
        },
      },
      {
        offset: { line: 1, column: 0 },
        map: {
          version: 3,
          sources: ["middle.ts"],
          sourcesContent: ["export const middle = 2;"],
          names: [],
        },
      },
      {
        offset: { line: 2, column: 0 },
        map: {
          version: 3,
          sources: ["after.ts"],
          sourcesContent: ["export const after = 3;"],
          names: [],
          mappings: "AAAA",
        },
      },
    ],
  });
  const graph = await analyzeMaps({ "indexed.js.map": mapText });
  const digest = createHash("sha256").update(mapText).digest("hex");
  expect(graph.coverage.status).toBe("partial");
  expect(graph.nodes).toContainEqual(
    expect.objectContaining({
      kind: "unknown",
      observations: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            path: "indexed.js.map",
            operation: "parse-local-source-map",
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({ sha256: digest }),
            limitations: ["Source map has no mappings string."],
          }),
        }),
      ]),
    }),
  );
  const originals = graph.nodes.filter(
    (node) =>
      node.identity.strategy === "source-map-original" &&
      node.identity.source_map_sha256 === digest,
  );
  expect(originals).toHaveLength(3);
  for (const [index, sourceName, content] of [
    [0, "before.ts", "export const before = 1;"],
    [1, "middle.ts", "export const middle = 2;"],
    [2, "after.ts", "export const after = 3;"],
  ] as const) {
    expect(originals).toContainEqual(
      expect.objectContaining({
        kind: "source-module",
        identity: expect.objectContaining({
          source_map_sha256: digest,
          original_source: sourceName,
          source_sha256: createHash("sha256").update(content).digest("hex"),
        }),
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              declaration_index: index,
              source_name_available: true,
              content_available: true,
            }),
            evidence: expect.objectContaining({
              artifact: expect.objectContaining({ sha256: digest }),
              limitations: ["Source map has no mappings string."],
            }),
          }),
        ]),
      }),
    );
  }
});
