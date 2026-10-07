import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  dylibResolutionInputSchema,
  dylibResolutionResultSchema,
  traceDylibLoading,
  type DylibResolutionResult,
  type DylibTreeEntry,
  type DylibTreeView,
  type MachoImageFacts,
} from "../domain/dylibResolution.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { DirectoryArtifactReader } from "./DirectoryArtifactReader.js";
import { hasMachoMagic, readMachoImage } from "./MachoLoadCommandReader.js";

const HASH_CHUNK_BYTES = 1024 * 1024;

/** Lazily probed, symlink-preserving view of one analyzed directory. */
class FilesystemTreeView implements DylibTreeView {
  readonly #entries = new Map<string, Promise<DylibTreeEntry | undefined>>();
  readonly #images = new Map<string, Promise<MachoImageFacts>>();

  constructor(
    private readonly root: string,
    private readonly signal?: AbortSignal,
  ) {}

  entry(path: string): Promise<DylibTreeEntry | undefined> {
    const cached = this.#entries.get(path);
    if (cached !== undefined) return cached;
    const pending = this.#readEntry(path);
    this.#entries.set(path, pending);
    return pending;
  }

  image(path: string): Promise<MachoImageFacts> {
    const cached = this.#images.get(path);
    if (cached !== undefined) return cached;
    const pending = readImage(join(this.root, path), this.signal);
    this.#images.set(path, pending);
    return pending;
  }

  async #readEntry(path: string): Promise<DylibTreeEntry | undefined> {
    cancelled(this.signal);
    const absolute = join(this.root, path);
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink())
        return { kind: "symlink", target: await readlink(absolute) };
      if (metadata.isDirectory()) return { kind: "directory" };
      return metadata.isFile() ? { kind: "file" } : undefined;
    } catch (cause: unknown) {
      if (missing(cause)) return undefined;
      throw cause;
    }
  }
}

/** Resolve dyld load paths for the active Mach-O or every executable in its bundle. */
export const traceDylibResolution = async (options: {
  readonly rootPath: string;
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly enumerateRoots: boolean;
  readonly parameters: unknown;
  readonly signal?: AbortSignal;
}): Promise<DylibResolutionResult> => {
  const parsed = dylibResolutionInputSchema.safeParse(options.parameters);
  if (!parsed.success)
    throw new ArtifactReaderFailure(
      "path",
      "roots must be normalized paths relative to the analyzed root",
    );
  const root = await realpath(options.rootPath);
  const target = relative(root, await realpath(options.targetPath))
    .split(sep)
    .join("/");
  const view = new FilesystemTreeView(root, options.signal);
  try {
    const { roots, unclassified } =
      parsed.data.roots !== undefined
        ? { roots: parsed.data.roots, unclassified: [] }
        : options.enumerateRoots
          ? await executableRoots(root, view, options.signal)
          : { roots: [target], unclassified: [] };
    await requireMachoRoots(view, roots);
    const trace = await traceDylibLoading(view, {
      roots,
      unclassified,
      ...(parsed.data.architecture === undefined
        ? {}
        : { architecture: parsed.data.architecture }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const digests = new Map<string, string>();
    for (const { path } of trace.images)
      digests.set(path, await fileSha256(join(root, path), options.signal));
    const targetDigest =
      digests.get(target) ??
      (await fileSha256(join(root, target), options.signal));
    if (targetDigest !== options.targetSha256)
      throw new ArtifactReaderFailure(
        "integrity",
        `Active target digest changed: expected ${options.targetSha256}, observed ${targetDigest}`,
      );
    return dylibResolutionResultSchema.parse({
      ...trace,
      root_path: options.rootPath,
      target_sha256: options.targetSha256,
      images: trace.images.map((image) => ({
        ...image,
        sha256: digests.get(image.path),
      })),
    });
  } catch (cause: unknown) {
    if (options.signal?.aborted === true)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Dylib resolution was cancelled",
        { cause },
      );
    throw cause;
  }
};

/**
 * Every Mach-O in the bundle with an executable slice is its own process root.
 * Mach-O files that do not parse are returned separately: whether they are
 * executables is unknown, so they make coverage partial instead of vanishing.
 */
const executableRoots = async (
  root: string,
  view: FilesystemTreeView,
  signal?: AbortSignal,
): Promise<{ readonly roots: string[]; readonly unclassified: string[] }> => {
  const roots: string[] = [];
  const unclassified: string[] = [];
  for await (const entry of new DirectoryArtifactReader(root).entries(signal)) {
    if (
      entry.kind !== "file" ||
      !(await startsWithMachoMagic(entry.adapterKey))
    )
      continue;
    const facts = await view.image(entry.path);
    if (facts.status === "malformed" || facts.status === "unsupported")
      unclassified.push(entry.path);
    else if (
      facts.status === "parsed" &&
      facts.slices.some(({ file_type: type }) => type === "execute")
    )
      roots.push(entry.path);
  }
  return {
    roots: roots.sort(compare),
    unclassified: unclassified.sort(compare),
  };
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const requireMachoRoots = async (
  view: FilesystemTreeView,
  roots: readonly string[],
): Promise<void> => {
  for (const path of roots) {
    const entry = await view.entry(path);
    if (entry?.kind !== "file")
      throw new ArtifactReaderFailure(
        "path",
        `Root ${path} is not a regular file in the analyzed root`,
      );
    if ((await view.image(path)).status === "not-mach-o")
      throw new ArtifactReaderFailure(
        "format",
        `Root ${path} is not a Mach-O image`,
      );
  }
};

const startsWithMachoMagic = async (path: string): Promise<boolean> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = new Uint8Array(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return hasMachoMagic(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
};

const readImage = async (
  path: string,
  signal?: AbortSignal,
): Promise<MachoImageFacts> => {
  cancelled(signal);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await handle.stat();
    return await readMachoImage(async (offset, length) => {
      cancelled(signal);
      const buffer = new Uint8Array(
        Math.max(0, Math.min(length, size - offset)),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead);
    }, size);
  } finally {
    await handle.close();
  }
};

const fileSha256 = async (
  path: string,
  signal?: AbortSignal,
): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = new Uint8Array(HASH_CHUNK_BYTES);
    for (;;) {
      cancelled(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

const cancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Dylib resolution was cancelled",
    );
};

const missing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");
