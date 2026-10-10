import { afterEach, expect, it, vi } from "vitest";

import * as processOwnership from "../process/ProcessOwnership.js";
import { electronActiveObservationInputSchema } from "../domain/javascript/electronActiveObservation.js";
import * as electronActions from "./PlaywrightElectronActiveActions.js";
import { PlaywrightElectronActiveProvider } from "./PlaywrightElectronActiveProvider.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("passes the selected environment and ownership token to Electron launch", async () => {
  vi.stubEnv("LANG", "ambient-language");
  let launchedEnvironment: unknown;
  const provider = new PlaywrightElectronActiveProvider(
    {
      LANG: "selected-language",
      PATH: "/selected/bin",
      REA_PRIVATE_VALUE: "not-a-launch-setting",
    },
    async (options) => {
      launchedEnvironment = options?.env;
      throw new Error("launch boundary reached");
    },
  );
  const result = await provider.capture(
    electronActiveObservationInputSchema.parse({
      executable_path: process.execPath,
      application_path: process.execPath,
    }),
  );

  expect(result.ok).toBe(false);
  expect(launchedEnvironment).toEqual({
    LANG: "selected-language",
    PATH: "/selected/bin",
    REA_PROCESS_RUN_ID: expect.any(String),
  });
});

it("retains the partial capture without taskkill when Windows lineage is unavailable", async () => {
  // Exercise the Windows decision branch; this is not native Windows coverage.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  const terminateTree = vi
    .spyOn(processOwnership, "cleanupWindowsProcessTree")
    .mockResolvedValue({ cleaned: true, signaled: true });
  const hookSnapshot = {
    events: [],
    retention_budget_bytes: 0,
    estimated_retained_bytes: 0,
    event_serialized_byte_upper_bound: 0,
    retained: 0,
    dropped: 0,
    dropped_ipc: 0,
    dropped_runtime: 0,
    dropped_event_families: [],
    dropped_event_roles: [],
    observed: 0,
    observed_ipc: 0,
    observed_runtime: 0,
    hook_error: false,
  };
  vi.spyOn(electronActions, "readApplicationState").mockResolvedValue({
    windows: [],
    metrics: [],
    electronVersion: "44.0.0",
    hookSnapshot,
  });
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    windows: () => [],
  };
  const provider = new PlaywrightElectronActiveProvider(
    {},
    async () =>
      application as unknown as Awaited<
        ReturnType<typeof import("playwright-core")._electron.launch>
      >,
  );

  try {
    const result = await provider.capture(
      electronActiveObservationInputSchema.parse({
        executable_path: process.execPath,
        application_path: process.execPath,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected unverified cleanup to fail");
    expect(terminateTree).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({
      _tag: "BrowserObservationError",
      reason: "cleanup_failed",
      cleanup: {
        reason:
          "owned Electron lineage was unavailable; helper cleanup was not proven",
      },
      partialObservation: {
        kind: "electron-active-observation",
        capture: {
          application: {
            cleanup: "unverified",
          },
        },
      },
    });
  } finally {
    if (originalPlatform !== undefined)
      Object.defineProperty(process, "platform", originalPlatform);
  }
});
