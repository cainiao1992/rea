import { describe, expect, it } from "vitest";

import {
  computeJavaScriptApplicationGraphSha256,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  javascriptApplicationGraphSchema,
  parseJavaScriptApplicationGraph,
  serializeJavaScriptApplicationGraph,
  type ApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import {
  JAVASCRIPT_APPLICATION_NODE_KINDS,
  JAVASCRIPT_APPLICATION_RELATIONS,
} from "./javascriptApplicationGraphSchemas.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
  buildSyntheticJavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.fixture.js";

const nodeByLabel = (
  graph: JavaScriptApplicationGraph,
  label: string,
): ApplicationNode => {
  const node = graph.nodes.find(({ observations }) =>
    observations.some((observation) => observation.label === label),
  );
  if (node === undefined) throw new TypeError(`Missing fixture node: ${label}`);
  return node;
};

const createLargeNativeExportGraph = (): JavaScriptApplicationGraph => {
  const properties = Object.fromEntries(
    Array.from({ length: 1_001 }, (_, index) => [
      `${"export-property-"}${"k".repeat(120)}-${index}`,
      "v".repeat(4_097),
    ]),
  );
  const nodes = Array.from({ length: 1_001 }, (_, index) => {
    const path = `native/exports/${index}.symbol`;
    return createJavaScriptApplicationNode({
      kind: "native-export",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
        path,
      },
      observations: [
        {
          label: index === 0 ? "large export graph label ".repeat(300) : path,
          properties: index === 0 ? properties : {},
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.nativeAddon,
            path,
            "native-analysis-provider",
          ),
        },
      ],
    });
  });
  const first = nodes[0];
  if (first === undefined) throw new TypeError("Missing native export");

  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [first.node_id],
    nodes,
    edges: [],
    coverage: {
      status: "complete",
      truncated: false,
      omitted_count: 0,
      limits: [],
    },
    limitations: [],
  });
};

it("accepts deeply nested canonical application properties", () => {
  let nested: unknown = "leaf";
  for (let index = 0; index < 12; index += 1)
    nested = { [`level-${String(index)}`]: nested };
  const node = createJavaScriptApplicationNode({
    kind: "native-export",
    identity: {
      strategy: "canonical-path",
      stability: "artifact-version",
      artifact_sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
      path: "native/deep-export",
    },
    observations: [
      {
        label: "deep export",
        properties: { nested },
        evidence: artifactEvidence(
          APPLICATION_GRAPH_DIGESTS.nativeAddon,
          "native/deep-export",
          "native-analysis-provider",
        ),
      },
    ],
  });

  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [node.node_id],
    nodes: [node],
    edges: [],
    coverage: {
      status: "complete",
      truncated: false,
      omitted_count: 0,
      limits: [],
    },
    limitations: [],
  });

  expect(graph.nodes[0]?.observations[0]?.properties).toEqual({ nested });
  expect(
    parseJavaScriptApplicationGraph(
      JSON.parse(serializeJavaScriptApplicationGraph(graph)),
    ),
  ).toEqual(graph);
});

describe("JavaScript Application Graph", () => {
  it("defines the complete provider-neutral node and relation vocabulary", () => {
    expect(JAVASCRIPT_APPLICATION_NODE_KINDS).toEqual([
      "package",
      "installer",
      "artifact",
      "asar-entry",
      "electron-main",
      "electron-preload",
      "electron-renderer",
      "electron-utility",
      "javascript-asset",
      "javascript-chunk",
      "javascript-module",
      "source-map",
      "source-module",
      "browser-window",
      "frame",
      "target",
      "context-bridge-api",
      "ipc-channel",
      "ipc-handler",
      "worker",
      "service-worker",
      "endpoint",
      "storage",
      "native-addon",
      "native-export",
      "managed-assembly",
      "managed-module",
      "managed-type",
      "managed-method",
      "managed-field",
      "managed-pinvoke-import",
      "managed-native-implementation",
      "runtime-script-instance",
      "unknown",
    ]);
    expect(JAVASCRIPT_APPLICATION_RELATIONS).toEqual([
      "contains",
      "loads",
      "imports",
      "maps_to",
      "exposes",
      "sends",
      "invokes",
      "handles",
      "calls",
      "persists_to",
      "observed_as",
      "changed_from",
    ]);
  });

  it("round-trips one canonical, byte-stable graph", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const serialized = serializeJavaScriptApplicationGraph(graph);
    const decoded: unknown = JSON.parse(serialized);

    expect(parseJavaScriptApplicationGraph(decoded)).toEqual(graph);
    expect(javascriptApplicationGraphSchema.parse(decoded)).toEqual(graph);
    expect(serializeJavaScriptApplicationGraph(decoded)).toBe(serialized);
    expect(computeJavaScriptApplicationGraphSha256(decoded)).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    const { graph_id: _graphId, ...semantic } = graph;
    expect(
      createJavaScriptApplicationGraph({
        ...semantic,
        nodes: semantic.nodes.toReversed(),
        edges: semantic.edges.toReversed(),
      }),
    ).toEqual(graph);
  });

  it("keeps large native-export graphs and their complete properties", () => {
    const graph = createLargeNativeExportGraph();
    const largeExport = graph.nodes.find(({ observations }) =>
      observations.some(({ label }) =>
        label?.startsWith("large export graph label "),
      ),
    );

    expect(graph.nodes).toHaveLength(1_001);
    expect(
      Object.keys(largeExport?.observations[0]?.properties ?? {}),
    ).toHaveLength(1_001);
  });

  it("represents the synthetic ASAR to preload to IPC to native chain", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const labels = [
      "resources/app.asar",
      "desktop preload",
      "desktopApi",
      "project:open",
      "project open handler",
      "synthetic.node",
      "openProject",
    ];
    const chain = labels.map((label) => nodeByLabel(graph, label));
    const expectedRelations = [
      "contains",
      "exposes",
      "invokes",
      "handles",
      "loads",
      "contains",
    ];

    for (let index = 0; index < expectedRelations.length; index += 1)
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          source_node_id: chain[index]?.node_id,
          target_node_id: chain[index + 1]?.node_id,
          relation: expectedRelations[index],
        }),
      );
    expect(chain.at(-2)?.kind).toBe("native-addon");
    expect(chain.at(-1)?.kind).toBe("native-export");
  });
});
