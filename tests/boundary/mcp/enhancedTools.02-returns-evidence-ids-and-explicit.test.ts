import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { AnalysisOutputError } from "../../../src/domain/errors.js";
import { err } from "../../../src/domain/result.js";
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

describe("enhanced MCP tools", () => {
  it("returns Evidence IDs and explicit call-path frontiers at limits", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "trace_call_path",
      arguments: {
        start: "0x1",
        goal: "0x3",
        max_nodes: 1,
        max_operations: 10,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
      result: {
        goal_status: "not_reached",
        nodes: [{ address: "0x1", depth: 0 }],
        frontier: ["0x2"],
        truncated: true,
        residual_unknowns: expect.arrayContaining([
          expect.stringContaining("reached the node limit"),
          expect.stringContaining("reached the edge limit"),
        ]),
        limits: {
          max_nodes: 1,
          nodes_visited: 1,
          operations_used: 1,
        },
      },
    });
  });

  it("bounds batch concurrency at the parsed maximum of 20", async () => {
    let active = 0;
    let maximum = 0;
    const analysis: AnalysisOperationPort = {
      execute: async (name) => {
        if (name !== "procedure_pseudo_code") return ok(null);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return ok("pseudo");
      },
    };
    const client = await connect(analysis);
    const result = await client.callTool({
      name: "batch_decompile",
      arguments: {
        addresses: Array.from(
          { length: 20 },
          (_, index) => `0x${String(index)}`,
        ),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(maximum).toBe(20);
  });

  it("returns ordered typed batch failures and zero counts for empty input", async () => {
    const tools = new EnhancedTools({
      execute: (_name, arguments_) =>
        arguments_.procedure === "0x2"
          ? Promise.resolve(err(new AnalysisOutputError("decompile", "failed")))
          : Promise.resolve(ok("pseudo")),
    });

    const result = await tools.execute("batch_decompile", {
      addresses: ["0x1", "0x2"],
    });
    const empty = await tools.execute("batch_decompile", { addresses: [] });

    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          { address: "0x1", status: "ok", pseudocode: "pseudo" },
          {
            address: "0x2",
            status: "error",
            error: {
              code: "unreadable_output",
              category: "execution_failure",
              message:
                "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
              retryable: false,
              remediation: {
                action:
                  "Analysis returned an unreadable result. Retry once; if it continues, run `rea doctor`.",
                restart_required: false,
              },
            },
          },
        ],
        total: 2,
        succeeded: 1,
        failed: 1,
      },
    });
    expect(empty).toEqual({
      ok: true,
      value: { items: [], total: 0, succeeded: 0, failed: 0 },
    });
  });
});
