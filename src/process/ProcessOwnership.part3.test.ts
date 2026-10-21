import { describe, expect, it, vi } from "vitest";
import type {
  ProcessOwnershipHost,
  ProcessTableEntry,
} from "./ProcessOwnership.js";
import { observeOwnedProcessLineage } from "./ProcessOwnershipObservation.js";
const ownership = {
  runId: "run-token",
  leaderPid: 100,
  processGroupId: 100,
};
describe("owned process-group cleanup discovery", () => {
  it("walks the PPID tree across process-group boundaries", async () => {
    const environment = vi.fn((pid: number) =>
      Promise.resolve({
        REA_PROCESS_RUN_ID: pid === 103 ? "unrelated-run" : "run-token",
      }),
    );
    const adapter: ProcessOwnershipHost = {
      listProcesses: () =>
        Promise.resolve([
          {
            pid: 103,
            parentPid: 999,
            processGroupId: 100,
            state: "S",
            command: "unrelated-same-group",
          },
          {
            pid: 102,
            parentPid: 101,
            processGroupId: 102,
            state: "S",
            command: "grandchild-session",
          },
          {
            pid: 100,
            parentPid: 1,
            processGroupId: 100,
            state: "S",
            command: "fixture",
          },
          {
            pid: 101,
            parentPid: 100,
            processGroupId: 101,
            state: "S",
            command: "child-group",
          },
        ]),
      environment,
      signalGroup: vi.fn(),
    };
    await expect(
      observeOwnedProcessLineage(ownership, adapter),
    ).resolves.toEqual({
      status: "verified",
      observedAt: expect.any(String),
      lineage: {
        runId: "run-token",
        launcherPid: 100,
        launcherParentPid: 1,
        processGroupId: 100,
        descendants: [
          { pid: 101, parentPid: 100, processGroupId: 101 },
          { pid: 102, parentPid: 101, processGroupId: 102 },
        ],
      },
    });
  });
  it("omits a descendant that exits while lineage is validated", async () => {
    const launcher = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "root",
    };
    const child = {
      pid: 101,
      parentPid: 100,
      processGroupId: 101,
      state: "S",
      command: "child",
    };
    const processes = [launcher, child];
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce(processes)
      .mockResolvedValueOnce([launcher]);
    const host: ProcessOwnershipHost = {
      listProcesses,
      environment: (pid) =>
        pid === 101
          ? Promise.reject(new Error("process exited during environment read"))
          : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
      signalGroup: vi.fn(),
    };

    await expect(observeOwnedProcessLineage(ownership, host)).resolves.toEqual({
      status: "verified",
      observedAt: expect.any(String),
      lineage: {
        runId: "run-token",
        launcherPid: 100,
        launcherParentPid: 1,
        processGroupId: 100,
        descendants: [],
      },
    });
  });
});

describe("identityless lineage refresh keeps replacement rows", () => {
  it("does not publish an empty lineage when exit refresh reveals a token-owned replacement", async () => {
    const launcher = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "root",
    };
    const child = {
      pid: 101,
      parentPid: 100,
      processGroupId: 100,
      state: "S",
      command: "child",
    };
    const replacement = {
      pid: 102,
      parentPid: 1,
      processGroupId: 102,
      state: "S",
      command: "reparented-grandchild",
    };
    const environment = vi.fn((pid: number) => {
      if (pid === 101)
        return Promise.reject(
          new Error("process exited during environment read"),
        );
      return Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" });
    });
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([launcher, child])
      .mockResolvedValue([launcher, replacement]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason:
        "process lineage refresh contained owned PID(s) outside the observed descendants: 102",
    });
    expect(environment).toHaveBeenCalledWith(102);
  });

  it("publishes a descendant that appears in the exit refresh and still belongs to the launcher", async () => {
    const launcher = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "root",
    };
    const child = {
      pid: 101,
      parentPid: 100,
      processGroupId: 100,
      state: "S",
      command: "child",
    };
    const grandchild = {
      pid: 102,
      parentPid: 100,
      processGroupId: 102,
      state: "S",
      command: "grandchild",
    };
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([launcher, child])
      .mockResolvedValue([launcher, grandchild]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment: (pid) =>
          pid === 101
            ? Promise.reject(
                new Error("process exited during environment read"),
              )
            : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "verified",
      lineage: {
        descendants: [{ pid: 102, parentPid: 100, processGroupId: 102 }],
      },
    });
  });
});

describe("identityless lineage refresh ignores the prior process table", () => {
  const row = (
    pid: number,
    parentPid: number,
    processGroupId = pid,
  ): ProcessTableEntry => ({
    pid,
    parentPid,
    processGroupId,
    state: "S",
    command: `pid-${String(pid)}`,
  });

  it("does not token-read a pre-existing row when a descendant exits", async () => {
    const environment = vi.fn((pid: number) =>
      pid === 101
        ? Promise.reject(new Error("process exited during environment read"))
        : pid === 50
          ? Promise.reject(new Error("unreadable pre-existing process"))
          : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
    );
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([row(100, 1, 100), row(101, 100, 100), row(50, 1)])
      .mockResolvedValue([row(100, 1, 100), row(50, 1)]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "verified",
      lineage: { descendants: [] },
    });
    expect(environment.mock.calls.map(([pid]) => pid)).not.toContain(50);
  });

  it("re-reads a refresh row after it moves under the launcher", async () => {
    let replacementReads = 0;
    const environment = vi.fn((pid: number) => {
      if (pid === 101 || pid === 103)
        return Promise.reject(
          new Error("process exited during environment read"),
        );
      if (pid !== 102)
        return Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" });
      replacementReads += 1;
      return Promise.resolve(
        replacementReads === 1 ? {} : { REA_PROCESS_RUN_ID: "run-token" },
      );
    });
    const outside = row(102, 1, 102);
    const joined = row(102, 100, 102);
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([row(100, 1, 100), row(101, 100), row(103, 100)])
      .mockResolvedValueOnce([row(100, 1, 100), row(103, 100), outside])
      .mockResolvedValue([row(100, 1, 100), joined]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "verified",
      lineage: {
        descendants: [{ pid: 102, parentPid: 100, processGroupId: 102 }],
      },
    });
    expect(replacementReads).toBe(2);
  });
});

describe("identityless lineage refresh follows tree membership", () => {
  const row = (
    pid: number,
    parentPid: number,
    processGroupId = pid,
  ): ProcessTableEntry => ({
    pid,
    parentPid,
    processGroupId,
    state: "S",
    command: `pid-${String(pid)}`,
  });

  it("token-checks an initial outsider after it joins the launcher", async () => {
    const environment = vi.fn((pid: number) =>
      pid === 101
        ? Promise.reject(new Error("process exited during environment read"))
        : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
    );
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([row(100, 1, 100), row(101, 100), row(102, 1)])
      .mockResolvedValue([row(100, 1, 100), row(102, 100)]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "verified",
      lineage: {
        descendants: [{ pid: 102, parentPid: 100, processGroupId: 102 }],
      },
    });
    expect(environment).toHaveBeenCalledWith(102);
  });

  it("rejects a cached foreign row after an ancestor joins the launcher", async () => {
    let outsiderReads = 0;
    const environment = vi.fn((pid: number) => {
      if (pid === 101 || pid === 103)
        return Promise.reject(
          new Error("process exited during environment read"),
        );
      if (pid !== 102)
        return Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" });
      outsiderReads += 1;
      return Promise.resolve({});
    });
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([
        row(100, 1, 100),
        row(101, 100),
        row(103, 100),
        row(50, 1),
      ])
      .mockResolvedValueOnce([
        row(100, 1, 100),
        row(103, 100),
        row(50, 1),
        row(102, 50),
      ])
      .mockResolvedValue([row(100, 1, 100), row(50, 100), row(102, 50)]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "process lineage contains an unowned or PID-reused process",
    });
    expect(outsiderReads).toBe(2);
    expect(environment.mock.calls.filter(([pid]) => pid === 50)).toHaveLength(
      1,
    );
  });

  it("re-reads a cached descendant when its relation is unchanged", async () => {
    let replacementReads = 0;
    const environment = vi.fn((pid: number) => {
      if (pid === 101 || pid === 103)
        return Promise.reject(
          new Error("process exited during environment read"),
        );
      if (pid !== 102)
        return Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" });
      replacementReads += 1;
      return Promise.resolve(
        replacementReads === 1 ? { REA_PROCESS_RUN_ID: "run-token" } : {},
      );
    });
    const descendant = row(102, 100, 102);
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([row(100, 1, 100), row(101, 100), row(103, 100)])
      .mockResolvedValueOnce([row(100, 1, 100), row(103, 100), descendant])
      .mockResolvedValue([row(100, 1, 100), descendant]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "process lineage contains an unowned or PID-reused process",
    });
    expect(replacementReads).toBe(2);
  });
});

describe("identityless lineage refresh drops exited descendants", () => {
  const row = (
    pid: number,
    parentPid: number,
    processGroupId = pid,
  ): ProcessTableEntry => ({
    pid,
    parentPid,
    processGroupId,
    state: "S",
    command: `pid-${String(pid)}`,
  });

  it("omits a validated descendant that is gone from the latest refresh", async () => {
    const environment = vi.fn((pid: number) =>
      pid === 101 || pid === 103
        ? Promise.reject(new Error("process exited during environment read"))
        : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
    );
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([
        row(100, 1, 100),
        row(102, 100),
        row(101, 100),
        row(103, 100),
      ])
      .mockResolvedValueOnce([row(100, 1, 100), row(102, 100), row(103, 100)])
      .mockResolvedValue([row(100, 1, 100)]);
    const result = await observeOwnedProcessLineage(ownership, {
      listProcesses,
      environment,
      signalGroup: vi.fn(),
    });
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.lineage.descendants).toEqual([]);
  });
});

describe("identityless lineage refresh rechecks the launcher relation", () => {
  const row = (
    pid: number,
    parentPid: number,
    processGroupId = pid,
    command = `pid-${String(pid)}`,
  ): ProcessTableEntry => ({
    pid,
    parentPid,
    processGroupId,
    state: "S",
    command,
  });

  it("rejects a same-token launcher whose process group changed", async () => {
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([
        row(100, 1, 100, "root"),
        row(102, 100),
        row(101, 100),
      ])
      .mockResolvedValue([row(100, 1, 999, "root"), row(102, 100)]);
    await expect(
      observeOwnedProcessLineage(
        { ...ownership, expectedCommand: "root" },
        {
          listProcesses,
          environment: (pid) =>
            pid === 101
              ? Promise.reject(
                  new Error("process exited during environment read"),
                )
              : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
          signalGroup: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "owned launcher process-group identity did not match",
    });
  });

  it("rejects a same-token launcher whose command changed", async () => {
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([
        row(100, 1, 100, "root"),
        row(102, 100),
        row(101, 100),
      ])
      .mockResolvedValue([row(100, 1, 100, "replacement"), row(102, 100)]);
    await expect(
      observeOwnedProcessLineage(
        { ...ownership, expectedCommand: "root" },
        {
          listProcesses,
          environment: (pid) =>
            pid === 101
              ? Promise.reject(
                  new Error("process exited during environment read"),
                )
              : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
          signalGroup: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason:
        "owned launcher command identity did not match (observed=replacement; expected=root)",
    });
  });

  it("rejects a same-token launcher whose parent changed", async () => {
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([
        row(100, 1, 100, "root"),
        row(102, 100),
        row(101, 100),
      ])
      .mockResolvedValue([row(100, 7, 100, "root"), row(102, 100)]);
    await expect(
      observeOwnedProcessLineage(
        { ...ownership, expectedParentPid: 1, expectedCommand: "root" },
        {
          listProcesses,
          environment: (pid) =>
            pid === 101
              ? Promise.reject(
                  new Error("process exited during environment read"),
                )
              : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
          signalGroup: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "owned launcher parent identity did not match",
    });
  });
});

describe("identityless lineage refresh rechecks the launcher", () => {
  const row = (
    pid: number,
    parentPid: number,
    processGroupId = pid,
  ): ProcessTableEntry => ({
    pid,
    parentPid,
    processGroupId,
    state: "S",
    command: `pid-${String(pid)}`,
  });

  it("does not publish lineage when the launcher PID is gone on a later refresh", async () => {
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([row(100, 1, 100), row(102, 100), row(101, 100)])
      .mockResolvedValue([row(102, 100)]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment: (pid) =>
          pid === 101
            ? Promise.reject(
                new Error("process exited during environment read"),
              )
            : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "owned launcher exited during lineage validation",
    });
  });

  it("rejects a refresh whose launcher PID is no longer owned", async () => {
    let launcherReads = 0;
    const environment = vi.fn((pid: number) => {
      if (pid === 101)
        return Promise.reject(
          new Error("process exited during environment read"),
        );
      if (pid !== 100)
        return Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" });
      launcherReads += 1;
      return Promise.resolve(
        launcherReads === 1 ? { REA_PROCESS_RUN_ID: "run-token" } : {},
      );
    });
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([row(100, 1, 100), row(102, 100), row(101, 100)])
      .mockResolvedValue([row(100, 1, 100), row(102, 100)]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "process lineage contains an unowned or PID-reused process",
    });
    expect(launcherReads).toBe(2);
  });
});

describe("identityless lineage refresh rechecks an initial descendant", () => {
  const row = (
    pid: number,
    parentPid: number,
    processGroupId = pid,
  ): ProcessTableEntry => ({
    pid,
    parentPid,
    processGroupId,
    state: "S",
    command: `pid-${String(pid)}`,
  });

  it("rejects a reused PID after an earlier descendant token matched", async () => {
    let reads = 0;
    const environment = vi.fn((pid: number) => {
      if (pid === 101)
        return Promise.reject(
          new Error("process exited during environment read"),
        );
      if (pid !== 102)
        return Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" });
      reads += 1;
      return Promise.resolve(
        reads === 1 ? { REA_PROCESS_RUN_ID: "run-token" } : {},
      );
    });
    const descendant = row(102, 100, 102);
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([row(100, 1, 100), descendant, row(101, 100)])
      .mockResolvedValue([row(100, 1, 100), descendant]);
    await expect(
      observeOwnedProcessLineage(ownership, {
        listProcesses,
        environment,
        signalGroup: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "process lineage contains an unowned or PID-reused process",
    });
    expect(reads).toBe(2);
  });
});

describe("identityless lineage refresh publishes one row per PID", () => {
  const row = (
    pid: number,
    parentPid: number,
    processGroupId = pid,
  ): ProcessTableEntry => ({
    pid,
    parentPid,
    processGroupId,
    state: "S",
    command: `pid-${String(pid)}`,
  });

  it("keeps a single row when a descendant returns to its original group", async () => {
    const environment = vi.fn((pid: number) =>
      pid === 101 || pid === 104
        ? Promise.reject(new Error("process exited during environment read"))
        : Promise.resolve({ REA_PROCESS_RUN_ID: "run-token" }),
    );
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([
        row(100, 1, 100),
        row(101, 100),
        row(102, 100, 100),
        row(104, 100),
      ])
      .mockResolvedValueOnce([
        row(100, 1, 100),
        row(102, 100, 102),
        row(104, 100),
      ])
      .mockResolvedValue([row(100, 1, 100), row(102, 100, 100)]);
    const result = await observeOwnedProcessLineage(ownership, {
      listProcesses,
      environment,
      signalGroup: vi.fn(),
    });
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.lineage.descendants).toEqual([
      { pid: 102, parentPid: 100, processGroupId: 100 },
    ]);
  });
});

describe("owned process-group cleanup discovery", () => {
  it("does not publish lineage when the launcher exits during validation", async () => {
    const launcher = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "root",
    };
    const listProcesses = vi
      .fn<ProcessOwnershipHost["listProcesses"]>()
      .mockResolvedValueOnce([launcher])
      .mockResolvedValueOnce([]);
    const host: ProcessOwnershipHost = {
      listProcesses,
      environment: () => Promise.reject(new Error("launcher exited")),
      signalGroup: vi.fn(),
    };

    await expect(
      observeOwnedProcessLineage(ownership, host),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "owned launcher exited during lineage validation",
    });
  });
});
