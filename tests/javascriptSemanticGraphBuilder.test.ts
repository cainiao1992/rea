import { describe, expect, it } from "vitest";

import { buildJavaScriptSemanticGraph } from "../src/application/JavaScriptSemanticGraphBuilder.js";
import type { JavaScriptArtifactAnalysis } from "../src/application/JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../src/application/JavaScriptArtifactFiles.js";
import { queryJavaScriptSemanticGraph } from "../src/domain/javascriptSemanticQuery.js";
import { analyzeJavaScriptSemantics } from "../src/domain/javascriptSemanticAnalysis.js";
import {
  DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS,
  type JavaScriptSemanticLimits,
} from "../src/domain/javascriptSemanticIr.js";

const SHA256 = "a".repeat(64);
const GRAPH_ID = `jag_${"b".repeat(64)}`;

describe("JavaScript semantic companion graph", () => {
  it("projects closure and direct interprocedural flow without execution", () => {
    const graph = graphFor(`
      const outer = 2;
      function add(value) { return value + outer; }
      const input = 40;
      const answer = add(input);
    `);

    const relations = new Set(graph.relations.map(({ relation }) => relation));
    for (const expected of [
      "argument-to-parameter",
      "calls",
      "captures",
      "defines",
      "reads",
      "returns-to-call",
    ] as const)
      expect(relations.has(expected)).toBe(true);
    expect(graph.coverage.families).toHaveLength(12);
    expect(graph.limitations).toContain(
      "The semantic graph contains static syntax observations and conservative relationship candidates; it does not claim runtime execution.",
    );
    const parameter = graph.nodes.find(
      ({ kind, label }) => kind === "parameter" && label === "value",
    );
    if (parameter === undefined) throw new Error("Expected parameter node");
    const provenance = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: parameter.node_id },
      direction: "backward-provenance",
      include_ambiguous_dynamic_edges: true,
    });
    expect(provenance.relations.map(({ relation }) => relation)).toEqual(
      expect.arrayContaining([
        "aliases",
        "argument-to-parameter",
        "defines",
        "reads",
      ]),
    );
  });

  it("keeps dynamic calls explicit and returns bounded deterministic pages", () => {
    const graph = graphFor(`
      const handlers = { ready() { return 1; } };
      const key = process.argv[2];
      handlers[key]();
    `);
    expect(graph.unknowns.some(({ reason }) => reason === "dynamic-call")).toBe(
      true,
    );
    const seedNodeId = graph.relations.find(
      ({ relation }) => relation === "defines",
    )?.source_node_id;
    expect(seedNodeId).toBeDefined();
    if (seedNodeId === undefined) throw new Error("Expected a definition seed");

    const first = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: seedNodeId },
      direction: "forward-influence",
      include_ambiguous_dynamic_edges: true,
      limits: {
        max_seed_matches: 25,
        max_nodes: 2_000,
        max_edges: 4_000,
        max_depth: 12,
        max_functions: 500,
        max_modules: 500,
        page_size: 1,
      },
    });
    const repeated = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: seedNodeId },
      direction: "forward-influence",
      include_ambiguous_dynamic_edges: true,
      limits: first.applied_limits,
    });
    expect(repeated).toEqual(first);
  });

  it("keeps ambiguous interprocedural flow out of the default traversal", () => {
    const graph = graphFor(`
      function left(value) { return value; }
      function right(value) { return value; }
      const input = 1;
      const selected = Math.random() ? left : right;
      selected(input);
    `);
    const input = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "input",
    );
    if (input === undefined) throw new Error("Expected input binding");
    const query = {
      seed: { kind: "semantic-node" as const, node_id: input.node_id },
      direction: "forward-influence" as const,
      allowed_relations: [
        "reads" as const,
        "aliases" as const,
        "argument-to-parameter" as const,
      ],
    };
    const strict = queryJavaScriptSemanticGraph(graph, query);
    expect(
      strict.relations.some(
        ({ relation }) => relation === "argument-to-parameter",
      ),
    ).toBe(false);
    expect(strict.status).toBe("ambiguous");
    const admitted = queryJavaScriptSemanticGraph(graph, {
      ...query,
      include_ambiguous_dynamic_edges: true,
    });
    expect(
      admitted.relations.filter(
        ({ relation }) => relation === "argument-to-parameter",
      ),
    ).toHaveLength(2);
    expect(admitted.status).toBe("ambiguous");
  });

  it("connects caller results, direct returns, parameters, and captures", () => {
    const graph = graphFor(`
      const outer = 2;
      function identity(value) { return value; }
      function readOuter() { return outer; }
      const input = 40;
      const output = identity(input);
    `);
    const binding = (label: string) =>
      graph.nodes.find(
        ({ kind, label: nodeLabel }) =>
          ["binding", "parameter"].includes(kind) && nodeLabel === label,
      );
    const output = binding("output");
    const input = binding("input");
    const outer = binding("outer");
    const readOuter = graph.nodes.find(
      ({ kind, label }) => kind === "function" && label === "readOuter",
    );
    if (
      output === undefined ||
      input === undefined ||
      outer === undefined ||
      readOuter === undefined
    )
      throw new Error("Expected semantic flow nodes");
    const provenance = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: output.node_id },
      direction: "backward-provenance",
    });
    expect(provenance.nodes.map(({ node_id }) => node_id)).toContain(
      input.node_id,
    );
    const influence = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: outer.node_id },
      direction: "forward-influence",
      allowed_relations: ["captures"],
    });
    expect(influence.nodes.map(({ node_id }) => node_id)).toContain(
      readOuter.node_id,
    );
    const capture = graph.relations.find(
      ({ relation }) => relation === "captures",
    );
    expect(capture?.evidence.location).toMatchObject({
      available: true,
      value: { kind: "source-range", source: "app.js" },
    });
    expect(capture?.evidence.location).not.toEqual(readOuter.evidence.location);
  });

  it("preserves semantic analyzer truncation in graph coverage", () => {
    const graph = graphFor(
      "const first = 1; const second = first; const third = second;",
      { maxReferences: 1 },
    );
    expect(graph.coverage).toMatchObject({
      status: "partial",
      truncated: true,
      omitted_nodes: null,
      omitted_relations: null,
      limits: expect.arrayContaining([
        { name: "semantic.maxReferences", value: 1, unit: "items" },
      ]),
    });
    expect(
      graph.coverage.families.find(
        ({ family }) => family === "promise-ownership",
      ),
    ).toMatchObject({ status: "unknown", retained_relations: 0 });
  });

  it("projects bounded Promise ownership and unresolved sources", () => {
    const graph = graphFor(`
      async function run(value) {
        const owned = new Promise((resolve) => resolve(value));
        await Promise.resolve(owned);
        Promise.resolve(value).then(work).finally(cleanup);
        value.then(work);
        return Promise.all([owned, Promise.resolve(value)]);
      }
    `);

    const relations = new Set(graph.relations.map(({ relation }) => relation));
    for (const expected of [
      "aggregates",
      "awaits",
      "chains",
      "creates-promise",
      "detaches-task",
      "owns",
      "returns-task",
    ] as const)
      expect(relations.has(expected)).toBe(true);
    expect(
      graph.nodes.filter(({ kind }) => kind === "promise"),
    ).not.toHaveLength(0);
    expect(
      graph.nodes.find(
        ({ kind, properties }) =>
          kind === "promise" &&
          properties.method === "all" &&
          properties.ownership === "returned",
      ),
    ).toBeDefined();
    expect(
      graph.unknowns.some(
        ({ family, reason }) =>
          family === "promise-ownership" && reason === "ambiguous-target",
      ),
    ).toBe(true);
    expect(
      graph.coverage.families.find(
        ({ family }) => family === "promise-ownership",
      ),
    ).toMatchObject({ status: "partial" });
  });

  it("keeps duplicate function fingerprints ambiguous", () => {
    const graph = graphFor(`
      function first(value) { return value + 1; }
      function second(input) { return input + 1; }
    `);

    expect(graph.fingerprints).toHaveLength(2);
    const digest = graph.fingerprints[0]?.fingerprint_sha256;
    expect(digest).toBeDefined();
    expect(graph.fingerprints[1]?.fingerprint_sha256).toBe(digest);
    if (digest === undefined) throw new Error("Expected fingerprint");
    const query = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "function", fingerprint_sha256: digest },
      direction: "forward-influence",
    });
    expect(query.status).toBe("ambiguous");
    expect(query.summary.total_seed_matches).toBe(2);
  });

  it("projects literal events and exact timer cancellation", () => {
    const graph = graphFor(`
      function run(bus, dynamicName) {
        const handle = setInterval(tick, 10);
        bus.on("ready", handler);
        bus.once(dynamicName, handler);
        bus.emit("ready");
        bus.removeListener("ready", handler);
        clearInterval(handle);
      }
    `);

    const relations = new Set(graph.relations.map(({ relation }) => relation));
    for (const expected of [
      "cancels-timer",
      "dispatches-candidate",
      "registers-listener",
      "removes-listener",
      "schedules-timer",
    ] as const)
      expect(relations.has(expected)).toBe(true);
    expect(
      graph.nodes.find(
        ({ kind, properties }) =>
          kind === "event" && properties.event_name === "ready",
      ),
    ).toBeDefined();
    expect(
      graph.unknowns.some(
        ({ family, detail }) =>
          family === "event" && detail.includes("Dynamic once event name"),
      ),
    ).toBe(true);
    expect(
      graph.coverage.families.find(({ family }) => family === "event"),
    ).toMatchObject({ status: "partial" });
    expect(
      graph.coverage.families.find(({ family }) => family === "timer"),
    ).toMatchObject({ status: "partial" });
  });

  it("projects child-process creation, I/O, listeners, and signals", () => {
    const graph = graphFor(`
      import { spawn } from "node:child_process";
      function run(command) {
        const child = spawn(
          command,
          ["--mode", "fast"],
          { env: process.env, stdio: "pipe" },
        );
        child.on("exit", onExit);
        child.once("error", onError);
        child.kill("SIGTERM");
      }
    `);

    const relations = new Set(graph.relations.map(({ relation }) => relation));
    for (const expected of [
      "connects-stdio",
      "forwards-signal",
      "listens-error",
      "listens-exit",
      "spawns",
      "supplies-argv",
      "supplies-env",
    ] as const)
      expect(relations.has(expected)).toBe(true);
    expect(
      graph.nodes.find(
        ({ kind, properties }) =>
          kind === "child-process" &&
          properties.method === "spawn" &&
          properties.command === null,
      ),
    ).toBeDefined();
    expect(
      graph.unknowns.some(
        ({ family, detail }) =>
          family === "child-process" &&
          detail.includes("command remains unresolved"),
      ),
    ).toBe(true);
    expect(
      graph.coverage.families.find(({ family }) => family === "child-process"),
    ).toMatchObject({ status: "partial" });
  });

  it("projects config precedence, request fields, and boundaries", () => {
    const graph = graphFor(`
      import { readFileSync } from "node:fs";
      async function run(schema) {
        const endpoint = process.env.API_URL ?? "https://fallback.test";
        const raw = readFileSync("./config.json", "utf8");
        const parsed = JSON.parse(raw);
        const port = Number(process.argv[2]);
        const validated = schema.parse(parsed);
        const response = await fetch(endpoint, {
          method: "POST",
          body: validated,
        });
        return response.json();
      }
    `);

    const relations = new Set(graph.relations.map(({ relation }) => relation));
    for (const expected of [
      "coerces",
      "constructs-request",
      "consumed-by",
      "defaults",
      "overrides",
      "parses",
      "reads-argv",
      "reads-config",
      "reads-environment",
      "supplies-request-field",
    ] as const)
      expect(relations.has(expected)).toBe(true);
    expect(
      graph.nodes.find(
        ({ kind, properties }) =>
          kind === "request" && properties.method === "fetch",
      ),
    ).toBeDefined();
    expect(
      graph.nodes.filter(({ kind }) => kind === "boundary"),
    ).not.toHaveLength(0);
    expect(
      graph.coverage.families.find(({ family }) => family === "configuration"),
    ).toMatchObject({ status: "partial" });
    expect(
      graph.coverage.families.find(({ family }) => family === "request"),
    ).toMatchObject({ status: "partial" });
    expect(
      graph.coverage.families.find(({ family }) => family === "boundary"),
    ).toMatchObject({ status: "partial" });
  });

  it("projects built-in resource acquisition and release", () => {
    const graph = graphFor(`
      import { open } from "node:fs/promises";
      import { connect } from "node:net";
      async function run(path) {
        const file = await open(path);
        const socket = connect({ port: 9000 });
        await file.close();
        socket.end();
      }
    `);

    const relations = new Set(graph.relations.map(({ relation }) => relation));
    expect(relations.has("acquires")).toBe(true);
    expect(relations.has("releases")).toBe(true);
    expect(graph.nodes.filter(({ kind }) => kind === "resource")).toHaveLength(
      2,
    );
    expect(
      graph.coverage.families.find(
        ({ family }) => family === "resource-lifecycle",
      ),
    ).toMatchObject({ status: "partial" });
  });

  it("projects literal seeds and static object flow", () => {
    const graph = graphFor(`
      const source = { token: "TOKEN", count: 1 };
      const { token } = source;
      const copy = { ...source };
      source.count = 2;
      const read = source.token;
    `);

    const relations = new Set(graph.relations.map(({ relation }) => relation));
    for (const expected of [
      "destructures",
      "reads-property",
      "spreads",
      "writes-property",
    ] as const)
      expect(relations.has(expected)).toBe(true);
    expect(
      graph.nodes.find(
        ({ kind, properties }) =>
          kind === "property-slot" && properties.name === "token",
      ),
    ).toBeDefined();
    const literal = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
    });
    expect(literal.status).toBe("ambiguous");
    expect(literal.summary.total_seed_matches).toBe(3);
    const property = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "property", name: "token" },
      direction: "forward-influence",
    });
    expect(property.status).toBe("found");
  });

  it("does not promote transformed return expressions to resolved aliases", () => {
    const graph = graphFor(`
      function increment(value) { return value + 1; }
      const input = 1;
      const output = increment(input);
    `);
    const returnNode = graph.nodes.find(({ kind }) => kind === "return-site");
    if (returnNode === undefined) throw new Error("Expected return site");
    expect(
      graph.relations.filter(
        ({ relation, target_node_id }) =>
          relation === "aliases" && target_node_id === returnNode.node_id,
      ),
    ).toEqual([expect.objectContaining({ resolution: "candidate" })]);
    const output = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "output",
    );
    const input = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === "input",
    );
    if (output === undefined || input === undefined)
      throw new Error("Expected caller bindings");
    const strict = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "semantic-node", node_id: output.node_id },
      direction: "backward-provenance",
    });
    expect(strict.nodes.map(({ node_id }) => node_id)).not.toContain(
      input.node_id,
    );
    expect(strict.status).toBe("ambiguous");
  });

  it("uses unavailable evidence when no source produced semantic IR", () => {
    const graph = buildJavaScriptSemanticGraph({
      rootArtifactSha256: SHA256,
      applicationGraph: { graph_id: GRAPH_ID, nodes: [] },
      analysis: emptyAnalysis(),
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.evidence).toMatchObject({
      authority: "unknown",
      state: "unavailable",
      location: { available: false, reason: "not-observed" },
    });
  });
});

const emptyAnalysis = (): JavaScriptArtifactAnalysis => ({
  files: [],
  packages: [],
  json_modules: [],
  html_scripts: [],
  source_maps: [],
  visited_ast_nodes: 0,
  findings: 0,
  modules: 0,
  parse_failures: 0,
  truncated_scopes: 0,
  limitations: [],
});

const graphFor = (
  source: string,
  inputLimits: Partial<JavaScriptSemanticLimits> = {},
) => {
  const file: JavaScriptArtifactFile = {
    path: "app.js",
    container_sha256: SHA256,
    sha256: SHA256,
    bytes: Buffer.byteLength(source),
    inventory_artifact_id: `art_${SHA256}`,
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: source },
  };
  const semanticLimits = {
    ...DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS,
    ...inputLimits,
  };
  const analysis: JavaScriptArtifactAnalysis = {
    files: [
      {
        file,
        javascript: null,
        semantic: {
          ir: analyzeJavaScriptSemantics(source, inputLimits),
          limits: semanticLimits,
        },
      },
    ],
    packages: [],
    json_modules: [],
    html_scripts: [],
    source_maps: [],
    visited_ast_nodes: 0,
    findings: 0,
    modules: 0,
    parse_failures: 0,
    truncated_scopes: 0,
    limitations: [],
  };
  return buildJavaScriptSemanticGraph({
    rootArtifactSha256: SHA256,
    applicationGraph: { graph_id: GRAPH_ID, nodes: [] },
    analysis,
  });
};
