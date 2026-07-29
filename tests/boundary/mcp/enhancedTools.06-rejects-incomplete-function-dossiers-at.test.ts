import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
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
  it("rejects incomplete function dossiers at the application boundary", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(
          ok({
            procedure: { address: "0x1", name: "entry" },
            pseudocode: { text: "plausible but incomplete" },
          }),
        ),
    });
    const result = await client.callTool({
      name: "analyze_function",
      arguments: { procedure: "0x1" },
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      JSON.stringify(result.structuredContent),
    );
  });

  it("rejects deceptive function dossier collection metadata", async () => {
    const malformedPort = fixturePort();
    const client = await connect({
      execute: async (name, arguments_, options) => {
        const result = await malformedPort.execute(name, arguments_, options);
        if (!result.ok || name !== "analyze_function") return result;
        const dossier = result.value.result;
        if (
          typeof dossier !== "object" ||
          dossier === null ||
          Array.isArray(dossier)
        )
          return result;
        return ok({
          ...dossier,
          comments: {
            items: [],
            total: 0,
            returned: 1,
            truncated: false,
            next_offset: null,
          },
        });
      },
    });
    const result = await client.callTool({
      name: "analyze_function",
      arguments: { procedure: "0x1" },
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      JSON.stringify(result.structuredContent),
    );
  });

  it("accepts a final dossier page whose total exceeds returned", async () => {
    const malformedPort = fixturePort();
    const client = await connect({
      execute: async (name, arguments_, options) => {
        const result = await malformedPort.execute(name, arguments_, options);
        if (!result.ok || name !== "analyze_function") return result;
        const dossier = result.value.result;
        if (
          typeof dossier !== "object" ||
          dossier === null ||
          Array.isArray(dossier)
        )
          return result;
        return ok({
          ...dossier,
          callers: {
            items: [],
            total: 1,
            returned: 0,
            truncated: false,
            next_offset: null,
          },
        });
      },
    });
    const result = await client.callTool({
      name: "analyze_function",
      arguments: { procedure: "0x1" },
    });
    expect(result.isError).not.toBe(true);
  });
});
