import { expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: filesystem.readFile };
});

import { createSystemProcessOwnershipHost } from "./ProcessOwnershipObservation.js";
import type { ProcessTableEntry } from "./ProcessOwnership.js";

const entry: ProcessTableEntry = {
  pid: 42,
  parentPid: 1,
  processGroupId: 42,
  state: "S",
  command: "fixture",
};

const filesystemError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

it("reports absence only when /proc lookup and signal-zero both report ESRCH", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const signalProbe = vi.spyOn(process, "kill").mockImplementation(() => {
    throw filesystemError("ESRCH");
  });
  try {
    for (const code of ["ENOENT", "ESRCH"]) {
      filesystem.readFile.mockRejectedValueOnce(filesystemError(code));
      await expect(host.processIdentities?.([entry])).resolves.toEqual(
        new Map([
          [
            42,
            {
              state: "absent",
              reason: "not-found-in-caller-pid-namespace",
            },
          ],
        ]),
      );
    }
    expect(signalProbe).toHaveBeenCalledTimes(2);
    expect(signalProbe).toHaveBeenNthCalledWith(1, 42, 0);
  } finally {
    signalProbe.mockRestore();
  }
});

it("keeps hidden or permission-denied live PIDs unavailable", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const signalProbe = vi.spyOn(process, "kill");
  try {
    filesystem.readFile.mockRejectedValueOnce(filesystemError("ENOENT"));
    signalProbe.mockReturnValueOnce(true);
    await expect(host.processIdentities?.([entry])).resolves.toEqual(
      new Map([
        [
          42,
          {
            state: "unavailable",
            reason: "proc_stat_missing_but_process_signal_probe_succeeded",
          },
        ],
      ]),
    );

    filesystem.readFile.mockRejectedValueOnce(filesystemError("ENOENT"));
    signalProbe.mockImplementationOnce(() => {
      throw filesystemError("EPERM");
    });
    const denied = await host.processIdentities?.([entry]);
    const deniedIdentity = denied?.get(42);
    expect(deniedIdentity).toMatchObject({ state: "unavailable" });
    expect(
      deniedIdentity?.state === "unavailable" ? deniedIdentity.reason : "",
    ).toContain("EPERM");
  } finally {
    signalProbe.mockRestore();
  }
});

it("keeps permission, parser, and unexpected failures unavailable", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const signalProbe = vi.spyOn(process, "kill");
  try {
    for (const code of ["EACCES", "EPERM", "EIO"]) {
      filesystem.readFile.mockRejectedValueOnce(filesystemError(code));
      const result = await host.processIdentities?.([entry]);
      expect(result?.get(42)?.state).toBe("unavailable");
    }

    filesystem.readFile.mockResolvedValueOnce("42 (fixture) S malformed");
    await expect(host.processIdentities?.([entry])).resolves.toEqual(
      new Map([[42, { state: "unavailable", reason: "malformed_proc_stat" }]]),
    );
    expect(signalProbe).not.toHaveBeenCalled();
  } finally {
    signalProbe.mockRestore();
  }
});

it("rejects invalid PIDs before procfs lookup or signal probing", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const signalProbe = vi.spyOn(process, "kill");
  filesystem.readFile.mockClear();
  try {
    await expect(
      host.processIdentities?.([{ ...entry, pid: 0 }]),
    ).resolves.toEqual(
      new Map([[0, { state: "unavailable", reason: "invalid_process_id" }]]),
    );
    expect(filesystem.readFile).not.toHaveBeenCalled();
    expect(signalProbe).not.toHaveBeenCalled();
  } finally {
    signalProbe.mockRestore();
  }
});

it("preserves cancellation before and after the signal-zero probe", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  filesystem.readFile.mockRejectedValueOnce(
    Object.assign(new Error("aborted"), { name: "AbortError" }),
  );
  await expect(
    host.processIdentities?.([entry], controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });

  const afterProbe = new AbortController();
  const probeAbort = vi.spyOn(process, "kill").mockImplementation(() => {
    afterProbe.abort(reason);
    throw filesystemError("ESRCH");
  });
  try {
    filesystem.readFile.mockRejectedValueOnce(filesystemError("ENOENT"));
    await expect(
      host.processIdentities?.([entry], afterProbe.signal),
    ).rejects.toBe(reason);
  } finally {
    probeAbort.mockRestore();
  }
});
