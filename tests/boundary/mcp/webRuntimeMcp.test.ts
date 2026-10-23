import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { WebRuntimeService } from "../../../src/application/WebRuntimeService.js";
import { recordingWebRuntimePort } from "../../../src/application/WebRuntimeService.fixture.js";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  runtimeSourceA,
  runtimeSourceB,
  startRuntimeBrowser,
} from "../../fixtures/webRuntime.js";

it("advertises actual SDK schemas, instrumentation effects and session-owned inline runtime evidence", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Binary provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    {
      webRuntime: new WebRuntimeService(recordingWebRuntimePort()),
    },
  );
  const client = new Client({ name: "web-runtime-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const input = {
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "allowed-page",
    observation_ms: 5,
  };
  for (const name of [
    "observe_web_execution",
    "inspect_web_event_listeners",
  ] as const) {
    const advertised = tools.find((tool) => tool.name === name);
    if (advertised?.outputSchema === undefined)
      throw new Error(`Missing advertised runtime schemas: ${name}`);
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = advertised.outputSchema;
    expect(ajv.validateSchema(inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    const args =
      name === "observe_web_execution"
        ? input
        : {
            cdp_endpoint: "http://127.0.0.1:9222",
            target_id: "allowed-page",
            selector: "#selected",
          };
    expect(ajv.validate(inputSchema, args)).toBe(true);
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const parsed = toolContract(name).outputSchema.parse(
      response.structuredContent,
    );
    const evidence = parseEvidence(parsed);
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  }
  expect(toolContract("observe_web_execution").effects).toMatchObject({
    mutatesTarget: true,
    mayDiscardData: true,
    idempotent: false,
  });
  const invalid = await client.callTool({
    name: "observe_web_execution",
    arguments: { ...input, observation_ms: 2_147_483_648 },
  });
  expect(invalid.isError).toBe(true);
});

it.each([
  {
    name: "observe_web_execution" as const,
    cleanupMethod: "Profiler.disable",
    args: { target_id: "allowed-page", observation_ms: 5 },
  },
  {
    name: "inspect_web_event_listeners" as const,
    cleanupMethod: "Runtime.releaseObjectGroup",
    args: { target_id: "allowed-page", selector: "#selected" },
  },
])(
  "retains promoted partial Evidence from $name after simulated CDP cleanup failure",
  async ({ name, cleanupMethod, args }) => {
    const browser = await startRuntimeBrowser({
      unsupportedMethods: [cleanupMethod],
    });
    const session = createTestBinarySession(() => {
      throw new Error("Binary provider must not start");
    });
    const server = createServer(
      { kind: "session", session },
      { webRuntime: new WebRuntimeService(new CdpWebRuntimeProvider()) },
    );
    const client = new Client({ name: "web-runtime-partial", version: "1" });
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
      await browser.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name,
      arguments: { cdp_endpoint: browser.endpoint, ...args },
    });
    const { error } = parseMcpToolError(response);
    expect(error).toMatchObject({
      code: "cleanup_incomplete",
      category: "execution_failure",
      retryable: false,
      details: {
        cleanup: "incomplete",
        partial_observation: {
          kind: "retained-evidence",
          evidence_id: expect.any(String),
        },
      },
    });
    expect(JSON.stringify(error)).toContain(cleanupMethod);
    const partialReference = error.details?.partial_observation;
    if (
      typeof partialReference !== "object" ||
      partialReference === null ||
      !("evidence_id" in partialReference) ||
      typeof partialReference.evidence_id !== "string"
    )
      throw new Error("Cleanup failure omitted its retained partial Evidence");
    const partial = parseEvidence(
      session.evidenceById(partialReference.evidence_id),
    );
    expect(partial.operation).toBe(name);
    if (name === "observe_web_execution") {
      expect(partial.normalized_result).toMatchObject({
        target: { target_id: "allowed-page" },
        window: { requested_ms: 5 },
        coverage: { state: "captured" },
        sources: [
          {
            script_id: "script-a",
            source: { state: "captured", text: runtimeSourceA },
          },
          {
            script_id: "script-b",
            source: { state: "captured", text: runtimeSourceB },
          },
        ],
      });
    } else {
      expect(partial.normalized_result).toMatchObject({
        target: { target_id: "allowed-page" },
        selected_node: { selector: "#selected", match: "found" },
        listeners: [
          {
            type: "click",
            location: {
              script_id: "script-a",
              source_association: "script_id",
              line_number: 1,
            },
          },
        ],
      });
    }
    expect(
      browser.commands.some(({ method }) => method === cleanupMethod),
    ).toBe(true);
  },
);
