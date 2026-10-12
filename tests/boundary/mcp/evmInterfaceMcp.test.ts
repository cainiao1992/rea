import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { EvmInterfaceService } from "../../../src/application/evm/EvmInterfaceService.js";
import { WasmArtifactService } from "../../../src/application/wasm/WasmArtifactService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../../src/domain/analysisErrorCore.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { registerEvmTools } from "../../../src/server/registerEvmTools.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { wasmArtifactExecution } from "../../fixtures/wasm/artifact.js";
import {
  evmInterfaceFixture,
  evmInterfaceExecution,
} from "../../fixtures/evm/interface.js";

it("advertises exact valid schemas and records inline EVM interface evidence without a binary target", async () => {
  const value = evmInterfaceFixture();
  const service = new EvmInterfaceService({
    inspect: () => Promise.resolve(ok(evmInterfaceExecution(value))),
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { evmInterface: service },
  );
  const client = new Client({ name: "evm-interface-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_evm_interface",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("EVM interface inspection must publish both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(
    ajv.validate(inputSchema, { path: value.artifact.path, encoding: "hex" }),
  ).toBe(true);
  expect(
    ajv.validate(inputSchema, {
      path: value.artifact.path,
      encoding: "hex",
      approval: true,
    }),
  ).toBe(false);
  expect(() => registerEvmTools(server, service, silentLogger)).toThrow(
    /inspect_evm_interface.*already registered/,
  );
  expect(
    (await client.listTools()).tools.filter(
      (tool) => tool.name === "inspect_evm_interface",
    ),
  ).toHaveLength(1);
  const response = await client.callTool({
    name: "inspect_evm_interface",
    arguments: { path: value.artifact.path, encoding: "hex" },
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_evm_interface").outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed);
  expect(evidence.confidence).toBe("inferred");
  expect(evidence.subject?.digest.sha256).toBe(value.artifact.sha256);
  expect(parsed.normalized_result).toEqual(value);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  expect(
    (
      await client.callTool({
        name: "inspect_evm_interface",
        arguments: { path: "relative.hex", encoding: "hex" },
      })
    ).isError,
  ).toBe(true);
});

it.each(["unavailable", "incompatible-output"])(
  "preserves a healthy WASM peer and explicit EVM failure: %s",
  async (scenario) => {
    const value = evmInterfaceFixture();
    const inspect = vi.fn(() =>
      Promise.resolve(
        scenario === "unavailable"
          ? err(
              new AnalysisCapabilityUnavailableError(
                "fixture-evm",
                "inspect_evm_interface",
                "selected engine unavailable",
              ),
            )
          : ok(
              evmInterfaceExecution({
                ...value,
                artifact: { ...value.artifact, encoding: "raw" },
              }),
            ),
      ),
    );
    const harness = await createApplicationMcpHarness({
      serverOptions: {
        evmInterface: new EvmInterfaceService({ inspect }),
        wasmArtifact: new WasmArtifactService({
          close: () => Promise.resolve(),
          inspect: () => Promise.resolve(ok(wasmArtifactExecution())),
        }),
      },
    });
    onTestFinished(harness.close);
    const invalid = await harness.client.callTool({
      name: "inspect_evm_interface",
      arguments: { path: value.artifact.path, encoding: "hex", approval: true },
    });
    expect(invalid.isError).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
    const failure = await harness.client.callTool({
      name: "inspect_evm_interface",
      arguments: { path: value.artifact.path, encoding: "hex" },
    });
    expect(parseMcpToolError(failure).error.code).toBe(
      scenario === "unavailable"
        ? "capability_unavailable"
        : "unreadable_output",
    );
    const peer = await harness.client.callTool({
      name: "inspect_wasm_artifact",
      arguments: { path: "/artifacts/module.wasm" },
    });
    expect(peer.isError).not.toBe(true);
    const parsed = toolContract("inspect_wasm_artifact").outputSchema.parse(
      peer.structuredContent,
    );
    const evidence = parseEvidence(parsed);
    expect(harness.session.evidenceById(evidence.evidence_id)).toEqual(
      evidence,
    );
    await harness.client.ping();
  },
);

it("retains the injected EVM owner and retries failed cleanup on server shutdown", async () => {
  const close = vi
    .fn()
    .mockRejectedValueOnce(new Error("retained EVM worker"))
    .mockResolvedValue(undefined);
  const service = new EvmInterfaceService({
    close,
    inspect: () => Promise.resolve(ok(evmInterfaceExecution())),
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { evmInterface: service },
  );
  const client = new Client({ name: "evm-cleanup-retry", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const response = await client.callTool({
      name: "inspect_evm_interface",
      arguments: { path: "/artifacts/source-owned.hex", encoding: "hex" },
    });
    expect(response.isError).not.toBe(true);
    await expect(server.close()).rejects.toThrow("REA session cleanup failed");
    await server.close();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});

it("settles the admitted EVM operation after SDK cancellation and accepts a subsequent request", async () => {
  const entered = createDeferred<void>();
  const stopped = createDeferred<void>();
  let invocations = 0;
  const harness = await createApplicationMcpHarness({
    serverOptions: {
      evmInterface: new EvmInterfaceService({
        inspect: async (_input, options) => {
          if (invocations++ > 0) return ok(evmInterfaceExecution());
          const signal = options?.signal;
          if (signal === undefined)
            throw new Error("MCP request omitted cancellation signal");
          const aborted = new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
          entered.resolve();
          await aborted;
          stopped.resolve();
          return err(new AnalysisCancelledError("inspect_evm_interface"));
        },
      }),
    },
  });
  onTestFinished(harness.close);
  const controller = new AbortController();
  const input = {
    name: "inspect_evm_interface",
    arguments: { path: "/artifacts/source-owned.hex", encoding: "hex" },
  };
  const cancellation = harness.client
    .callTool(input, { signal: controller.signal })
    .then(
      () => "completed",
      (error: unknown) => error,
    );
  await entered.promise;
  controller.abort(new Error("SDK EVM cancellation verification"));
  expect(await cancellation).toMatchObject({
    message: expect.stringContaining("SDK EVM cancellation verification"),
    code: "REQUEST_TIMEOUT",
  });
  await stopped.promise;
  await harness.client.ping();
  expect((await harness.client.callTool(input)).isError).not.toBe(true);
  expect(invocations).toBe(2);
});
