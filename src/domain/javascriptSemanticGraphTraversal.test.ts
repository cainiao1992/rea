import { expect, it } from "vitest";

import type { ApplicationGraphEvidence } from "./javascriptApplicationEvidenceSchemas.js";
import {
  JAVASCRIPT_SEMANTIC_NODE_KINDS,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
} from "./javascriptSemanticGraphSchemas.js";
import {
  createJavaScriptSemanticFingerprint,
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphNode,
  createJavaScriptSemanticGraphRelation,
  createJavaScriptSemanticGraphUnknown,
  type JavaScriptSemanticGraph,
  type JavaScriptSemanticGraphNode,
} from "./javascriptSemanticGraph.js";
import { queryJavaScriptSemanticGraph } from "./javascriptSemanticQuery.js";

const SHA = "a".repeat(64);
const JAG_ID = `jag_${"b".repeat(64)}`;
const completeCoverage = {
  status: "complete",
  truncated: false,
  omitted_count: 0,
  limits: [],
} satisfies ApplicationGraphEvidence["coverage"];

const evidence = (
  state: "observed" | "inferred" = "observed",
): ApplicationGraphEvidence => ({
  authority:
    state === "observed"
      ? "ast-static-analysis"
      : "static-relationship-inference",
  state,
  confidence: state === "observed" ? "exact" : "high",
  artifact: { available: true, artifact_id: `art_${SHA}`, sha256: SHA },
  location: {
    available: true,
    value: {
      kind: "source-range",
      source: "bundle.js",
      start: { line: 1, column: 0 },
      end: { line: 1, column: 10 },
    },
  },
  extractor: {
    name: "test",
    version: "1",
    operation: "recover-semantic-relation",
    executable_sha256: null,
  },
  coverage: completeCoverage,
  limitations:
    state === "observed"
      ? []
      : ["Static reachability does not prove runtime execution."],
  evidence_ids: [],
});

const unknownEvidence = (): ApplicationGraphEvidence => ({
  authority: "unknown",
  state: "unknown",
  confidence: "unknown",
  artifact: {
    available: false,
    reason: "unknown",
    detail: "Unknown artifact.",
  },
  location: {
    available: false,
    reason: "unresolved",
    detail: "Dynamic call target.",
  },
  extractor: {
    name: "test",
    version: "1",
    operation: "retain-dynamic-call",
    executable_sha256: null,
  },
  coverage: {
    status: "unknown",
    truncated: false,
    omitted_count: null,
    limits: [],
  },
  limitations: ["Dynamic call target remains unknown."],
  evidence_ids: [],
});

const node = (
  kind: (typeof JAVASCRIPT_SEMANTIC_NODE_KINDS)[number],
  role: string,
  properties: Record<string, string | number | boolean | null> = {},
  functionNodeId: string | null = null,
): JavaScriptSemanticGraphNode =>
  createJavaScriptSemanticGraphNode({
    kind,
    identity: {
      artifact_sha256: SHA,
      module_path: "bundle.js",
      source_range: {
        start: { line: 1, column: role.length },
        end: { line: 1, column: role.length + 1 },
      },
      role_key: role,
    },
    function_node_id: functionNodeId,
    application_node_ids: [],
    label: role,
    properties,
    evidence: evidence(),
  });

const fixtureGraph = (withUnknown = false): JavaScriptSemanticGraph => {
  const module = node("module", "module");
  const literal = node("literal", "literal", { value: "TOKEN" });
  const binding = node("binding", "binding");
  const callable = node("function", "function");
  const request = node("request", "request", {
    endpoint: "https://example.invalid/v1",
  });
  const relations = [
    createJavaScriptSemanticGraphRelation({
      source_node_id: literal.node_id,
      target_node_id: binding.node_id,
      relation: "defines",
      resolution: "resolved",
      properties: {},
      evidence: evidence("inferred"),
    }),
    createJavaScriptSemanticGraphRelation({
      source_node_id: binding.node_id,
      target_node_id: callable.node_id,
      relation: "captures",
      resolution: "resolved",
      properties: {},
      evidence: evidence("inferred"),
    }),
    createJavaScriptSemanticGraphRelation({
      source_node_id: callable.node_id,
      target_node_id: request.node_id,
      relation: "constructs-request",
      resolution: "resolved",
      properties: {},
      evidence: evidence("inferred"),
    }),
  ];
  const dynamic = createJavaScriptSemanticGraphUnknown({
    node_id: callable.node_id,
    family: "call-flow",
    relation_kinds: ["calls"],
    reason: "dynamic-call",
    detail: "Computed callee is unresolved.",
    candidate_node_ids: [],
    evidence: unknownEvidence(),
  });
  const unknowns = withUnknown ? [dynamic] : [];
  const coverageFamilies = JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map(
    (family) => ({
      family,
      status:
        withUnknown && family === "call-flow"
          ? ("unknown" as const)
          : ("complete" as const),
      retained_relations: relations.filter(({ relation }) =>
        relation === "defines"
          ? family === "data-flow"
          : relation === "captures"
            ? family === "closure"
            : family === "request",
      ).length,
      omitted_relations: withUnknown && family === "call-flow" ? null : 0,
      unknown_ids:
        withUnknown && family === "call-flow" ? [dynamic.unknown_id] : [],
    }),
  );
  const fingerprint = createJavaScriptSemanticFingerprint({
    function_node_id: callable.node_id,
    algorithm: "rea.javascript-semantic-function/v1",
    status: "complete",
    components: {
      parameter_arity: 0,
      normalized_ast_sha256: "1".repeat(64),
      control_flow_sha256: "2".repeat(64),
      relation_shape_sha256: "3".repeat(64),
      literal_set_sha256: "4".repeat(64),
      effects: ["network"],
    },
    limitations: [],
    evidence: evidence("inferred"),
  });
  return createJavaScriptSemanticGraph({
    schema: "JavaScriptSemanticRelationGraph",
    root_artifact_sha256: SHA,
    application_graph_id: JAG_ID,
    root_node_ids: [module.node_id],
    nodes: [request, callable, binding, literal, module],
    relations,
    fingerprints: [fingerprint],
    unknowns,
    coverage: {
      status: withUnknown ? "partial" : "complete",
      truncated: false,
      omitted_nodes: withUnknown ? null : 0,
      omitted_relations: withUnknown ? null : 0,
      limits: [],
      families: coverageFamilies,
    },
    limitations: withUnknown ? ["Dynamic call target remains unknown."] : [],
  });
};

const graphWithCandidateEdge = (): JavaScriptSemanticGraph => {
  const graph = fixtureGraph();
  const literal = graph.nodes.find(({ kind }) => kind === "literal");
  const request = graph.nodes.find(({ kind }) => kind === "request");
  if (literal === undefined || request === undefined)
    throw new TypeError("Semantic fixture nodes are missing");
  const candidate = createJavaScriptSemanticGraphRelation({
    source_node_id: literal.node_id,
    target_node_id: request.node_id,
    relation: "supplies-request-field",
    resolution: "candidate",
    properties: { field: "authorization" },
    evidence: evidence("inferred"),
  });
  const { graph_id: _graphId, ...input } = graph;
  return createJavaScriptSemanticGraph({
    ...input,
    relations: [...graph.relations, candidate],
    coverage: {
      ...graph.coverage,
      families: graph.coverage.families.map((family) =>
        family.family === "request"
          ? {
              ...family,
              retained_relations: family.retained_relations + 1,
            }
          : family,
      ),
    },
  });
};

it("returns every relevant unknown inline", () => {
  const graph = fixtureGraph(true);
  const callable = graph.nodes.find(({ kind }) => kind === "function");
  if (callable === undefined) throw new Error("Expected callable node");
  const result = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "semantic-node", node_id: callable.node_id },
    direction: "forward-influence",
  });
  expect(result).toMatchObject({
    summary: { relevant_unknowns: 1 },
  });
  expect(result.unknowns).toHaveLength(1);
});

it("returns the complete deterministic forward influence result inline", () => {
  const graph = fixtureGraph();
  const input = {
    seed: { kind: "literal" as const, value: "TOKEN" },
    direction: "forward-influence" as const,
    expected: { role: "sink" as const, classes: ["request" as const] },
  };
  const first = queryJavaScriptSemanticGraph(graph, input);
  expect(first).toMatchObject({
    status: "found",
    summary: { traversed_nodes: 4, traversed_relations: 3 },
    relations: expect.any(Array),
  });
  expect(first.expected_match_node_ids).toHaveLength(1);
  expect(first.relations).toHaveLength(3);
});

it("traverses paths beyond the former fixed depth ceiling", () => {
  const original = fixtureGraph();
  const request = original.nodes.find(({ kind }) => kind === "request");
  if (request === undefined) throw new TypeError("Missing request node");
  const chain = Array.from({ length: 70 }, (_, index) =>
    node("binding", `long-chain-${index}`),
  );
  const chainRelations = chain.map((target, index) =>
    createJavaScriptSemanticGraphRelation({
      source_node_id: chain[index - 1]?.node_id ?? request.node_id,
      target_node_id: target.node_id,
      relation: "reads",
      resolution: "resolved",
      properties: {},
      evidence: evidence("inferred"),
    }),
  );
  const { graph_id: _graphId, ...input } = original;
  const graph = createJavaScriptSemanticGraph({
    ...input,
    nodes: [...original.nodes, ...chain],
    relations: [...original.relations, ...chainRelations],
    coverage: {
      ...original.coverage,
      families: original.coverage.families.map((family) =>
        family.family === "data-flow"
          ? {
              ...family,
              retained_relations:
                family.retained_relations + chainRelations.length,
            }
          : family,
      ),
    },
  });

  const result = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "literal", value: "TOKEN" },
    direction: "forward-influence",
  });

  expect(result.summary.traversed_nodes).toBe(74);
  expect(result.nodes).toHaveLength(74);
});

it("keeps relevant dynamic frontiers unknown", () => {
  const result = queryJavaScriptSemanticGraph(fixtureGraph(true), {
    seed: { kind: "literal", value: "TOKEN" },
    direction: "forward-influence",
  });
  expect(result.status).toBe("found");
  expect(result.coverage.status).toBe("partial");
  expect(result.unknowns).toMatchObject([
    { reason: "dynamic-call", relation_kinds: ["calls"] },
  ]);
});

it("excludes candidate edges unless the caller explicitly opts in", () => {
  const graph = graphWithCandidateEdge();
  const input = {
    seed: { kind: "literal" as const, value: "TOKEN" },
    direction: "forward-influence" as const,
    allowed_relations: ["supplies-request-field" as const],
  };
  const conservative = queryJavaScriptSemanticGraph(graph, input);
  const optedIn = queryJavaScriptSemanticGraph(graph, {
    ...input,
    include_ambiguous_dynamic_edges: true,
  });
  expect(conservative.summary.traversed_relations).toBe(0);
  expect(optedIn.summary.traversed_relations).toBe(1);
  expect(conservative.status).toBe("ambiguous");
  expect(conservative.coverage.status).toBe("partial");
  expect(optedIn.status).toBe("ambiguous");
  expect(optedIn.relations).toMatchObject([
    { relation: "supplies-request-field", resolution: "candidate" },
  ]);
});

it("retains every structural application node linked to one semantic node", () => {
  const original = node("module", "module");
  const linked = createJavaScriptSemanticGraphNode({
    kind: original.kind,
    identity: original.identity,
    function_node_id: original.function_node_id,
    application_node_ids: Array.from(
      { length: 65 },
      (_, index) => `jag_node_${index.toString(16).padStart(64, "0")}`,
    ),
    label: original.label,
    properties: original.properties,
    evidence: original.evidence,
  });
  expect(linked.application_node_ids).toHaveLength(65);
});

it("retains all explicit unresolved candidate node identifiers", () => {
  const unknown = createJavaScriptSemanticGraphUnknown({
    node_id: null,
    family: "call-flow",
    relation_kinds: ["calls"],
    reason: "ambiguous-target",
    detail: "All candidate targets are retained.",
    candidate_node_ids: Array.from(
      { length: 1_001 },
      (_, index) => `jsrg_node_${index.toString(16).padStart(64, "0")}`,
    ),
    evidence: unknownEvidence(),
  });
  expect(unknown.candidate_node_ids).toHaveLength(1_001);
});
