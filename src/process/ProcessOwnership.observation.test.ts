import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  type ProcessOwnershipHost,
} from "./ProcessOwnership.js";
import {
  observeOwnedProcessGroup,
  observeOwnedProcessLineage,
} from "./ProcessOwnershipObservation.js";
import { host, ownership } from "./ProcessOwnership.fixture.js";

const processes = [100, 101].map((pid) => ({
  pid,
  parentPid: pid === 100 ? 1 : 100,
  processGroupId: 100,
  state: "S",
  command: "fixture",
}));

describe("batched ownership observation", () => {
  it("observes group and lineage with one batch each and falls back only for missing rows", async () => {
    const { adapter } = host({
      100: { REA_PROCESS_RUN_ID: ownership.runId },
      101: { REA_PROCESS_RUN_ID: ownership.runId },
    });
    const environment = vi.fn(adapter.environment);
    const runTokens = vi.fn<NonNullable<ProcessOwnershipHost["runTokens"]>>(
      () =>
        Promise.resolve(
          new Map([[100, { state: "readable", runId: ownership.runId }]]),
        ),
    );
    const observedHost = { ...adapter, environment, runTokens };
    await expect(
      observeOwnedProcessGroup(ownership, observedHost),
    ).resolves.toEqual({ state: "alive" });
    await expect(
      observeOwnedProcessLineage(ownership, observedHost),
    ).resolves.toMatchObject({
      status: "verified",
      lineage: {
        descendants: [{ pid: 101, parentPid: 100, processGroupId: 100 }],
      },
    });
    expect(runTokens.mock.calls).toEqual([[processes], [processes]]);
    expect(environment.mock.calls).toEqual([[101], [101]]);
  });

  it.each(["batch", "environment"] as const)(
    "preserves cancellation during %s reads, including successful completion races",
    async (boundary) => {
      const controller = new AbortController();
      const reason = new Error("cancelled ownership read");
      const listProcesses = vi.fn(() => Promise.resolve(processes));
      const environment = vi.fn<ProcessOwnershipHost["environment"]>(
        async (_pid, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort(reason);
          return { REA_PROCESS_RUN_ID: ownership.runId };
        },
      );
      const runTokens = vi.fn<NonNullable<ProcessOwnershipHost["runTokens"]>>(
        async (_processes, signal) => {
          expect(signal).toBe(controller.signal);
          if (boundary === "batch") controller.abort(reason);
          return new Map();
        },
      );
      await expect(
        observeOwnedProcessGroup(
          ownership,
          { listProcesses, environment, runTokens, signalGroup: vi.fn() },
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(listProcesses).toHaveBeenCalledTimes(1);
      expect(environment).toHaveBeenCalledTimes(boundary === "batch" ? 0 : 1);
    },
  );

  it.each([100, 101])(
    "rechecks unavailable batch rows for exited PID %i without overriding them through fallback",
    async (exitedPid) => {
      const listProcesses = vi
        .fn<ProcessOwnershipHost["listProcesses"]>()
        .mockResolvedValueOnce(processes)
        .mockResolvedValue(processes.filter(({ pid }) => pid !== exitedPid));
      const environment = vi.fn(() =>
        Promise.resolve({ REA_PROCESS_RUN_ID: ownership.runId }),
      );
      const observedHost: ProcessOwnershipHost = {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
        runTokens: () =>
          Promise.resolve(
            new Map(
              processes.map(({ pid }) => [
                pid,
                pid === exitedPid
                  ? { state: "unavailable" as const, reason: "process exited" }
                  : { state: "readable" as const, runId: ownership.runId },
              ]),
            ),
          ),
      };
      const result = await observeOwnedProcessLineage(ownership, observedHost);
      if (exitedPid === 100)
        expect(result).toMatchObject({
          status: "unavailable",
          reason: "owned launcher exited during lineage validation",
        });
      else
        expect(result).toMatchObject({
          status: "verified",
          lineage: { descendants: [] },
        });
      expect(environment).not.toHaveBeenCalled();
    },
  );
});

describe("token sweep batch failures", () => {
  it("cleans token-owned groups when a failed batch has readable fallback observations", async () => {
    const { adapter, signalGroup } = host({
      100: { REA_PROCESS_RUN_ID: ownership.runId },
      101: { REA_PROCESS_RUN_ID: ownership.runId },
    });
    await expect(
      cleanupOwnedProcessGroup(
        { ...ownership, sweepTokenOwnedProcesses: true, captureBaseline: [] },
        {
          ...adapter,
          runTokens: () =>
            Promise.reject(new Error("batch reader unavailable")),
        },
      ),
    ).resolves.toEqual({ cleaned: true, signaled: true });
    expect(signalGroup.mock.calls).toEqual([[100, "SIGKILL"]]);
  });

  it("uses fallback ownership when the initial batch fails and preserves both failures through retries", async () => {
    const signalGroup = vi.fn();
    const adapter: ProcessOwnershipHost = {
      listProcesses: () => Promise.resolve(processes),
      environment: (pid) =>
        pid === 100
          ? Promise.resolve({ REA_PROCESS_RUN_ID: ownership.runId })
          : Promise.reject(new Error("individual unreadable")),
      runTokens: () => Promise.reject(new Error("batch reader unavailable")),
      signalGroup,
    };
    const result = await cleanupOwnedProcessGroup(
      { ...ownership, sweepTokenOwnedProcesses: true, captureBaseline: [] },
      adapter,
    );
    expect(result).toMatchObject({
      cleaned: false,
      failures: expect.arrayContaining([
        expect.objectContaining({
          pid: 101,
          diagnostic:
            "individual unreadable; run-token batch failed: batch reader unavailable",
        }),
      ]),
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });
});
