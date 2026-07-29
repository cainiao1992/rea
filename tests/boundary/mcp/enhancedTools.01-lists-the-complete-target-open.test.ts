import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../../../src/contracts/managedWorkflowToolContracts.js";
import {
  ENHANCED_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
} from "../../../src/contracts/toolContracts.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

const PROCEDURES = {
  "0x1": "_TtC7Fixture5Class",
  "0x2": "_TtV7Fixture6Struct",
  "0x3": "_TtP7Fixture8Protocol",
  "0x4": "_TtO7Fixture4Enum",
  "0x5": "_TtE7Fixture9Extension",
  "0x6": "prefix_TtOther",
};

const page = (values: Readonly<Record<string, string>>) => ({
  items: Object.entries(values).map(([address, value]) => ({ address, value })),
  offset: 0,
  limit: 100,
  total: Object.keys(values).length,
  next_offset: null,
  has_more: false,
});

const fixturePort = (): AnalysisOperationPort => ({
  execute: (name, arguments_) => {
    switch (name) {
      case "list_procedures":
        return Promise.resolve(ok(page(PROCEDURES)));
      case "list_names":
        return Promise.resolve(
          ok(
            page({
              "0x10": "_OBJC_CLASS_$_Fixture",
              "0x11": "_OBJC_CLASS_$_Fixture",
              "0x12": "_OBJC_PROTOCOL_$_FixtureDelegate",
              "0x13": "entry",
            }),
          ),
        );
      case "procedure_pseudo_code": {
        const procedure = arguments_.procedure;
        return Promise.resolve(
          ok(typeof procedure === "string" ? `pseudo:${procedure}` : "invalid"),
        );
      }
      case "procedure_callees": {
        const procedure = arguments_.procedure;
        return Promise.resolve(
          ok(
            procedure === "0x1"
              ? ["0x2", "0x3"]
              : procedure === "0x2"
                ? ["0x1"]
                : [],
          ),
        );
      }
      case "procedure_callers":
        return Promise.resolve(ok(["0x9"]));
      case "address_name":
        return Promise.resolve(ok(arguments_.address ?? null));
      case "xrefs":
        return Promise.resolve(ok(["0x20", "0x21"]));
      case "resolve_containing_procedure":
        return Promise.resolve(
          ok({
            query_address:
              typeof arguments_.address === "string"
                ? arguments_.address
                : "0x0",
            found: false,
            procedure: null,
            reason: "not_in_procedure",
          }),
        );
      case "list_segments":
        return Promise.resolve(
          ok([{ name: "__TEXT", start: "0x1000", end: "0x2000" }]),
        );
      case "list_documents":
        return Promise.resolve(ok(["fixture"]));
      case "list_strings":
        return Promise.resolve(ok(page({ "0x30": "hello" })));
      case "analyze_function":
        return Promise.resolve(
          ok({
            procedure: {
              address: "0x1",
              name: "entry",
              signature: null,
              locals: [],
            },
            pseudocode: {
              text: "return 0;",
              total_chars: 9,
              returned_chars: 9,
              truncated: false,
              next_offset: null,
            },
            assembly: {
              items: [],
              total: 0,
              returned: 0,
              truncated: false,
              next_offset: null,
            },
            comments: emptyBounded(),
            callers: emptyBounded(),
            callees: emptyBounded(),
            incoming_references: emptyBounded(),
            outgoing_references: emptyBounded(),
            referenced_strings: emptyBounded(),
            referenced_names: emptyBounded(),
            basic_blocks: emptyBounded(),
            instruction_scan: { scanned: 0, truncated: false },
          }),
        );
      default:
        return Promise.resolve(ok(null));
    }
  },
});

const emptyBounded = () => ({
  items: [],
  total: 0,
  returned: 0,
  truncated: false,
  next_offset: null,
});

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const connect = async (analysis: AnalysisOperationPort = fixturePort()) => {
  const server = createServer(analysis);
  const client = new Client({ name: "enhanced-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const jsonResult = (result: CallToolResult): JsonValue => {
  if (result.structuredContent === undefined)
    throw new Error("Tool result omitted structured content");
  const structured = jsonValueSchema.safeParse(result.structuredContent);
  if (!structured.success)
    throw new Error("Tool structured result was not JSON");
  if (
    typeof structured.data === "object" &&
    structured.data !== null &&
    !Array.isArray(structured.data) &&
    "normalized_result" in structured.data
  ) {
    return structured.data.normalized_result ?? null;
  }
  if (
    typeof structured.data === "object" &&
    structured.data !== null &&
    !Array.isArray(structured.data) &&
    "evidence_id" in structured.data &&
    "result" in structured.data
  )
    return structured.data.result ?? null;
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text")
    throw new Error("Tool result omitted text content");
  const decoded: unknown = JSON.parse(text.text);
  const parsed = jsonValueSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("Tool result was not JSON");
  return parsed.data;
};

describe("enhanced MCP tools", () => {
  it("lists the complete target-open analysis surface", async () => {
    const client = await connect();
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(
      TOOL_CONTRACTS.length -
        SESSION_TOOL_CONTRACTS.length -
        MANAGED_WORKFLOW_TOOL_CONTRACTS.length,
    );
    expect(
      listed.tools
        .map(({ name }) => name)
        .filter((name) =>
          ENHANCED_TOOL_CONTRACTS.some((tool) => tool.name === name),
        )
        .sort(),
    ).toEqual(ENHANCED_TOOL_CONTRACTS.map(({ name }) => name).sort());
  });

  it("executes all thirteen tools through production registration", async () => {
    const client = await connect();
    const calls = [
      ["swift_classes", { pattern: "Fixture" }],
      ["get_objc_classes", { pattern: "Fixture" }],
      ["get_objc_protocols", {}],
      ["batch_decompile", { addresses: ["0x1", "0x2"] }],
      ["get_call_graph", { address: "0x1", direction: "forward", depth: 2 }],
      ["analyze_swift_types", {}],
      ["find_xrefs_to_name", { name: "entry" }],
      ["binary_overview", {}],
      ["analyze_function", { procedure: "0x1" }],
      ["inspect_native_api", { procedure: "0x1" }],
      ["trace_feature", { query: "hello", max_operations: 10 }],
      ["find_code_for_string", { query: "hello", max_operations: 10 }],
      ["trace_call_path", { start: "0x1", goal: "0x2", max_operations: 10 }],
    ] as const;
    const results = await Promise.all(
      calls.map(async ([name, arguments_]) =>
        jsonResult(await client.callTool({ name, arguments: arguments_ })),
      ),
    );
    expect(results[0]).toMatchObject({ count: 1 });
    expect(results[1]).toMatchObject({ count: 1 });
    expect(results[2]).toMatchObject({ count: 1 });
    expect(results[3]).toEqual({
      items: [
        { address: "0x1", status: "ok", pseudocode: "pseudo:0x1" },
        { address: "0x2", status: "ok", pseudocode: "pseudo:0x2" },
      ],
      total: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(results[4]).toEqual({
      "0": [{ address: "0x1", status: "ok", calls: ["0x2", "0x3"] }],
      "1": [
        { address: "0x2", status: "ok", calls: ["0x1"] },
        { address: "0x3", status: "ok", calls: [] },
      ],
    });
    expect(results[5]).toMatchObject({ total: 6 });
    expect(results[6]).toEqual({
      status: "resolved",
      name: "entry",
      address: "0x13",
      xrefs: ["0x20", "0x21"],
    });
    expect(results[7]).toMatchObject({
      document: "fixture",
      segment_count: 1,
      procedure_count: 6,
      string_count: 1,
    });
    expect(results[8]).toMatchObject({
      procedure: { address: "0x1", name: "entry" },
      pseudocode: { text: "return 0;" },
    });
    expect(results[9]).toMatchObject({
      procedure: { address: "0x1", name: "entry" },
      boundary: { available: false },
      unsupported_branches: [
        "structured-boundary-types",
        "jump-table-data-mapping",
      ],
      residual_unknowns: expect.arrayContaining([
        expect.stringContaining("boundary types"),
      ]),
      substeps: [
        { operation: "analyze_function", status: "completed" },
        { operation: "project_native_api_boundary", status: "unsupported" },
        { operation: "preserve_residual_unknowns", status: "completed" },
      ],
    });
    expect(results[10]).toMatchObject({
      query: "hello",
      search_mode: "literal",
      truncated: false,
      references: [
        { target_address: "0x30", source_address: "0x20" },
        { target_address: "0x30", source_address: "0x21" },
      ],
    });
    expect(results[11]).toMatchObject({
      query: "hello",
      matches: [{ type: "string", address: "0x30", value: "hello" }],
      truncated: false,
    });
    expect(results[12]).toMatchObject({
      start: "0x1",
      goal: "0x2",
      direction: "forward",
      goal_status: "reached",
      traversal_path: ["0x1", "0x2"],
      nodes: [
        { address: "0x1", depth: 0 },
        { address: "0x2", depth: 1 },
      ],
      truncated: false,
    });
  });
});
