import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type { BinarySession } from "../../../src/application/BinarySession.js";
import type { ElectronActiveObservationPort } from "../../../src/application/ElectronActiveObservationPort.js";
import { loadConfiguredPermissionAuthority } from "../../../src/application/PermissionConfiguration.js";
import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { parseConfig } from "../../../src/config.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { writeElectronBoundaryFixture } from "../../fixtures/electronBoundaryApplication.js";
import { createElectronActiveObservationFixtureResult } from "../../../src/domain/electronActiveObservation.fixture.js";

const browsers: FakeCdpBrowser[] = [];
const resources: Array<{ close(): Promise<unknown> }> = [];
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async (item) => item.close()));
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

it("exposes root-confined Electron discovery and inspection as Evidence", async () => {
  const root = await createTestTempDirectory("rea-electron-mcp-");
  temporary.push(root);
  await writeFile(join(root, "index.html"), "<script src='app.js'></script>");
  await writeFile(
    join(root, "app.js"),
    "export const observed = 'source-secret';",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "runtime-fixture", renderer: "index.html" }),
  );
  await writeFile(join(root, "worker.js"), "self.onmessage = () => {};\n");
  const browser = await startFakeCdpBrowser({
    electronFileUrl: pathToFileURL(join(root, "index.html")).href,
  });
  browsers.push(browser);
  const config = parseConfig({
    REA_ELECTRON_OBSERVE_ENABLED: "true",
    REA_ELECTRON_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
    REA_ELECTRON_FILE_ROOTS_JSON: JSON.stringify([root]),
  });
  if (!config.ok) throw config.error;
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok) throw authority.error;
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session, {
    electronObservation: new CdpElectronProvider(),
    permissionAuthority: authority.value,
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      evidenceFileRoots: 0,
      investigationInputRoots: 1,
      electronObservationEnabled: true,
    }),
  });
  const client = new Client({ name: "electron-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.callTool({
    name: "list_electron_targets",
    arguments: {
      cdp_endpoint: browser.endpoint,
      allowed_file_roots: [root],
    },
  });
  expect(listed.isError).not.toBe(true);
  expect(listed.structuredContent).toMatchObject({
    result: {
      targets: [{ target_id: "electron-page" }],
    },
  });
  const discoveryEvidenceId = evidenceIdFrom(listed.structuredContent);
  const inspected = await client.callTool({
    name: "inspect_electron_page",
    arguments: {
      discovery_evidence_id: discoveryEvidenceId,
      target_id: "electron-page",
      observation_ms: 0,
      include_script_sources: true,
    },
  });
  const analyzed = await client.callTool({
    name: "analyze_javascript_application",
    arguments: { input_path: root },
  });
  expect(analyzed.isError).not.toBe(true);
  expect(analyzed.structuredContent).toMatchObject({
    result: { graph: { nodes: expect.any(Array), edges: expect.any(Array) } },
  });
  const analysisText = analyzed.content.find(({ type }) => type === "text");
  expect(analysisText).toBeDefined();
  if (analysisText?.type !== "text")
    throw new TypeError("Missing JavaScript analysis text projection");
  expect(analysisText.text).toContain('"nodes":[');
  const reconciled = await client.callTool({
    name: "reconcile_javascript_runtime",
    arguments: {
      static_layers: [
        {
          role: "application",
          analysis: evidenceFor(session, analyzed.structuredContent),
        },
      ],
      runtime_observations: [evidenceFor(session, inspected.structuredContent)],
    },
  });
  expect(reconciled.isError).not.toBe(true);
  expect(reconciled.structuredContent).toMatchObject({
    result: {
      summary: { runtime_scripts: 1, matched: expect.any(Number) },
      source_map_authority: { used_for_primary_matching: false },
    },
  });
  expect(inspected.isError).not.toBe(true);
  expect(inspected.structuredContent).toMatchObject({
    result: {
      target: { file_path: expect.stringMatching(/\/index\.html$/u) },
      scripts: {
        items: [
          expect.objectContaining({
            frame_id: "frame-main",
            file_path: expect.stringMatching(/\/app\.js$/u),
          }),
        ],
      },
      workers: [
        expect.objectContaining({
          target_id: "electron-worker",
          opener_target_id: "electron-page",
          file_path: expect.stringMatching(/\/worker\.js$/u),
        }),
      ],
    },
  });
  const outside = join(root, "..", `outside-${Date.now().toString(16)}`);
  await mkdir(outside);
  temporary.push(outside);
  const commandsBeforeDenial = browser.commands.length;
  const denied = await client.callTool({
    name: "list_electron_targets",
    arguments: {
      cdp_endpoint: browser.endpoint,
      allowed_file_roots: [outside],
    },
  });
  expect(denied.isError).toBe(true);
  expect(denied.structuredContent).toMatchObject({
    error: {
      code: "permission_required",
      details: { missing: { roots: [expect.stringMatching(/outside-/u)] } },
    },
  });
  expect(browser.commands).toHaveLength(commandsBeforeDenial);
}, 20_000);

it("exposes active Electron scenarios through the separately granted MCP boundary", async () => {
  const root = await createTestTempDirectory("rea-electron-active-mcp-");
  temporary.push(root);
  const applicationPath = join(root, "main.js");
  await writeFile(applicationPath, "module.exports = {};\n");
  const aliasedRoot = join(root, "..", `${root.split("/").at(-1)}-alias`);
  await symlink(root, aliasedRoot, "dir");
  temporary.push(aliasedRoot);
  const capturedInputs: unknown[] = [];
  const activeResult =
    createElectronActiveObservationFixtureResult(applicationPath);
  const provider: ElectronActiveObservationPort = {
    identity: () => ({
      id: "test-electron-active",
      name: "Test Electron active provider",
      version: "1",
    }),
    capture: async (input) => {
      capturedInputs.push(input);
      return { ok: true, value: activeResult };
    },
  };
  const config = parseConfig({
    REA_ELECTRON_AUTOMATE_ENABLED: "true",
    REA_ELECTRON_AUTOMATE_AUTO_GRANT: "true",
    REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON: JSON.stringify([
      dirname(process.execPath),
    ]),
    REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON: JSON.stringify([root]),
  });
  if (!config.ok) throw config.error;
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok) throw authority.error;
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session, {
    electronActiveObservation: provider,
    permissionAuthority: authority.value,
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      evidenceFileRoots: 0,
      investigationInputRoots: 0,
      electronAutomationEnabled: true,
    }),
  });
  const client = new Client({ name: "electron-active-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const captured = await client.callTool({
    name: "capture_electron_scenario",
    arguments: {
      executable_path: process.execPath,
      application_path: join(aliasedRoot, "main.js"),
      application_root: aliasedRoot,
      args: ["--token", "super-secret"],
      actions: [
        { step_id: "submit", kind: "click", selector: "#submit-secret" },
      ],
    },
  });
  expect(captured.isError, JSON.stringify(captured)).not.toBe(true);
  expect(captured.structuredContent).toMatchObject({
    result: {
      application: { process_ownership: "provider-owned" },
      ipc: { events: [{ channel: "readiness:echo" }] },
      coverage: {
        status: "partial_attach",
        pre_capture_activity: "unavailable",
      },
    },
  });
  expect(capturedInputs).toHaveLength(1);
  expect(capturedInputs[0]).toMatchObject({
    application_path: applicationPath,
    application_root: root,
  });
  expect(JSON.stringify(captured.structuredContent)).not.toContain(
    "submit-secret",
  );
  expect(JSON.stringify(captured.structuredContent)).not.toContain(
    "super-secret",
  );
  const evidenceId = Reflect.get(
    captured.structuredContent ?? {},
    "evidence_id",
  );
  expect(session.evidenceById(String(evidenceId))).toMatchObject({
    predicate_type: "rea.electron-active-scenario",
    parameters: {
      args: ["--token", "<redacted>"],
      actions: [{ step_id: "submit", kind: "click" }],
    },
  });
}, 20_000);

it("exposes the target-free static JavaScript application workflow", async () => {
  const root = await createTestTempDirectory("rea-electron-static-mcp-");
  temporary.push(root);
  await writeElectronBoundaryFixture(root);
  const config = parseConfig({});
  if (!config.ok) throw config.error;
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok) throw authority.error;
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session, {
    permissionAuthority: authority.value,
    availabilityPolicy: () => ({
      processCaptureEnabled: false,
      evidenceFileRoots: 0,
      investigationInputRoots: 1,
    }),
  });
  const client = new Client({
    name: "electron-static-mcp-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const analyzed = await client.callTool({
    name: "analyze_javascript_application",
    arguments: { input_path: root },
  });

  expect(analyzed.isError).not.toBe(true);
  const projected = z
    .object({
      evidence_id: z.string(),
      result: z.object({
        input_path: z.string(),
        summary: z.object({
          browser_windows: z.number(),
          context_bridge_apis: z.number(),
          ipc: z.object({ paired_renderer_transmissions: z.number() }),
        }),
        graph: z.object({
          graph_id: z.string(),
          nodes: z.array(z.unknown()),
          edges: z.array(z.unknown()),
        }),
        semantic_graph: z.object({
          graph_id: z.string(),
          nodes: z.array(z.unknown()),
          relations: z.array(z.unknown()),
        }),
      }),
      evidence: z.object({
        operation: z.literal("analyze_javascript_application"),
        parameters: z.object({ format: z.string() }),
      }),
    })
    .parse(analyzed.structuredContent);
  expect(projected.result).toMatchObject({
    input_path: expect.stringMatching(/rea-electron-static-mcp-/u),
    summary: {
      browser_windows: 3,
      context_bridge_apis: 2,
      ipc: { paired_renderer_transmissions: 4 },
    },
  });
  expect(projected.result.graph.nodes.length).toBeGreaterThan(0);
  expect(projected.result.semantic_graph.nodes.length).toBeGreaterThan(0);
  expect(projected.evidence.operation).toBe("analyze_javascript_application");
});

const evidenceFor = (session: BinarySession, value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("evidence_id" in value) ||
    typeof value.evidence_id !== "string"
  )
    throw new TypeError("Missing compact Evidence ID");
  const evidence = session.evidenceById(value.evidence_id);
  if (evidence === undefined) throw new TypeError("Missing session Evidence");
  return evidence;
};

const evidenceIdFrom = (value: unknown): string => {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Missing structured result");
  const evidenceId = Reflect.get(value, "evidence_id");
  if (typeof evidenceId !== "string")
    throw new TypeError("Missing Evidence ID");
  return evidenceId;
};
