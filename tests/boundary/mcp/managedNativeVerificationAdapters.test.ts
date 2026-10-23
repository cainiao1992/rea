import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";

import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { managedNativeVerificationResultSchema } from "../../../src/domain/managed/managedNativeVerificationSchemas.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const client = new Client({ name: "managed-native-adapters", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" },
  stderr: "pipe",
});
beforeAll(async () => {
  await client.connect(transport);
  transport.stderr?.on("data", () => undefined);
});
afterAll(async () => {
  await Promise.all([client.close(), transport.close()]);
});

/** Authentic native Evidence whose operation the workflow cannot read symbols from. */
const signatureEvidence = () =>
  createEvidence(
    {
      path: "/usr/bin/true",
      sha256: "a".repeat(64),
      format: "mach-o",
      architecture: "arm64",
    },
    { id: "native", name: "Native", version: "simulated" },
    {
      predicateType: "rea.native-signature",
      operation: "inspect_signature",
      parameters: {},
      result: { signed: true },
      limitations: ["No native provider executed."],
    },
  );

cliTest(
  "preserves explicit PE module suffixes and matches only the Windows DLL variation through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-managed-native-module-names-",
    );
    const nativeProvider = {
      id: "native-fixture",
      name: "Synthetic native fixture",
      version: "1",
    };
    const dossier = functionDossierSchema.parse({
      procedure: {
        address: "0x1000",
        name: "open_native",
        classification: {
          external: false,
          thunk: false,
          thunk_target: null,
          provenance: "synthetic-provider",
        },
        body: { available: false, reason: "Synthetic test Evidence only." },
        signature: null,
        locals: [],
      },
      pseudocode: "",
      assembly: [],
      comments: [],
      callers: [],
      callees: [],
      incoming_references: [],
      outgoing_references: [],
      referenced_strings: [],
      referenced_names: [],
      basic_blocks: [],
      native_api: null,
      native_value_flow: null,
      limitations: ["No native provider was executed."],
    });
    const cases = [
      {
        format: "pe",
        scope: "nativehelper.dll",
        module: "nativehelper.dll",
        status: "verified",
      },
      {
        format: "pe",
        scope: "nativehelper.dll",
        module: "nativehelper.exe",
        status: "contradicted",
      },
      {
        format: "pe",
        scope: "nativehelper.dll",
        module: "nativehelper.node",
        status: "contradicted",
      },
      {
        format: "pe",
        scope: "nativehelper",
        module: "nativehelper.dll",
        status: "verified",
      },
      {
        scope: "nativedep.so.6",
        module: "libnativedep.so.6",
        format: "elf",
        status: "verified",
      },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const managedPath = join(root, `managed-${String(index)}.dll`);
      await writeFile(
        managedPath,
        buildManagedPeFixture({
          pinvoke: { importName: "open_native", moduleName: item.scope },
        }),
      );
      const inspected = await client.callTool({
        name: "inspect_managed_native_boundaries",
        arguments: { path: managedPath },
      });
      expect(inspected.isError, JSON.stringify(inspected.content)).not.toBe(
        true,
      );
      const managed = parseEvidence(inspected.structuredContent);
      const native = createEvidence(
        {
          path: `/synthetic/${item.module}`,
          sha256: "8".repeat(64),
          format: item.format ?? "pe",
        },
        nativeProvider,
        {
          operation: "analyze_function",
          parameters: {},
          result: dossier,
          rawResult: null,
          limitations: ["Synthetic native Evidence; no provider executed."],
        },
      );
      const input = {
        managed_boundaries: managed,
        native_observations: [native],
      };
      const mcp = await client.callTool({
        name: "verify_managed_native_boundaries",
        arguments: input,
      });
      expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
      const mcpResult = managedNativeVerificationResultSchema.parse(
        parseEvidence(mcp.structuredContent).normalized_result,
      );
      const request = join(root, `verify-${String(index)}.json`);
      await writeFile(request, JSON.stringify(input));
      const cliRun = await cli.run({
        arguments: ["verify-managed-native-boundaries", request, "--json"],
      });
      expect(cliRun.exitCode, cliRun.stderr).toBe(0);
      const cliResult = managedNativeVerificationResultSchema.parse(
        parseEvidence(cliRun.json).normalized_result,
      );
      expect(mcpResult).toEqual(cliResult);
      expect(mcpResult.pinvoke_imports[0]).toMatchObject({
        status: item.status,
        ...(item.status === "contradicted" ? { basis: "module-mismatch" } : {}),
      });
    }
  },
  60_000,
);

cliTest(
  "counts authentic unsupported native Evidence identically through MCP and CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-native-adapters-");
    const path = join(root, "fixture.dll");
    await writeFile(path, buildManagedPeFixture({ pinvoke: {} }));
    const inspected = await client.callTool({
      name: "inspect_managed_native_boundaries",
      arguments: { path },
    });
    expect(inspected.isError).not.toBe(true);
    const managed = parseEvidence(inspected.structuredContent);
    const native = signatureEvidence();
    const input = {
      managed_boundaries: managed,
      native_observations: [native],
    };

    const mcp = await client.callTool({
      name: "verify_managed_native_boundaries",
      arguments: input,
    });
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
    const mcpResult = managedNativeVerificationResultSchema.parse(
      parseEvidence(mcp.structuredContent).normalized_result,
    );

    const request = join(root, "verify.json");
    await writeFile(request, JSON.stringify(input));
    const cliRun = await cli.run({
      arguments: ["verify-managed-native-boundaries", request, "--json"],
    });
    expect(cliRun.exitCode, cliRun.stderr).toBe(0);
    const cliResult = managedNativeVerificationResultSchema.parse(
      parseEvidence(cliRun.json).normalized_result,
    );

    expect(mcpResult).toEqual(cliResult);
    expect(mcpResult).toMatchObject({
      native_observations: {
        total: 1,
        accepted: 0,
        unsupported: 1,
        symbols: 0,
      },
      summary: { unresolved: 1 },
      pinvoke_imports: [
        expect.objectContaining({ basis: "unsupported-native-evidence" }),
      ],
      coverage: { status: "partial" },
      evidence_links: [managed.evidence_id, native.evidence_id],
    });
    expect(mcpResult.limitations).toContain(
      "Some native Evidence operations were unsupported by this workflow.",
    );

    const tampered = await client.callTool({
      name: "verify_managed_native_boundaries",
      arguments: {
        ...input,
        native_observations: [{ ...native, operation: "inspect_macho" }],
      },
    });
    expect(parseMcpToolError(tampered)).toMatchObject({
      error: { code: "evidence_integrity_mismatch" },
    });
  },
  60_000,
);
