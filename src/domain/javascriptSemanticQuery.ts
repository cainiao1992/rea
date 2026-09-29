import { compareCodePoints } from "./javascriptApplicationGraph.js";
import type {
  JavaScriptSemanticGraph,
  JavaScriptSemanticGraphNode,
  JavaScriptSemanticGraphRelation,
} from "./javascriptSemanticGraph.js";
import type { JavaScriptSemanticGraphUnknown } from "./javascriptSemanticGraphSchemas.js";
import { isJavaScriptSemanticOwnershipRelation as ownershipRelation } from "./javascriptSemanticQueryRelations.js";
import {
  javaScriptSemanticQueryInputSchema,
  javaScriptSemanticQueryResultSchema,
  type JavaScriptSemanticQueryInput,
  type JavaScriptSemanticQueryResult,
} from "./javascriptSemanticQuerySchemas.js";
import {
  assessJavaScriptSemanticQuery,
  type JavaScriptSemanticQueryFrontier,
} from "./javascriptSemanticQueryAssessment.js";
import {
  canonicalJavaScriptSemanticQueryJson as canonicalJson,
  javaScriptSemanticQueryIdentifier as queryIdentifier,
  resolveJavaScriptSemanticQuerySeeds as resolveSeeds,
} from "./javascriptSemanticQueryIdentity.js";

const TRAVERSAL_LIMITS = {
  max_seed_matches: 1_000,
  max_nodes: 50_000,
  max_edges: 100_000,
  max_depth: 64,
  max_functions: 10_000,
  max_modules: 10_000,
  max_unknowns: 10_000,
} as const;

interface TraversalEntry {
  readonly relation: JavaScriptSemanticGraphRelation;
  readonly nextNodeId: string;
}

type QueryFrontier = JavaScriptSemanticQueryFrontier;

interface Traversal {
  readonly nodeIds: Set<string>;
  readonly relationIds: Set<string>;
  readonly functionIds: Set<string>;
  readonly modules: Set<string>;
  readonly frontier: QueryFrontier[];
}

interface SeedAdmission {
  readonly nodeIds: string[];
  readonly frontier: QueryFrontier[];
}

interface QueryResult {
  readonly retainedNodes: JavaScriptSemanticGraphNode[];
  readonly retainedRelations: JavaScriptSemanticGraphRelation[];
}

/** Run one deterministic bounded traversal over a verified semantic graph. */
export const queryJavaScriptSemanticGraph = (
  graph: JavaScriptSemanticGraph,
  rawInput: unknown,
): JavaScriptSemanticQueryResult => {
  const input = javaScriptSemanticQueryInputSchema.parse(rawInput);
  const queryId = queryIdentifier(graph, input);
  const seeds = resolveSeeds(graph, input);
  const admission = admitSeeds(graph, seeds, input);
  const retainedSeeds = admission.nodeIds;
  const adjacency = buildAdjacency(graph.relations, input);
  const traversal = traverse(graph, retainedSeeds, adjacency, input);
  const frontier = uniqueFrontier([
    ...traversal.frontier,
    ...admission.frontier,
  ]);
  const result = createQueryResult(graph, traversal);
  const allRelevantUnknowns = relevantUnknownFrontiers(
    graph,
    traversal.nodeIds,
    input,
  );
  const relevantUnknowns = allRelevantUnknowns.slice(
    0,
    TRAVERSAL_LIMITS.max_unknowns,
  );
  const candidateRelations = relevantCandidateRelationCount(
    graph,
    traversal.nodeIds,
    input,
  );
  const expectedMatches = expectedMatchesFor(
    result.retainedNodes,
    result.retainedRelations,
    input,
  );
  const assessment = assessJavaScriptSemanticQuery({
    graph,
    totalSeeds: seeds.length,
    retainedSeeds: retainedSeeds.length,
    expectedMatches: expectedMatches.length,
    hasExpectation: input.expected !== null,
    frontier,
    unknowns: relevantUnknowns,
    candidateRelations,
    unknownsTruncated: allRelevantUnknowns.length > relevantUnknowns.length,
  });
  return javaScriptSemanticQueryResultSchema.parse({
    query_id: queryId,
    source_graph_id: graph.graph_id,
    seed: input.seed,
    direction: input.direction,
    status: assessment.status,
    seed_node_ids: retainedSeeds,
    nodes: result.retainedNodes,
    relations: result.retainedRelations,
    unknowns: relevantUnknowns,
    expected_match_node_ids: expectedMatches.map(({ node_id }) => node_id),
    summary: {
      total_seed_matches: seeds.length,
      retained_seed_matches: retainedSeeds.length,
      traversed_nodes: traversal.nodeIds.size,
      traversed_relations: traversal.relationIds.size,
      traversed_functions: traversal.functionIds.size,
      traversed_modules: traversal.modules.size,
      relevant_unknowns: allRelevantUnknowns.length,
      retained_unknowns: relevantUnknowns.length,
    },
    coverage: assessment.coverage,
    limitations: assessment.limitations,
  });
};

const createQueryResult = (
  graph: JavaScriptSemanticGraph,
  traversal: Traversal,
): QueryResult => {
  const retainedNodes = graph.nodes.filter(({ node_id }) =>
    traversal.nodeIds.has(node_id),
  );
  const retainedRelations = graph.relations.filter(({ relation_id }) =>
    traversal.relationIds.has(relation_id),
  );
  return { retainedNodes, retainedRelations };
};

const admitSeeds = (
  graph: JavaScriptSemanticGraph,
  seeds: readonly string[],
  input: JavaScriptSemanticQueryInput,
): SeedAdmission => {
  const nodes = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const retained: string[] = [];
  const functions = new Set<string>();
  const modules = new Set<string>();
  const frontier: QueryFrontier[] = [];
  for (const nodeId of seeds) {
    const node = nodes.get(nodeId);
    if (node === undefined) continue;
    const reason = seedBlockedReason(node, {
      retained,
      functions,
      modules,
      input,
    });
    if (reason !== null) {
      frontier.push({ node_id: nodeId, depth: 0, reason });
      continue;
    }
    retained.push(nodeId);
    retainOwners(node, functions, modules);
  }
  return { nodeIds: retained, frontier: uniqueFrontier(frontier) };
};

interface SeedBounds {
  readonly retained: readonly string[];
  readonly functions: ReadonlySet<string>;
  readonly modules: ReadonlySet<string>;
  readonly input: JavaScriptSemanticQueryInput;
}

interface TraversalBounds {
  readonly nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>;
  readonly nodeIds: ReadonlySet<string>;
  readonly relationIds: ReadonlySet<string>;
  readonly functionIds: ReadonlySet<string>;
  readonly modules: ReadonlySet<string>;
  readonly input: JavaScriptSemanticQueryInput;
}

const seedBlockedReason = (
  node: JavaScriptSemanticGraphNode,
  bounds: SeedBounds,
): QueryFrontier["reason"] | null => {
  if (bounds.retained.length >= TRAVERSAL_LIMITS.max_seed_matches)
    return "max-seed-matches";
  if (bounds.retained.length >= TRAVERSAL_LIMITS.max_nodes) return "max-nodes";
  const functionId = functionOwner(node);
  if (
    functionId !== null &&
    !bounds.functions.has(functionId) &&
    bounds.functions.size >= TRAVERSAL_LIMITS.max_functions
  )
    return "max-functions";
  if (
    !bounds.modules.has(node.identity.module_path) &&
    bounds.modules.size >= TRAVERSAL_LIMITS.max_modules
  )
    return "max-modules";
  return null;
};

const buildAdjacency = (
  relations: readonly JavaScriptSemanticGraphRelation[],
  input: JavaScriptSemanticQueryInput,
): ReadonlyMap<string, TraversalEntry[]> => {
  const adjacency = new Map<string, TraversalEntry[]>();
  const allowed =
    input.allowed_relations === undefined
      ? null
      : new Set(input.allowed_relations);
  for (const relation of relations) {
    if (allowed !== null && !allowed.has(relation.relation)) continue;
    if (
      relation.resolution === "candidate" &&
      !input.include_ambiguous_dynamic_edges
    )
      continue;
    addDirectedEntries(adjacency, relation, input.direction);
  }
  for (const entries of adjacency.values())
    entries.sort((left, right) =>
      compareCodePoints(
        `${left.relation.relation_id}\0${left.nextNodeId}`,
        `${right.relation.relation_id}\0${right.nextNodeId}`,
      ),
    );
  return adjacency;
};

const addDirectedEntries = (
  adjacency: Map<string, TraversalEntry[]>,
  relation: JavaScriptSemanticGraphRelation,
  direction: JavaScriptSemanticQueryInput["direction"],
): void => {
  if (direction === "callers") {
    if (relation.relation === "calls")
      addEntry(
        adjacency,
        relation.target_node_id,
        relation.source_node_id,
        relation,
      );
    return;
  }
  if (direction === "ownership") {
    if (!ownershipRelation(relation.relation)) return;
    addEntry(
      adjacency,
      relation.source_node_id,
      relation.target_node_id,
      relation,
    );
    addEntry(
      adjacency,
      relation.target_node_id,
      relation.source_node_id,
      relation,
    );
    return;
  }
  if (direction === "backward-provenance")
    addEntry(
      adjacency,
      relation.target_node_id,
      relation.source_node_id,
      relation,
    );
  else
    addEntry(
      adjacency,
      relation.source_node_id,
      relation.target_node_id,
      relation,
    );
};

const addEntry = (
  adjacency: Map<string, TraversalEntry[]>,
  from: string,
  nextNodeId: string,
  relation: JavaScriptSemanticGraphRelation,
): void => {
  const entries = adjacency.get(from) ?? [];
  entries.push({ relation, nextNodeId });
  adjacency.set(from, entries);
};

const traverse = (
  graph: JavaScriptSemanticGraph,
  seeds: readonly string[],
  adjacency: ReadonlyMap<string, TraversalEntry[]>,
  input: JavaScriptSemanticQueryInput,
): Traversal => {
  const nodes = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const nodeIds = new Set(seeds);
  const relationIds = new Set<string>();
  const functionIds = new Set<string>();
  const modules = new Set<string>();
  const frontier: QueryFrontier[] = [];
  for (const nodeId of nodeIds)
    retainOwners(nodes.get(nodeId), functionIds, modules);
  const depths = new Map([...nodeIds].map((nodeId) => [nodeId, 0]));
  const queue = [...nodeIds];
  const bounds: TraversalBounds = {
    nodes,
    nodeIds,
    relationIds,
    functionIds,
    modules,
    input,
  };
  for (let offset = 0; offset < queue.length; offset += 1) {
    const current = queue[offset];
    if (current === undefined) continue;
    const depth = depths.get(current) ?? 0;
    for (const entry of adjacency.get(current) ?? []) {
      const reason = blockedReason(entry, depth, bounds);
      if (reason !== null) {
        frontier.push({ node_id: current, depth, reason });
        continue;
      }
      relationIds.add(entry.relation.relation_id);
      if (nodeIds.has(entry.nextNodeId)) continue;
      const node = nodes.get(entry.nextNodeId);
      if (node === undefined) continue;
      nodeIds.add(entry.nextNodeId);
      retainOwners(node, functionIds, modules);
      depths.set(entry.nextNodeId, depth + 1);
      queue.push(entry.nextNodeId);
    }
  }
  return {
    nodeIds,
    relationIds,
    functionIds,
    modules,
    frontier: uniqueFrontier(frontier),
  };
};

const blockedReason = (
  entry: TraversalEntry,
  depth: number,
  bounds: TraversalBounds,
): QueryFrontier["reason"] | null => {
  if (depth >= TRAVERSAL_LIMITS.max_depth) return "max-depth";
  if (
    !bounds.relationIds.has(entry.relation.relation_id) &&
    bounds.relationIds.size >= TRAVERSAL_LIMITS.max_edges
  )
    return "max-edges";
  if (bounds.nodeIds.has(entry.nextNodeId)) return null;
  if (bounds.nodeIds.size >= TRAVERSAL_LIMITS.max_nodes) return "max-nodes";
  const node = bounds.nodes.get(entry.nextNodeId);
  if (node === undefined) return null;
  const functionId = functionOwner(node);
  if (
    functionId !== null &&
    !bounds.functionIds.has(functionId) &&
    bounds.functionIds.size >= TRAVERSAL_LIMITS.max_functions
  )
    return "max-functions";
  if (
    !bounds.modules.has(node.identity.module_path) &&
    bounds.modules.size >= TRAVERSAL_LIMITS.max_modules
  )
    return "max-modules";
  return null;
};

const retainOwners = (
  node: JavaScriptSemanticGraphNode | undefined,
  functions: Set<string>,
  modules: Set<string>,
): void => {
  if (node === undefined) return;
  const functionId = functionOwner(node);
  if (functionId !== null) functions.add(functionId);
  modules.add(node.identity.module_path);
};

const functionOwner = (node: JavaScriptSemanticGraphNode): string | null =>
  node.kind === "function" ? node.node_id : node.function_node_id;

const uniqueFrontier = (frontier: readonly QueryFrontier[]): QueryFrontier[] =>
  [
    ...new Map(
      frontier.map((item) => [
        `${item.node_id}\0${String(item.depth)}\0${item.reason}`,
        item,
      ]),
    ).values(),
  ].sort((left, right) =>
    compareCodePoints(canonicalJson(left), canonicalJson(right)),
  );

const relevantUnknownFrontiers = (
  graph: JavaScriptSemanticGraph,
  nodeIds: ReadonlySet<string>,
  input: JavaScriptSemanticQueryInput,
): JavaScriptSemanticGraphUnknown[] => {
  const allowed =
    input.allowed_relations === undefined
      ? null
      : new Set(input.allowed_relations);
  return graph.unknowns.filter(
    (unknown) =>
      (unknown.node_id === null || nodeIds.has(unknown.node_id)) &&
      (allowed === null ||
        unknown.relation_kinds.some((relation) => allowed.has(relation))),
  );
};

const relevantCandidateRelationCount = (
  graph: JavaScriptSemanticGraph,
  nodeIds: ReadonlySet<string>,
  input: JavaScriptSemanticQueryInput,
): number => {
  const allowed =
    input.allowed_relations === undefined
      ? null
      : new Set(input.allowed_relations);
  return graph.relations.filter(
    (relation) =>
      relation.resolution === "candidate" &&
      (allowed === null || allowed.has(relation.relation)) &&
      (nodeIds.has(relation.source_node_id) ||
        nodeIds.has(relation.target_node_id)),
  ).length;
};

const expectedMatchesFor = (
  nodes: readonly JavaScriptSemanticGraphNode[],
  relations: readonly JavaScriptSemanticGraphRelation[],
  input: JavaScriptSemanticQueryInput,
): JavaScriptSemanticGraphNode[] => {
  if (input.expected === null) return [];
  const classes = new Set(input.expected.classes);
  const connected = new Set(
    relations.map((relation) =>
      input.expected?.role === "source"
        ? relation.target_node_id
        : relation.source_node_id,
    ),
  );
  return nodes.filter(
    ({ kind, node_id }) => classes.has(kind) && !connected.has(node_id),
  );
};
