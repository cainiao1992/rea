import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";

import { AdbProvider } from "../../../../src/adb/AdbProvider.js";
import { AnalysisError } from "../../../../src/domain/analysisErrorBase.js";
import { OwnedFileHandle } from "../../../../src/filesystem/OwnedFileHandle.js";
import {
  execFileBytes,
  execFileOutput,
} from "../../../../src/process/ExecFileOutput.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

vi.mock(
  "../../../../src/process/ExecFileOutput.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../src/process/ExecFileOutput.js")
    >()),
    execFileBytes: vi.fn(),
    execFileOutput: vi.fn(),
  }),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    mkdtemp: vi.fn(actual.mkdtemp),
    rm: vi.fn(actual.rm),
  };
});

afterEach(() => vi.restoreAllMocks());

const fixture = async () => {
  const root = await createTestTempDirectory("rea-adb-input-owner-");
  const binary = join(root, "adb");
  const source = join(root, "payload.bin");
  const bytes = Buffer.from("immutable payload");
  await writeFile(source, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let snapshotPath = "";
  let consumedBytes: Buffer | undefined;
  const output = (stdout: string) => ({
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
  });
  vi.mocked(execFileOutput).mockImplementation(async (_binary, args) => {
    if (args[0] === "version")
      return output(
        `Android Debug Bridge version 1.0.41\nVersion 34.0.5-stub\nInstalled as ${binary}\n`,
      );
    return output("");
  });
  vi.mocked(execFileBytes).mockImplementation(async (_binary, args) => {
    if (args[2] === "push") {
      snapshotPath = args[3]!;
      consumedBytes = await readFile(snapshotPath);
      if (consumedBytes.byteLength === 0)
        throw new Error("adb received an empty local snapshot");
    }
    if (args[3] === "sha256sum") {
      if (consumedBytes === undefined)
        throw new Error("checksum requested before a push was consumed");
      const consumedDigest = createHash("sha256")
        .update(consumedBytes)
        .digest("hex");
      return {
        stdout: Buffer.from(`${consumedDigest}  /data/local/tmp/payload.bin\n`),
        stderr: Buffer.alloc(0),
      };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  const provider = new AdbProvider({ environment: { REA_ADB_PATH: binary } });
  onTestFinished(() => provider.close());
  return {
    root,
    source,
    digest,
    snapshotPath: () => snapshotPath,
    provider,
    request: {
      operation: "push_adb_file" as const,
      input: {
        serial: "device",
        local_path: source,
        device_path: "/data/local/tmp/payload.bin",
        overwrite: true,
      },
    },
  };
};

test("retains failed snapshot cleanup ownership and retries it on close", async () => {
  const f = await fixture();
  const actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    if (basename(String(path)).startsWith("rea-adb-input-"))
      throw new Error("snapshot cleanup denied");
    return actualFs.rm(path, options);
  });

  const result = await f.provider.execute(f.request);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected snapshot cleanup failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toContain(dirname(f.snapshotPath()));
  const evidence = parseEvidence(result.error.partialObservation);
  expect(evidence).toMatchObject({
    provider: { id: "adb" },
    operation: "push_adb_file",
    confidence: "observed",
    parameters: { local_path: f.source },
    normalized_result: {
      local_path: f.source,
      bytes: 17,
      sha256: f.digest,
    },
  });
  await expect(readFile(f.snapshotPath())).resolves.toEqual(
    await readFile(f.source),
  );

  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    if (basename(String(path)).startsWith("rea-adb-input-"))
      throw new Error("snapshot cleanup retry denied");
    return actualFs.rm(path, options);
  });
  await expect(f.provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(result.error.cleanupIncomplete).toBe(true);

  await f.provider.close();
  expect(result.error.cleanupIncomplete).toBe(false);
  await expect(lstat(dirname(f.snapshotPath()))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("resolves a hash cleanup error only after the exact retained descriptor closes", async () => {
  const f = await fixture();
  const actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let stagedPath: string | undefined;
  vi.mocked(copyFile).mockImplementationOnce(
    async (source, destination, mode) => {
      stagedPath = String(destination);
      await actualFs.copyFile(source, destination, mode);
    },
  );
  const closeFailure = new Error("digest descriptor close denied");
  const owners: OwnedFileHandle[] = [];
  let denialsRemaining = 2;
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      owners.push(this);
      if (denialsRemaining > 0) {
        denialsRemaining -= 1;
        throw closeFailure;
      }
      return originalClose.call(this);
    });
  try {
    const result = await f.provider.execute(f.request);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected digest cleanup failure");
    const reported = result.error;
    const originalCause = reported.cause;
    expect(reported.cleanupIncomplete).toBe(true);
    expect(reported.cause).toBeInstanceOf(AggregateError);
    const hashFailure = (reported.cause as AggregateError).errors[0];
    if (!(hashFailure instanceof AnalysisError))
      throw new Error("Missing original typed hash failure");
    expect(hashFailure).toMatchObject({
      diagnostics: {
        primary_error: {
          details: {
            diagnostics: {
              completed_hash: { bytes: 17, sha256: f.digest },
            },
          },
        },
      },
    });
    expect(owners).toHaveLength(1);
    if (stagedPath === undefined) throw new Error("Missing staged input path");

    await expect(f.provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: [stagedPath, dirname(stagedPath)],
    });
    expect(reported.cleanupIncomplete).toBe(true);
    expect(reported.cause).toBe(originalCause);
    await expect(readFile(stagedPath)).resolves.toEqual(
      await readFile(f.source),
    );

    await f.provider.close();
    expect(owners).toHaveLength(3);
    expect(owners[0]).toBe(owners[1]);
    expect(owners[1]).toBe(owners[2]);
    expect(reported.cleanupIncomplete).toBe(false);
    expect(hashFailure.cleanupIncomplete).toBe(false);
    expect(reported.cause).toBe(originalCause);
    await expect(lstat(dirname(stagedPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    denialsRemaining = 0;
    close.mockRestore();
    await f.provider.close();
  }
});

test.each([false, true])(
  "preserves cancellation and push receipt during final snapshot cleanup (cleanup failure: %s)",
  async (failCleanup) => {
    const f = await fixture();
    const controller = new AbortController();
    const actualFs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      if (basename(String(path)).startsWith("rea-adb-input-")) {
        controller.abort();
        if (failCleanup) throw new Error("snapshot cleanup denied");
      }
      return actualFs.rm(path, options);
    });

    const result = await f.provider.execute(f.request, {
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    const originalCause = result.error.cause;
    const evidence = parseEvidence(result.error.partialObservation);
    expect(evidence).toMatchObject({
      provider: { id: "adb" },
      operation: "push_adb_file",
      confidence: "observed",
      parameters: { local_path: f.source },
      normalized_result: {
        local_path: f.source,
        bytes: 17,
        sha256: f.digest,
        device_path: "/data/local/tmp/payload.bin",
      },
    });
    if (failCleanup) {
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toContain(
        dirname(f.snapshotPath()),
      );
    } else expect(result.error.cleanupIncomplete).toBe(false);
    expect(await readFile(f.source)).toEqual(Buffer.from("immutable payload"));
    await f.provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cause).toBe(originalCause);
  },
);

test("cancels after the input snapshot copy and before contacting the device", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(copyFile).mockImplementationOnce(async (...args) => {
    await actualFs.copyFile(...args);
    controller.abort();
  });

  const result = await f.provider.execute(f.request, {
    signal: controller.signal,
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(execFileOutput).toHaveBeenCalledTimes(1);
  expect(await readFile(f.source, "utf8")).toBe("immutable payload");
  await f.provider.close();
});

test("reports input snapshot capacity failures before contacting the device", async () => {
  const f = await fixture();
  const capacityFailure = Object.assign(new Error("no space left"), {
    code: "ENOSPC",
  });
  vi.mocked(copyFile).mockRejectedValueOnce(capacityFailure);

  const result = await f.provider.execute(f.request);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected snapshot capacity failure");
  expect(result.error._tag).toBe("AnalysisOutputError");
  expect(result.error.cause).toBe(capacityFailure);
  expect(execFileOutput).toHaveBeenCalledTimes(1);
  await f.provider.close();
});
