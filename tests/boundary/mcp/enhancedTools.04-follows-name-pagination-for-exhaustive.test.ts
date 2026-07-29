import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
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
  it("follows name pagination for exhaustive Objective-C discovery", async () => {
    const offsets: number[] = [];
    const client = await connect({
      execute: (name, arguments_) => {
        expect(name).toBe("list_names");
        const offset =
          typeof arguments_.offset === "number" ? arguments_.offset : 0;
        offsets.push(offset);
        return Promise.resolve(
          ok({
            items: [
              {
                address: offset === 500 ? "0x2" : "0x1",
                value:
                  offset === 500 ? "_OBJC_CLASS_$_Last" : "_OBJC_CLASS_$_First",
              },
            ],
            offset,
            limit: 500,
            total: 2,
            next_offset: offset === 500 ? null : 500,
            has_more: offset !== 500,
          }),
        );
      },
    });
    const result = jsonResult(
      await client.callTool({ name: "get_objc_classes", arguments: {} }),
    );
    expect(offsets).toEqual([0, 500]);
    expect(result).toMatchObject({ count: 2 });
  });

  it("honors overview detail and limit while reporting exhaustive totals", async () => {
    const procedureOffsets: number[] = [];
    const client = await connect({
      execute: (name, arguments_) => {
        switch (name) {
          case "list_segments":
            return Promise.resolve(
              ok([
                { name: "__TEXT", start: "0x1000", end: "0x1800" },
                { name: "__DATA", start: "0x1800", end: "0x2000" },
              ]),
            );
          case "list_documents":
            return Promise.resolve(ok(["fixture"]));
          case "list_strings":
            return Promise.resolve(
              ok({
                items: [{ address: "0x30", value: "first page only" }],
                offset: 0,
                limit: 100,
                total: 700,
                next_offset: 100,
                has_more: true,
              }),
            );
          case "list_procedures": {
            const offset =
              typeof arguments_.offset === "number" ? arguments_.offset : 0;
            procedureOffsets.push(offset);
            return Promise.resolve(
              ok({
                items: [
                  {
                    address: offset === 500 ? "0x2" : "0x1",
                    value: offset === 500 ? "last" : "first",
                  },
                ],
                offset,
                limit: 500,
                total: 2,
                next_offset: offset === 500 ? null : 500,
                has_more: offset !== 500,
              }),
            );
          }
          default:
            return Promise.resolve(ok(null));
        }
      },
    });
    const result = jsonResult(
      await client.callTool({
        name: "binary_overview",
        arguments: { detail: "detailed", limit: 1 },
      }),
    );
    expect(procedureOffsets).toEqual([0]);
    expect(result).toEqual({
      document: "fixture",
      detail: "detailed",
      segments: [
        { name: "__TEXT", start: "0x1000", end: "0x1800", length: 2048 },
      ],
      segment_count: 2,
      procedure_count: 2,
      string_count: 700,
    });
  });

  it("rejects non-advancing pagination metadata", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(
          ok({
            items: [{ address: "0x1", value: "_TtC5First" }],
            offset: 0,
            limit: 500,
            total: 2,
            next_offset: 0,
            has_more: true,
          }),
        ),
    });
    const result = await client.callTool({
      name: "swift_classes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      JSON.stringify(result.structuredContent),
    );
  });
});
