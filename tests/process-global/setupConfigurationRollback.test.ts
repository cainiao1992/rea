import { open, readFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, expect, it, onTestFinished, vi } from "vitest";

const state = vi.hoisted(() => ({
  readbackFailed: false,
  failReadback: true,
  rejectPublicationClose: false,
  publicationCloseFailure: undefined as unknown,
  publicationHandles: [] as FileHandle[],
  afterPublication: undefined as ((path: string) => Promise<void>) | undefined,
  rejectRestore: false,
  removeCopiedRecovery: false,
  initialCleanupFailure: undefined as unknown,
  readbackCleanupFailure: undefined as unknown,
}));

afterEach(() => {
  state.readbackFailed = false;
  state.failReadback = true;
  state.rejectPublicationClose = false;
  state.publicationCloseFailure = undefined;
  state.publicationHandles = [];
  state.afterPublication = undefined;
  state.rejectRestore = false;
  state.removeCopiedRecovery = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...arguments_: Parameters<typeof original.open>) => {
      const handle = await original.open(...arguments_);
      if (typeof arguments_[1] === "number" && (arguments_[1] & 3) === 2) {
        state.publicationHandles.push(handle);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          if (state.rejectPublicationClose)
            throw (
              state.publicationCloseFailure ??
              new Error("injected publication close failure")
            );
          await close();
        };
      }
      return handle;
    },
    writeFile: (
      ...arguments_: Parameters<typeof original.writeFile>
    ): ReturnType<typeof original.writeFile> => {
      if (state.rejectRestore && state.readbackFailed)
        return Promise.reject(new Error("injected restore write failure"));
      return original.writeFile(...arguments_);
    },
    copyFile: async (
      ...arguments_: Parameters<typeof original.copyFile>
    ): Promise<void> => {
      await original.copyFile(...arguments_);
      const destination = arguments_[1];
      if (
        state.removeCopiedRecovery &&
        typeof destination === "string" &&
        destination.endsWith(".recovery")
      )
        await original.rm(destination);
    },
  };
});

vi.mock("write-file-atomic", async (importOriginal) => {
  const original = await importOriginal<{
    default: typeof import("write-file-atomic");
  }>();
  return {
    ...original,
    default: async (...arguments_: Parameters<typeof original.default>) => {
      if (state.initialCleanupFailure !== undefined)
        throw new Error("unexpected config write before initial read");
      const result = await original.default(...arguments_);
      state.readbackFailed = true;
      const publishedPath = arguments_[0];
      if (
        state.afterPublication !== undefined &&
        typeof publishedPath === "string"
      )
        await state.afterPublication(publishedPath);
      return result;
    },
  };
});

vi.mock("../../src/application/RegularFileRead.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/application/RegularFileRead.js")
    >();
  return {
    ...original,
    readRegularFileText: (
      ...arguments_: Parameters<typeof original.readRegularFileText>
    ) =>
      state.initialCleanupFailure !== undefined
        ? Promise.reject(state.initialCleanupFailure)
        : state.readbackFailed && state.readbackCleanupFailure !== undefined
          ? Promise.reject(state.readbackCleanupFailure)
          : state.readbackFailed && state.failReadback
            ? Promise.reject(new Error("injected readback failure"))
            : original.readRegularFileText(...arguments_),
  };
});

import { configureClientConfiguration } from "../../src/application/SetupClientConfiguration.js";
import { RegularFileCleanupFailure } from "../../src/application/RegularFileRead.js";
import { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import type { DoctorHost } from "../../src/application/Doctor.js";
import { systemSetupHost } from "../../src/application/SetupHost.js";
import { ConfigurationError } from "../../src/domain/configurationErrors.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const ownReadHandle = async (path: string) => {
  const owner = new OwnedFileHandle(await open(path, "r"));
  onTestFinished(() => owner.close());
  return owner;
};

it("reports a failed config rollback and retains its backup path", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-rollback-");
  const path = join(root, "client.json");
  const original = '{"keep":true}\n';
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, original),
  );
  state.rejectRestore = true;

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );

  expect(result).toEqual({
    status: "failed",
    reason: "rollback",
    backupPath: `${path}.rea.backup`,
    failure: {
      kind: "restore",
      path,
      detail: "injected restore write failure",
    },
  });
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    mcpServers: { rea: { command: "rea", args: ["mcp"] } },
  });
});

it("preserves the first backup and reports a verified backup of the current original", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-stale-backup-");
  const path = join(root, "client.json");
  const firstOriginal = '{"keep":"first"}\n';
  const currentOriginal = '{"keep":"current"}\n';
  await import("node:fs/promises").then(async ({ writeFile }) => {
    await writeFile(path, currentOriginal);
    await writeFile(`${path}.rea.backup`, firstOriginal);
  });
  state.rejectRestore = true;

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );
  state.rejectRestore = false;

  const recoveryPath = `${path}.rea.backup.${createHash("sha256")
    .update(currentOriginal, "utf8")
    .digest("hex")}.recovery`;
  expect(result).toMatchObject({
    status: "failed",
    reason: "rollback",
    backupPath: recoveryPath,
    failure: {
      kind: "restore",
      path,
      detail: "injected restore write failure",
    },
  });
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(firstOriginal);
  expect(await readFile(recoveryPath, "utf8")).toBe(currentOriginal);
});

it("does not write config when a recovery copy disappears before verification", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.removeCopiedRecovery = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-vanished-recovery-");
  const path = join(root, "client.json");
  const firstOriginal = '{"keep":"first"}\n';
  const currentOriginal = '{"keep":"current"}\n';
  await import("node:fs/promises").then(async ({ writeFile }) => {
    await writeFile(path, currentOriginal);
    await writeFile(`${path}.rea.backup`, firstOriginal);
  });
  state.removeCopiedRecovery = true;

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );
  state.removeCopiedRecovery = false;

  expect(result).toEqual({ status: "failed", reason: "backup" });
  expect(await readFile(path, "utf8")).toBe(currentOriginal);
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(firstOriginal);
});

it("does not roll back or remove config when its initial read cleanup fails", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-initial-cleanup-");
  const path = join(root, "client.json");
  const original = '{"keep":true}\n';
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, original),
  );
  const failure = new RegularFileCleanupFailure(
    path,
    await ownReadHandle(path),
    { kind: "completed", value: original },
    new Error("injected initial close failure"),
  );
  state.initialCleanupFailure = failure;

  await expect(
    configureClientConfiguration(
      { name: "cursor", configPath: path, format: "json" },
      {},
      ["rea", "mcp"],
    ),
  ).rejects.toBe(failure);
  expect(await readFile(path, "utf8")).toBe(original);
});

it("retains first-run configuration for manual recovery without deleting by pathname", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.initialCleanupFailure = undefined;
  state.readbackCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-first-run-rollback-");
  const path = join(root, "client.json");

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );

  expect(result).toMatchObject({
    status: "failed",
    reason: "rollback",
    failure: {
      kind: "restore",
      path,
      detail:
        "First-run configuration recovery requires manual removal; pathname deletion cannot prove ownership",
    },
  });
  expect(result).not.toHaveProperty("backupPath");
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    mcpServers: { rea: { command: "rea", args: ["mcp"] } },
  });
});

it("retains readback cleanup ownership when rollback also fails", async () => {
  state.readbackFailed = false;
  state.rejectRestore = false;
  state.initialCleanupFailure = undefined;
  const root = await createTestTempDirectory("rea-config-readback-cleanup-");
  const path = join(root, "client.json");
  const original = '{"keep":true}\n';
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, original),
  );
  const owner = await ownReadHandle(path);
  const cleanupFailure = new RegularFileCleanupFailure(
    path,
    owner,
    { kind: "completed", value: "" },
    new Error("injected readback close failure"),
  );
  state.readbackCleanupFailure = cleanupFailure;
  state.rejectRestore = true;

  const host = systemSetupHost(
    { platform: "linux", homeDirectory: root } as DoctorHost,
    { HOME: root },
  );
  let caught: unknown;
  try {
    await host.configureClient(
      { name: "cursor", configPath: path, format: "json" },
      {},
      ["rea", "mcp"],
    );
  } catch (cause: unknown) {
    caught = cause;
  } finally {
    await host.close?.();
  }

  if (!(caught instanceof ConfigurationError)) throw caught;
  expect(caught.message).toContain("injected restore write failure");
  expect(caught.message).toContain(`${path}.rea.backup`);
  const cleanupOwnerError = caught.cause;
  if (!(cleanupOwnerError instanceof RegularFileCleanupFailure))
    throw new Error("Configuration failure lost its read owner");
  expect(cleanupOwnerError).toMatchObject({
    path,
    outcome: { kind: "completed", value: "" },
    cleanupCause: expect.any(AggregateError),
  });
  expect(cleanupOwnerError.owner).toBe(owner);
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
});

it.each(["existing", "first-run"] as const)(
  "retains a replacement symlink and its target when %s readback fails",
  async (kind) => {
    const root = await createTestTempDirectory("rea-config-replaced-rollback-");
    const path = join(root, "client.json");
    const replacement = join(root, "replacement.json");
    const original = '{"keep":"original"}\n';
    const foreign = '{"keep":"replacement"}\n';
    const fs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    await fs.writeFile(replacement, foreign);
    if (kind === "existing") await fs.writeFile(path, original);
    state.afterPublication = async (publishedPath) => {
      await fs.unlink(publishedPath);
      await fs.symlink(replacement, publishedPath);
    };

    const result = await configureClientConfiguration(
      { name: "cursor", configPath: path, format: "json" },
      {},
      ["rea", "mcp"],
    );

    expect(await fs.readFile(replacement, "utf8")).toBe(foreign);
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
    expect(result).toMatchObject({ status: "failed", reason: "rollback" });
    if (kind === "existing")
      expect(await fs.readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  },
);

it("retains a replacement regular file when readback fails", async () => {
  const root = await createTestTempDirectory("rea-config-replaced-file-");
  const path = join(root, "client.json");
  const replacement = join(root, "replacement.json");
  const original = '{"keep":"original"}\n';
  const foreign = '{"keep":"replacement"}\n';
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  await fs.writeFile(path, original);
  await fs.writeFile(replacement, foreign);
  state.afterPublication = (publishedPath) =>
    fs.rename(replacement, publishedPath);

  const result = await configureClientConfiguration(
    { name: "cursor", configPath: path, format: "json" },
    {},
    ["rea", "mcp"],
  );

  expect(await fs.readFile(path, "utf8")).toBe(foreign);
  expect(result).toMatchObject({ status: "failed", reason: "rollback" });
  expect(await fs.readFile(`${path}.rea.backup`, "utf8")).toBe(original);
});

it("retains and retries both readback and publication descriptors after mixed close failures", async () => {
  const root = await createTestTempDirectory("rea-config-two-close-owners-");
  const path = join(root, "client.json");
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  await fs.writeFile(path, '{"keep":true}\n');
  const readOwner = await ownReadHandle(path);
  const closeRead = readOwner.handle.close.bind(readOwner.handle);
  let rejectReadClose = true;
  readOwner.handle.close = async () => {
    if (rejectReadClose) throw new Error("injected readback close failure");
    await closeRead();
  };
  state.readbackCleanupFailure = new RegularFileCleanupFailure(
    path,
    readOwner,
    { kind: "completed", value: "" },
    new Error("injected readback close failure"),
  );
  state.rejectPublicationClose = true;
  const host = systemSetupHost(
    { platform: "linux", homeDirectory: root } as DoctorHost,
    { HOME: root },
  );
  try {
    await expect(
      host.configureClient(
        { name: "cursor", configPath: path, format: "json" },
        {},
        ["rea", "mcp"],
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(state.publicationHandles).toHaveLength(1);
    expect(readOwner.handle.fd).toBeGreaterThanOrEqual(0);
    expect(state.publicationHandles[0]!.fd).toBeGreaterThanOrEqual(0);
    rejectReadClose = false;
    state.rejectPublicationClose = false;
    expect(await host.close?.()).toBeUndefined();
    expect(readOwner.handle.fd).toBe(-1);
    expect(state.publicationHandles[0]!.fd).toBe(-1);
  } finally {
    rejectReadClose = false;
    state.rejectPublicationClose = false;
    await host.close?.();
    await readOwner.close();
    for (const handle of state.publicationHandles)
      if (handle.fd >= 0) await handle.close();
  }
});

it("rejects a replaced publication even when the replacement passes registration readback", async () => {
  const root = await createTestTempDirectory("rea-config-valid-replacement-");
  const path = join(root, "client.json");
  const replacement = join(root, "replacement.json");
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const original = '{"keep":true}\n';
  await fs.writeFile(path, original);
  let foreign = "";
  state.failReadback = false;
  state.afterPublication = async (publishedPath) => {
    foreign = await fs.readFile(publishedPath, "utf8");
    await fs.writeFile(replacement, foreign);
    await fs.rename(replacement, publishedPath);
  };
  expect(
    await configureClientConfiguration(
      { name: "cursor", configPath: path, format: "json" },
      {},
      ["rea", "mcp"],
    ),
  ).toMatchObject({ status: "failed", reason: "rollback" });
  expect(await fs.readFile(path, "utf8")).toBe(foreign);
  expect(await fs.readFile(`${path}.rea.backup`, "utf8")).toBe(original);
});

it("retains concurrent edits to the published inode rather than overwriting them", async () => {
  const root = await createTestTempDirectory("rea-config-inode-edit-");
  const path = join(root, "client.json");
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const original = '{"keep":true}\n';
  const edited = '{"keep":"concurrent edit"}\n';
  await fs.writeFile(path, original);
  state.afterPublication = (publishedPath) =>
    fs.writeFile(publishedPath, edited);
  expect(
    await configureClientConfiguration(
      { name: "cursor", configPath: path, format: "json" },
      {},
      ["rea", "mcp"],
    ),
  ).toMatchObject({ status: "failed", reason: "rollback" });
  expect(await fs.readFile(path, "utf8")).toBe(edited);
  expect(await fs.readFile(`${path}.rea.backup`, "utf8")).toBe(original);
});

it("does not adopt a descriptor named by an opaque publication close rejection", async () => {
  const root = await createTestTempDirectory(
    "rea-config-close-cause-ownership-",
  );
  const path = join(root, "client.json");
  const unrelated = join(root, "unrelated.json");
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  await fs.writeFile(path, '{"keep":true}\n');
  await fs.writeFile(unrelated, "unrelated");
  const foreignOwner = await ownReadHandle(unrelated);
  state.failReadback = false;
  state.rejectPublicationClose = true;
  state.publicationCloseFailure = new RegularFileCleanupFailure(
    unrelated,
    foreignOwner,
    { kind: "completed", value: "unrelated" },
    new Error("opaque close rejection"),
  );
  const host = systemSetupHost(
    { platform: "linux", homeDirectory: root } as DoctorHost,
    { HOME: root },
  );
  try {
    await expect(
      host.configureClient(
        { name: "cursor", configPath: path, format: "json" },
        {},
        ["rea", "mcp"],
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
    state.rejectPublicationClose = false;
    expect(await host.close?.()).toBeUndefined();
    expect(state.publicationHandles[0]!.fd).toBe(-1);
    expect(foreignOwner.handle.fd).toBeGreaterThanOrEqual(0);
  } finally {
    state.rejectPublicationClose = false;
    await host.close?.();
    await foreignOwner.close();
    for (const handle of state.publicationHandles)
      if (handle.fd >= 0) await handle.close();
  }
});
