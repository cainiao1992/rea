import { countDecodedFiles } from "./ApktoolDecodedInventory.js";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import {
  artifactFilePrimaryFailure,
  ArtifactFileCleanupFailure,
  ArtifactFileCancelled,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { ApktoolCommandCleanup } from "./ApktoolCommandCleanup.js";
import { ApktoolWorkspace } from "./ApktoolWorkspace.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(() => {
  vi.mocked(fs.open).mockImplementation(actual.open);
});

it.each(["source", "snapshot", "output"] as const)(
  "retains the exact %s descriptor after a denied close and fences root removal",
  async (kind) => {
    const root = await PrivateRuntimeRoot.create({
      prefix: "rea-apktool-owned-test-",
    });
    const commands = new ApktoolCommandCleanup();
    const workspace = new ApktoolWorkspace(root, commands);
    const input = join(root.path, "source.apk");
    const output = join(root.path, "output.xml");
    await fs.writeFile(input, "small-authored-apk");
    await fs.writeFile(output, "<resources/>");
    const selected =
      kind === "source"
        ? input
        : kind === "snapshot"
          ? join(root.path, "input.apk")
          : output;
    let denied = true;
    const closes = vi.fn();
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (String(path) === selected) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          closes();
          if (denied) throw new Error("authored close denial");
          await close();
        };
      }
      return handle;
    });
    try {
      const failure = await (
        kind === "output"
          ? workspace.readText(output, 100)
          : workspace.snapshotInput(input, "decode_android_resources")
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
      if (!(failure instanceof ArtifactFileCleanupFailure))
        throw new Error("Expected owned descriptor failure");
      expect(failure.cleanupLease.released).toBe(false);
      await expect(workspace.close()).rejects.toBeInstanceOf(
        ArtifactReaderFailure,
      );
      await expect(fs.stat(root.path)).resolves.toBeDefined();
      denied = false;
      await workspace.close();
      expect(failure.cleanupLease.released).toBe(true);
      const count = closes.mock.calls.length;
      await workspace.close();
      expect(closes).toHaveBeenCalledTimes(count);
      await expect(fs.stat(root.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      denied = false;
      await workspace.close();
      await commands.close();
    }
  },
);

it("retains a physical decode-output failure when cancellation arrives during descriptor close", async () => {
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-apktool-owned-test-",
  });
  const commands = new ApktoolCommandCleanup();
  const workspace = new ApktoolWorkspace(root, commands);
  const output = join(root.path, "invalid.xml");
  const controller = new AbortController();
  await fs.writeFile(output, Buffer.from([0xff]));
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      controller.abort({ caller: "after malformed bytes" });
      await close();
    };
    return handle;
  });
  try {
    await expect(
      workspace.readText(output, 100, controller.signal),
    ).rejects.toMatchObject({ _tag: "AnalysisProtocolError" });
  } finally {
    await workspace.close();
    await commands.close();
  }
});

it("records cancellation observed during a successful output descriptor close", async () => {
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-apktool-owned-test-",
  });
  const commands = new ApktoolCommandCleanup();
  const workspace = new ApktoolWorkspace(root, commands);
  const output = join(root.path, "output.xml");
  const controller = new AbortController();
  const reason = { caller: "during descriptor close" };
  await fs.writeFile(output, "<resources/>");
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      controller.abort(reason);
      await close();
    };
    return handle;
  });
  try {
    const failure = await workspace
      .readText(output, 100, controller.signal)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCancelled);
    if (!(failure instanceof ArtifactFileCancelled))
      throw new Error("Expected close cancellation");
    expect(failure.fileCancellation.reason).toBe(reason);
    expect(failure.fileCancellation.outcome).toEqual({
      kind: "completed",
      value: { text: "<resources/>", truncated: false },
    });
  } finally {
    await workspace.close();
    await commands.close();
  }
});

it.skipIf(process.platform === "win32")(
  "rejects a decoded FIFO without waiting for a writer",
  async () => {
    const root = await PrivateRuntimeRoot.create({
      prefix: "rea-apktool-owned-test-",
    });
    const commands = new ApktoolCommandCleanup();
    const workspace = new ApktoolWorkspace(root, commands);
    const fifo = join(root.path, "strings.xml");
    try {
      await promisify(execFile)("mkfifo", [fifo]);
      await expect(workspace.readText(fifo, 100)).rejects.toMatchObject({
        code: "ENOTFILE",
      });
    } finally {
      await workspace.close();
      await commands.close();
    }
  },
);

it.each([false, true])(
  "keeps malformed UTF-8 primary when final stat observes cancellation (close denied=%s)",
  async (deniedInitially) => {
    const root = await PrivateRuntimeRoot.create({
      prefix: "rea-apktool-owned-test-",
    });
    const commands = new ApktoolCommandCleanup();
    const workspace = new ApktoolWorkspace(root, commands);
    const path = join(root.path, "malformed.xml");
    const controller = new AbortController();
    let denied = deniedInitially;
    await fs.writeFile(path, Buffer.from([0xff]));
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      const handle = await actual.open(name, flags, mode);
      const stat = handle.stat.bind(handle);
      let calls = 0;
      handle.stat = ((...args: Parameters<typeof handle.stat>) =>
        stat(...args).then((value) => {
          if (++calls === 3)
            controller.abort({ caller: "after bytes before interpretation" });
          return value;
        })) as typeof handle.stat;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (denied) throw new Error("authored denial");
        await close();
      };
      return handle;
    });
    try {
      const failure = await workspace
        .readText(path, 100, controller.signal)
        .catch((cause: unknown) => cause);
      expect(controller.signal.aborted).toBe(true);
      expect(artifactFilePrimaryFailure(failure)).toMatchObject({
        _tag: "AnalysisProtocolError",
      });
      if (denied)
        await expect(workspace.close()).rejects.toBeInstanceOf(
          ArtifactReaderFailure,
        );
      denied = false;
      await workspace.close();
    } finally {
      denied = false;
      await workspace.close();
      await commands.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "counts omitted special entries toward the decoded inventory budget",
  async () => {
    const root = await PrivateRuntimeRoot.create({
      prefix: "rea-apktool-owned-test-",
    });
    const commands = new ApktoolCommandCleanup();
    const workspace = new ApktoolWorkspace(root, commands);
    try {
      await fs.writeFile(join(root.path, "one.xml"), "one");
      await fs.writeFile(join(root.path, "two.xml"), "two");
      for (let index = 0; index < 4; index++)
        await promisify(execFile)("mkfifo", [
          join(root.path, `special-${index}`),
        ]);
      const result = await countDecodedFiles(
        workspace,
        root.path,
        undefined,
        3,
      );
      expect(result.capped).toBe(true);
      expect(result.count).toBeLessThanOrEqual(2);
      const complete = await countDecodedFiles(
        workspace,
        root.path,
        undefined,
        6,
      );
      expect(complete).toEqual({ count: 2, capped: false, locales: [] });
    } finally {
      await workspace.close();
      await commands.close();
    }
  },
);
