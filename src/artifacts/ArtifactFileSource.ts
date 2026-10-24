import { artifactIntegrityDetails } from "../domain/artifactIntegrity.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  RegularFileOperationCancelled,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { hashReadable } from "./ArtifactHash.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";

/** One persistent descriptor and hash binding, borrowing caller-admitted sources. */
export class ArtifactFileSource {
  readonly #scope = new ArtifactResourceScope();
  #owner: OwnedFileHandle | undefined;
  #opening: Promise<StableRegularFileDescriptor> | undefined;
  #boundSha256: string | undefined;

  constructor(
    private readonly path: string,
    private readonly diagnosticLabel: string,
    private readonly admitted?: StableRegularFileDescriptor,
  ) {
    this.#scope.addCloseHook(async () => {
      if (this.#owner !== undefined) {
        await this.#owner.close();
        this.#owner = undefined;
      }
      this.#opening = undefined;
      this.#boundSha256 = undefined;
    });
  }

  /** Verify the admitted descriptor; the selected pathname is not reinterpreted. */
  read(signal?: AbortSignal): Promise<StableRegularFileDescriptor> {
    return this.#scope.run(() => this.#verify(signal));
  }

  /** Bind verified bytes to the inventory's expected whole-carrier identity. */
  bindSha256(expectedSha256: string, signal?: AbortSignal): Promise<void> {
    return this.#scope.run(async () => {
      const { handle } = await this.#verify(signal);
      const observed =
        this.#boundSha256 ??
        (
          await hashReadable(
            readFileHandleChunks(handle, {
              signal,
              cancellationFailure: (reason) =>
                new ArtifactReaderFailure(
                  "cancelled",
                  `${this.diagnosticLabel} verification cancelled`,
                  { cause: reason },
                ),
            }),
            signal,
          )
        ).sha256;
      await this.#verify(signal);
      if (observed !== expectedSha256)
        throw new ArtifactReaderFailure(
          "integrity",
          `${this.diagnosticLabel} carrier changed after inventory`,
          undefined,
          artifactIntegrityDetails(
            ".",
            { algorithm: "sha256", digest: expectedSha256 },
            observed,
            false,
          ),
        );
      this.#boundSha256 = observed;
    });
  }

  /** Join admitted operations before closing; failed descriptor ownership stays retained. */
  close(): Promise<void> {
    return this.#scope.close();
  }

  async #verify(signal?: AbortSignal): Promise<StableRegularFileDescriptor> {
    assertArtifactReadActive(signal);
    this.#opening ??= this.#admit(signal);
    const source = await this.#opening;
    const observed = await source.handle.stat();
    if (!sameRegularFileState(source.initial, observed))
      throw new ArtifactReaderFailure(
        "integrity",
        `${this.diagnosticLabel} source identity changed: ${this.path}`,
      );
    assertArtifactReadActive(signal);
    return source;
  }

  async #admit(signal?: AbortSignal): Promise<StableRegularFileDescriptor> {
    try {
      const handle =
        this.admitted?.handle ??
        (await openRegularFile(this.path, { symlinks: "reject", signal }));
      if (this.admitted === undefined)
        this.#owner = new OwnedFileHandle(handle);
      const initial = this.admitted?.initial ?? (await handle.stat());
      return { handle, initial };
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure) {
        this.#owner = cause.owner;
        throw ArtifactReaderFailure.withCleanup(
          this.#admissionFailure(cause.cause),
          ArtifactReaderFailure.cleanupObservation(
            cause.cleanupCause,
            this.path,
          ),
        );
      }
      throw this.#admissionFailure(cause);
    }
  }

  #admissionFailure(cause: unknown): ArtifactReaderFailure {
    if (cause instanceof ArtifactReaderFailure) return cause;
    if (cause instanceof RegularFileOperationCancelled)
      return new ArtifactReaderFailure(
        "cancelled",
        `${this.diagnosticLabel} admission cancelled`,
        { cause: cause.reason },
      );
    if (cause instanceof NonRegularFileReadError)
      return new ArtifactReaderFailure(
        "format",
        `${this.diagnosticLabel} source is not a regular file: ${this.path}`,
        { cause },
      );
    return new ArtifactReaderFailure(
      "io",
      cause instanceof Error
        ? cause.message
        : `Cannot admit ${this.diagnosticLabel} source: ${this.path}`,
      { cause },
    );
  }
}
