import {
  createStoreFileLock,
  removeStaleStoreFileLock,
  type StoreFileLock,
} from "./StoreFileLock.js";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { isPathWithinRoot } from "../domain/localPath.js";
import writeFileAtomic from "write-file-atomic";

import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { isJsonWithinLimits } from "../domain/jsonLimits.js";
import { WorkspaceStorageError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { canonicalizeConfiguredRoots } from "./ConfiguredRoots.js";

type WorkspaceResult<Value> = Result<Value, WorkspaceStorageError>;

/** Parser, serializer, and CAS transition owned by one revisioned workspace. */
export interface RevisionedWorkspaceCodec<Document> {
  readonly parse: (input: unknown) => Document;
  readonly serialize: (document: Document) => string;
  readonly validateNext: (
    current: Document | null,
    next: Document,
    expectedRevision: number | null,
  ) => WorkspaceResult<null>;
}

/** Read one root-confined, owner-only revisioned workspace document. */
export const readRevisionedWorkspace = async <Document>(
  path: string,
  policy: EvidenceFilePolicy,
  codec: RevisionedWorkspaceCodec<Document>,
): Promise<WorkspaceResult<Document | null>> => {
  if (policy.roots.length === 0)
    return err(new WorkspaceStorageError("read", "disabled"));
  try {
    const destination = await resolveDestination(path, policy.roots);
    if (destination === null)
      return err(new WorkspaceStorageError("read", "outside-root"));
    return await readWorkspaceFile(destination, policy, codec);
  } catch (cause: unknown) {
    return err(new WorkspaceStorageError("read", "io", { cause }));
  }
};

export interface RevisionedWorkspaceWriteInput<Document> {
  readonly document: Document;
  readonly expectedRevision: number | null;
  readonly codec: RevisionedWorkspaceCodec<Document>;
}

/** Atomically append one validated CAS-linked revision under an exclusive lock. */
export const writeRevisionedWorkspace = async <Document>(
  path: string,
  policy: EvidenceFilePolicy,
  input: RevisionedWorkspaceWriteInput<Document>,
): Promise<
  WorkspaceResult<{ readonly path: string; readonly bytes: number }>
> => {
  const { document, expectedRevision, codec } = input;
  if (policy.roots.length === 0)
    return err(new WorkspaceStorageError("update", "disabled"));
  let encoded: string;
  try {
    encoded = codec.serialize(document);
  } catch (cause: unknown) {
    return err(new WorkspaceStorageError("update", "integrity", { cause }));
  }
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > policy.maxBytes)
    return err(new WorkspaceStorageError("update", "too-large"));
  let lock: StoreFileLock | undefined;
  try {
    const destination = await resolveDestination(path, policy.roots);
    if (destination === null)
      return err(new WorkspaceStorageError("update", "outside-root"));
    const acquired = await acquireLock(destination);
    if (!acquired.ok) return acquired;
    lock = acquired.value;
    const current = await readWorkspaceFile(destination, policy, codec);
    if (!current.ok) return current;
    const checked = codec.validateNext(
      current.value,
      document,
      expectedRevision,
    );
    if (!checked.ok) return checked;
    await writeFileAtomic(destination, encoded, {
      encoding: "utf8",
      mode: 0o600,
      fsync: true,
    });
    return ok({ path: resolve(path), bytes });
  } catch (cause: unknown) {
    return err(new WorkspaceStorageError("update", "io", { cause }));
  } finally {
    if (lock !== undefined) await lock.release();
  }
};

const resolveDestination = async (
  path: string,
  roots: readonly string[],
): Promise<string | null> => {
  const requested = resolve(path);
  const canonicalParent = await realpath(dirname(requested));
  const destination = resolve(canonicalParent, basename(requested));
  for (const root of await canonicalizeConfiguredRoots(
    roots.map((configuredRoot) => resolve(configuredRoot)),
  )) {
    if (isPathWithinRoot(root, destination)) return destination;
  }
  return null;
};

const readWorkspaceFile = async <Document>(
  destination: string,
  policy: EvidenceFilePolicy,
  codec: RevisionedWorkspaceCodec<Document>,
): Promise<WorkspaceResult<Document | null>> => {
  const stats = await lstat(destination).catch((cause: unknown) => {
    if (isFileNotFound(cause)) return undefined;
    throw cause;
  });
  if (stats === undefined) return ok(null);
  if (!stats.isFile() || stats.isSymbolicLink())
    return err(new WorkspaceStorageError("read", "not-file"));
  if (stats.size > policy.maxBytes)
    return err(new WorkspaceStorageError("read", "too-large"));
  const encoded = await readFile(destination);
  if (encoded.byteLength > policy.maxBytes)
    return err(new WorkspaceStorageError("read", "too-large"));
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded.toString("utf8"));
  } catch (cause: unknown) {
    return err(new WorkspaceStorageError("read", "invalid-json", { cause }));
  }
  if (!isJsonWithinLimits(decoded, policy))
    return err(new WorkspaceStorageError("read", "too-large"));
  try {
    return ok(codec.parse(decoded));
  } catch (cause: unknown) {
    return err(new WorkspaceStorageError("read", "integrity", { cause }));
  }
};

const acquireLock = async (
  destination: string,
): Promise<WorkspaceResult<StoreFileLock>> => {
  const path = `${destination}.lock`;
  try {
    return ok(await createStoreFileLock(path));
  } catch (cause: unknown) {
    if (isAlreadyExists(cause) && (await removeStaleStoreFileLock(path))) {
      try {
        return ok(await createStoreFileLock(path));
      } catch (retryCause: unknown) {
        return err(
          new WorkspaceStorageError(
            "update",
            isAlreadyExists(retryCause) ? "locked" : "io",
            { cause: retryCause },
          ),
        );
      }
    }
    return err(
      new WorkspaceStorageError(
        "update",
        isAlreadyExists(cause) ? "locked" : "io",
        { cause },
      ),
    );
  }
};

const isFileNotFound = (cause: unknown): boolean =>
  errorCode(cause) === "ENOENT";

const isAlreadyExists = (cause: unknown): boolean =>
  errorCode(cause) === "EEXIST";

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;
