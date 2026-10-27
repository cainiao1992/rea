import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { HopperStartError } from "../domain/hopperErrors.js";
const createTestTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join("/tmp", prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const injection = vi.hoisted(() => ({
  directory: undefined as string | undefined,
  admission: "accepted" as "accepted" | "not_private" | "access_denied",
  invalidateOnClose: false,
  closeCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] !== injection.directory) return handle;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        injection.closeCalls += 1;
        if (injection.closeCalls === 1) {
          if (injection.invalidateOnClose) await close();
          throw new Error("injected directory close failure");
        }
        await close();
      });
      if (injection.admission !== "accepted") {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async () => {
          if (injection.admission === "access_denied")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          const observed = await stat();
          observed.isDirectory = () => false;
          return observed;
        });
      }
      return handle;
    },
  };
});

const { acquireLinuxHopperApplicationLease } = await import("./HopperLease.js");
const { HopperApplicationLauncher } =
  await import("../hopper/BridgeLauncher.js");

afterEach(() => {
  injection.directory = undefined;
  injection.admission = "accepted";
  injection.invalidateOnClose = false;
  injection.closeCalls = 0;
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")(
  "lease directory finalization",
  () => {
    it.each(["accepted", "not_private", "access_denied"] as const)(
      "retains failed directory close after admission failure=%s",
      async (admission) => {
        const root = await createTestTempDirectory("rea-lease-close-");
        injection.directory = join(root, "leases");
        injection.admission = admission;
        const resources = new ArtifactResourceScope();
        const failure = await acquireLinuxHopperApplicationLease({
          runId: "directory-close-test",
          directory: injection.directory,
          resources,
        }).catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(HopperStartError);
        if (!(failure instanceof HopperStartError)) return;
        expect(failure.cleanupIncomplete).toBe(true);
        expect(resources.cleanupResources).toEqual([injection.directory]);
        expect(failure.cleanupResources).toEqual([injection.directory]);
        if (admission !== "accepted") {
          expect(failure.userMessage).toContain(
            admission === "not_private"
              ? "not a private directory"
              : "could not access",
          );
          expect(failure.cleanupPrimary).toBeInstanceOf(HopperStartError);
        } else
          expect(failure.userMessage).toContain("could not confirm closure");
        await resources.retryCleanup();
        expect(injection.closeCalls).toBe(2);
        expect(failure.cleanupIncomplete).toBe(false);
        expect(resources.hasPending).toBe(false);
        injection.directory = undefined;
        const retried = await acquireLinuxHopperApplicationLease({
          runId: "directory-close-retry",
          directory: join(root, "leases"),
          resources,
        });
        expect(retried.acquired).toBe(true);
        if (retried.acquired) await retried.lease.release();
      },
    );

    it("retries the directory owner through the actual Hopper launcher cleanup", async () => {
      const root = await createTestTempDirectory("rea-launch-lease-");
      injection.directory = join(root, "leases");
      injection.admission = "not_private";
      const launcher = new HopperApplicationLauncher(
        {
          environment: {},
          launcherPath: join(root, "hopper"),
          targetPath: join(root, "target"),
          targetKind: "database",
          loaderArgs: [],
          bridgeScriptPath: join(root, "bridge.py"),
          launchMode: "verified_linux_demo",
          demoHelperPath: join(root, "helper"),
        },
        {
          platform: "linux",
          acquireApplicationLease: (input) =>
            acquireLinuxHopperApplicationLease({
              ...input,
              directory: join(root, "leases"),
            }),
          retryPublisherCleanup: async () => undefined,
        },
      );
      const launched = await launcher.launch({
        directory: root,
        socketPath: join(root, "bridge.sock"),
        token: "fixture-token",
        runId: "launcher-lease-close-test",
      });
      expect(launched.ok).toBe(false);
      if (launched.ok) return;
      expect(launched.error.userMessage).toContain("not a private directory");
      expect(launched.error.cleanupIncomplete).toBe(true);
      expect(injection.closeCalls).toBe(1);
      expect((await launcher.cleanup()).ok).toBe(true);
      expect(injection.closeCalls).toBe(2);
      expect(launched.error.cleanupIncomplete).toBe(false);
      expect((await launcher.cleanup()).ok).toBe(true);
      expect(injection.closeCalls).toBe(2);
    });

    it("retains uncertainty when Node invalidates the directory handle before rejecting close", async () => {
      const root = await createTestTempDirectory("rea-lease-invalidated-");
      injection.directory = join(root, "leases");
      injection.invalidateOnClose = true;
      const resources = new ArtifactResourceScope();
      const failure = await acquireLinuxHopperApplicationLease({
        runId: "invalidated-close-test",
        directory: injection.directory,
        resources,
      }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(HopperStartError);
      await expect(resources.retryCleanup()).rejects.toThrow();
      expect(injection.closeCalls).toBe(1);
      expect(resources.hasPending).toBe(true);
      if (failure instanceof HopperStartError)
        expect(failure.cleanupIncomplete).toBe(true);
    });
  },
);
