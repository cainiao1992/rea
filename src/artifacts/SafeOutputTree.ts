import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { streamChunkToBuffer } from "./StreamBytes.js";

import {
  ArtifactPathRegistry,
  destinationCaseCollisionMessage,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { removeOwnedTree } from "./SafeOutputTreeCleanup.js";
import {
  assertHandleIdentity,
  assertFilePathIdentity,
  assertPathIdentity,
  isAbsent,
  pathHasIdentity,
  readDirectoryIdentity,
  readFileIdentity,
  replacedDirectory,
  type DirectoryIdentity,
  type FileIdentity,
} from "./SafeOutputTreeIdentity.js";

/** One file durably written to an operation-owned output tree. */
export interface SafeOutputFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytesWritten: number;
}

/** Cleanup state established while rolling back an uncommitted tree. */
export type SafeOutputCleanup =
  | { readonly status: "not-required" }
  | { readonly status: "complete"; readonly residualPaths: readonly [] }
  | {
      readonly status: "incomplete";
      readonly residualPaths: readonly [string, ...string[]];
    };

/**
 * Materialize files in a tree created by this operation.
 *
 * Path identities are revalidated around operations, but Node has no portable
 * descriptor-relative traversal; a syscall-boundary pathname race remains.
 */
export class SafeOutputTree {
  readonly #registry = new ArtifactPathRegistry();
  readonly #outputRoot: string;
  readonly #rootIdentity: DirectoryIdentity;
  readonly #nestedDirectories = new Map<string, DirectoryIdentity>();
  readonly #ownedFiles = new Map<string, FileIdentity>();
  #published = false;
  #cleanup: SafeOutputCleanup = {
    status: "not-required",
  };

  private constructor(
    outputRoot: string,
    rootIdentity: DirectoryIdentity,
    private readonly platform: NodeJS.Platform,
  ) {
    this.#outputRoot = outputRoot;
    this.#rootIdentity = rootIdentity;
  }

  /**
   * Exclusively create the absent destination as this operation's owned tree.
   *
   * POSIX mode bits and directory `fchmod`/`fsync` have no Windows equivalent:
   * `mkdir` already applies the requested mode, so the redundant handle
   * `chmod` is skipped there to avoid an `EPERM` on the directory descriptor.
   */
  static async create(
    outputRoot: string,
    platform: NodeJS.Platform = process.platform,
  ): Promise<SafeOutputTree> {
    if (!isAbsolute(outputRoot))
      throw new ArtifactReaderFailure(
        "path",
        "Extraction output root must be absolute",
      );
    const requested = resolve(outputRoot);
    const name = basename(requested);
    if (name === "." || name === "..")
      throw new ArtifactReaderFailure("path", "Invalid extraction output root");
    const parent = await realpath(dirname(requested)).catch(
      (cause: unknown) => {
        throw new ArtifactReaderFailure(
          "unavailable",
          "Extraction output parent is unavailable",
          { cause },
        );
      },
    );
    const canonicalOutput = join(parent, name);
    await mkdir(canonicalOutput, { mode: 0o700 }).catch((cause: unknown) => {
      if (isAlreadyExists(cause))
        throw new ArtifactReaderFailure(
          "path",
          "Extraction output root already exists",
          { cause },
        );
      throw cause;
    });
    let rootIdentity: DirectoryIdentity | undefined;
    try {
      rootIdentity = await readDirectoryIdentity(canonicalOutput);
      if (platform !== "win32") {
        const stagingHandle = await open(
          canonicalOutput,
          constants.O_RDONLY | constants.O_DIRECTORY,
        );
        try {
          await assertHandleIdentity(
            stagingHandle,
            rootIdentity,
            canonicalOutput,
          );
          await stagingHandle.chmod(0o700);
        } finally {
          await stagingHandle.close();
        }
      }
      await assertPathIdentity(canonicalOutput, rootIdentity);
      return new SafeOutputTree(canonicalOutput, rootIdentity, platform);
    } catch (cause: unknown) {
      let removalFailure: unknown;
      let ownedRootAtPath = false;
      try {
        ownedRootAtPath =
          rootIdentity !== undefined &&
          (await pathHasIdentity(canonicalOutput, rootIdentity));
        if (ownedRootAtPath) await rmdir(canonicalOutput);
        else
          removalFailure = new Error(
            "Extraction output root identity changed during setup",
          );
      } catch (cleanupCause: unknown) {
        removalFailure = cleanupCause;
      }
      let absent = false;
      try {
        absent = ownedRootAtPath && (await isAbsent(canonicalOutput));
      } catch (cleanupCause: unknown) {
        removalFailure ??= cleanupCause;
      }
      if (!absent)
        throw ArtifactReaderFailure.withCleanup(cause, {
          reason:
            removalFailure instanceof Error
              ? removalFailure.message
              : "Extraction output root ownership could not be verified after setup failure",
          resources: [canonicalOutput],
        });
      throw cause;
    }
  }

  get outputRoot(): string {
    return this.#outputRoot;
  }

  get cleanup(): SafeOutputCleanup {
    return structuredClone(this.#cleanup);
  }

  /** Stream one regular file with exact byte and digest verification. */
  async write(
    relativePath: string,
    source: Readable,
    expected: { readonly sha256: string; readonly bytes: number },
    signal?: AbortSignal,
  ): Promise<SafeOutputFile> {
    try {
      this.#assertWritable();
      if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0)
        throw new ArtifactReaderFailure(
          "format",
          `Invalid expected extraction size for ${relativePath}`,
        );
      const path = normalizeArtifactPath(relativePath);
      this.#registry.add(path, "file");
      const lineage = await this.#prepareParent(path);
      const parent = lineage.at(-1);
      if (parent === undefined) throw replacedDirectory(this.#outputRoot);
      const fileName = path.slice(path.lastIndexOf("/") + 1);
      const destination = join(parent.path, fileName);
      const handle = await open(
        destination,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      ).catch(async (cause: unknown) => {
        await throwIfDestinationCaseCollision(parent.path, path, cause);
        throw new ArtifactReaderFailure(
          "path",
          `Could not exclusively create extraction path: ${path}`,
          { cause },
        );
      });
      const fileIdentity = await readFileIdentity(handle, destination).catch(
        async (cause: unknown) => {
          await handle.close().catch(() => undefined);
          throw cause;
        },
      );
      this.#ownedFiles.set(destination, fileIdentity);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        await this.#assertLineage(lineage);
        for await (const raw of source) {
          abortIfNeeded(signal);
          const chunk = streamChunkToBuffer(raw);
          if (chunk.length > expected.bytes - bytes)
            throw new ArtifactReaderFailure(
              "integrity",
              `Extracted content exceeds the inventoried size: ${path}`,
            );
          bytes += chunk.length;
          hash.update(chunk);
          await writeAll(handle, chunk);
        }
        if (bytes !== expected.bytes)
          throw new ArtifactReaderFailure(
            "integrity",
            `Extracted content size disagrees with inventory: ${path}`,
          );
        const sha256 = hash.digest("hex");
        if (sha256 !== expected.sha256)
          throw new ArtifactReaderFailure(
            "integrity",
            `Extracted content disagrees with inventory: ${path}`,
          );
        await this.#assertLineage(lineage);
        await assertFilePathIdentity(destination, fileIdentity);
        await handle.sync();
        await handle.close();
        const readback = await hashFile(destination, bytes, signal);
        await this.#assertLineage(lineage);
        await assertFilePathIdentity(destination, fileIdentity);
        if (readback.sha256 !== sha256 || readback.bytes !== bytes)
          throw new ArtifactReaderFailure(
            "integrity",
            `Durable readback verification failed: ${path}`,
          );
        return { relativePath: path, sha256, bytesWritten: bytes };
      } catch (cause: unknown) {
        // best-effort cleanup: file-handle close must not mask the write failure.
        await handle.close().catch(() => undefined);
        throw cause;
      }
    } catch (cause: unknown) {
      try {
        source.destroy();
      } catch {
        // Preserve the write refusal or failure as the caller-visible error.
      }
      throw cause;
    }
  }

  /** Sync the owned output tree and prevent further writes through this instance. */
  async commit(): Promise<void> {
    this.#assertWritable();
    await this.#assertOwnedDirectories();
    // Windows has no directory fsync; file contents are already synced in write().
    if (this.platform === "win32") {
      this.#published = true;
      return;
    }
    const parent = await open(
      dirname(this.#outputRoot),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    let output: FileHandle | undefined;
    try {
      output = await open(
        this.#outputRoot,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      await assertHandleIdentity(output, this.#rootIdentity, this.#outputRoot);
      await output.sync();
      await parent.sync();
      this.#published = true;
    } catch (cause: unknown) {
      throw new ArtifactReaderFailure(
        "path",
        "Could not durably sync extraction output",
        { cause },
      );
    } finally {
      await Promise.allSettled([parent.close(), output?.close()]);
    }
  }

  /** Remove only this operation's unsealed tree and verify absence. */
  async rollback(): Promise<SafeOutputCleanup> {
    if (this.#published || this.#cleanup.status === "complete")
      return structuredClone(this.#cleanup);
    this.#cleanup = {
      status: "incomplete",
      residualPaths: [basename(this.#outputRoot)],
    };
    let removalFailure: unknown;
    try {
      await this.#assertOwnedDirectories();
      await removeOwnedTree({
        outputRoot: this.#outputRoot,
        rootIdentity: this.#rootIdentity,
        directories: this.#nestedDirectories,
        files: this.#ownedFiles,
      });
    } catch (cause: unknown) {
      removalFailure = cause;
    }
    const absent =
      removalFailure === undefined && (await isAbsent(this.#outputRoot));
    this.#cleanup = absent
      ? { status: "complete", residualPaths: [] }
      : {
          status: "incomplete",
          residualPaths: [basename(this.#outputRoot)],
        };
    if (!absent)
      throw new ArtifactReaderFailure(
        "integrity",
        `Extraction output cleanup could not be verified${removalFailure === undefined ? "" : `: ${removalFailure instanceof Error ? removalFailure.message : String(removalFailure)}`}`,
        {
          cause: removalFailure,
          cleanup: {
            reason:
              removalFailure instanceof Error
                ? removalFailure.message
                : "Extraction output root remains after rollback",
            resources: [this.#outputRoot],
          },
        },
      );
    return structuredClone(this.#cleanup);
  }

  async #prepareParent(
    relativePath: string,
  ): Promise<readonly DirectoryLineageEntry[]> {
    const parts = relativePath.split("/");
    if (parts.pop() === undefined)
      throw new ArtifactReaderFailure("path", "Invalid extraction path");
    let current = this.#outputRoot;
    let logicalParent = "";
    const lineage: DirectoryLineageEntry[] = [
      { path: this.#outputRoot, identity: this.#rootIdentity },
    ];
    if (parts.length === 0)
      await assertPathIdentity(this.#outputRoot, this.#rootIdentity);
    for (const part of parts) {
      const parent = lineage.at(-1);
      if (parent === undefined) throw replacedDirectory(this.#outputRoot);
      const logicalPath =
        logicalParent.length === 0 ? part : `${logicalParent}/${part}`;
      current = join(current, part);
      await assertPathIdentity(parent.path, parent.identity);
      let created = true;
      await mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
        if (!isAlreadyExists(cause)) throw cause;
        created = false;
      });
      if (!created) {
        await throwIfDestinationCaseCollision(parent.path, logicalPath);
        const identity = this.#nestedDirectories.get(current);
        if (identity === undefined) throw replacedDirectory(current);
        await assertPathIdentity(current, identity);
      } else {
        const identity = await readDirectoryIdentity(current);
        this.#nestedDirectories.set(current, identity);
      }
      await assertPathIdentity(parent.path, parent.identity);
      const identity = this.#nestedDirectories.get(current);
      if (identity === undefined) throw replacedDirectory(current);
      await assertPathIdentity(current, identity);
      lineage.push({ path: current, identity });
      logicalParent = logicalPath;
    }
    return lineage;
  }

  async #assertLineage(
    lineage: readonly DirectoryLineageEntry[],
  ): Promise<void> {
    for (const { path, identity } of lineage)
      await assertPathIdentity(path, identity);
  }

  async #assertOwnedDirectories(): Promise<void> {
    await assertPathIdentity(this.#outputRoot, this.#rootIdentity);
    for (const [path, identity] of this.#nestedDirectories)
      await assertPathIdentity(path, identity);
  }

  #assertWritable(): void {
    if (this.#published)
      throw new ArtifactReaderFailure(
        "integrity",
        "Extraction tree is already committed",
      );
    if (this.#cleanup.status !== "not-required")
      throw new ArtifactReaderFailure(
        "integrity",
        "Extraction tree cleanup has already started",
      );
  }
}

type DirectoryLineageEntry = {
  readonly path: string;
  readonly identity: DirectoryIdentity;
};

const hashFile = async (
  path: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const raw of handle.createReadStream({ autoClose: false })) {
      abortIfNeeded(signal);
      const chunk = streamChunkToBuffer(raw);
      bytes += chunk.length;
      if (bytes > maximum)
        throw new ArtifactReaderFailure(
          "integrity",
          "Readback exceeded the bytes written",
        );
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes };
};

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
): Promise<void> => {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    if (bytesWritten === 0)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Extraction output stopped accepting bytes",
      );
    offset += bytesWritten;
  }
};

const isAlreadyExists = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "EEXIST";

/** Fail when this directory already holds another spelling of the requested segment. */
const throwIfDestinationCaseCollision = async (
  parentDirectory: string,
  logicalPath: string,
  cause?: unknown,
): Promise<void> => {
  const names = await readdir(parentDirectory).catch(() => undefined);
  if (names === undefined) return;
  const message = destinationCaseCollisionMessage(logicalPath, names);
  if (message === undefined) return;
  throw new ArtifactReaderFailure(
    "path",
    message,
    cause === undefined ? undefined : { cause },
  );
};

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact extraction cancelled",
    );
};
