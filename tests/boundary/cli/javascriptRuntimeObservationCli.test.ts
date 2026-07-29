import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { loadConfiguredPermissionAuthority } from "../../../src/application/PermissionConfiguration.js";
import { observeJavaScriptRuntime } from "../../../src/application/JavaScriptRuntimeObservationService.js";
import { V8InspectorProvider } from "../../../src/browser/V8InspectorProvider.js";
import { parseConfig } from "../../../src/config.js";
import { startFakeV8Inspector } from "../../fixtures/fakeV8Inspector.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const TIMEOUT_MS = 20_000;

describe("JavaScript runtime observation CLI parity", () => {
  const resources: Array<{ close(): Promise<unknown> }> = [];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map((item) => item.close()));
    await Promise.all(
      temporary
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  test(
    "returns the same passive Inspector Evidence contracts",
    async () => {
      const root = await createTestTempDirectory("rea-v8-cli-");
      temporary.push(root);
      const entry = join(root, "entry.js");
      await writeFile(entry, "export const value = 1;\n");
      const inspector = await startFakeV8Inspector({
        targetUrl: pathToFileURL(entry).href,
      });
      resources.push(inspector);
      const environment = {
        ...process.env,
        REA_V8_INSPECTOR_OBSERVE_ENABLED: "true",
        REA_V8_INSPECTOR_ENDPOINTS_JSON: JSON.stringify([inspector.endpoint]),
        REA_V8_INSPECTOR_FILE_ROOTS_JSON: JSON.stringify([root]),
      };

      const listed = await runCli(
        [
          "list-javascript-runtime-targets",
          inspector.endpoint,
          "--approved",
          "--json",
        ],
        environment,
      );
      expect(listed).toMatchObject({
        operation: "list_javascript_runtime_targets",
        provider: { id: "rea-v8-inspector" },
        normalized_result: {
          targets: { items: [{ target_id: inspector.targetId }] },
        },
      });

      const observed = await runCli(
        [
          "observe-javascript-runtime",
          inspector.endpoint,
          inspector.targetId,
          "--runtime-kind",
          "node",
          "--approved",
          "--observation-ms",
          "10",
          "--json",
        ],
        environment,
      );
      expect(observed).toMatchObject({
        operation: "observe_javascript_runtime",
        provider: { id: "rea-v8-inspector" },
        normalized_result: {
          target: { target_id: inspector.targetId, runtime_kind: "node" },
          scripts: {
            items: [
              expect.objectContaining({
                location: { kind: "file", file_path: entry },
              }),
            ],
          },
        },
      });
      const config = parseConfig(environment);
      if (!config.ok) throw config.error;
      const authority = await loadConfiguredPermissionAuthority(config.value);
      if (!authority.ok) throw authority.error;
      const direct = await observeJavaScriptRuntime(
        new V8InspectorProvider(),
        authority.value,
        {
          inspector_endpoint: inspector.endpoint,
          allowed_file_roots: [root],
          allowed_origins: [],
          target_id: inspector.targetId,
          runtime_kind: "node",
          approved: true,
          observation_ms: 10,
          limits: {
            max_events: 10_000,
            max_scripts: 2_000,
            max_execution_contexts: 1_000,
            max_location_bytes: 16_384,
            max_total_metadata_bytes: 4_194_304,
          },
        },
      );
      expect(direct.ok).toBe(true);
      if (direct.ok)
        expect(evidenceIdFrom(observed)).toBe(direct.value.evidence_id);
    },
    TIMEOUT_MS,
  );
});

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<unknown> => {
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", ...arguments_],
    {
      cwd: process.cwd(),
      env: environment,
      maxBuffer: 16 * 1_024 * 1_024,
    },
  );
  return JSON.parse(stdout);
};

const evidenceIdFrom = (value: unknown): string => {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Missing CLI Evidence");
  const id = Reflect.get(value, "evidence_id");
  if (typeof id !== "string") throw new TypeError("Missing CLI Evidence ID");
  return id;
};
