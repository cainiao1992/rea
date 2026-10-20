import { Il2cppMetadataFormatFailure } from "./Il2cppMetadataFormat.js";
import { setImmediate } from "node:timers/promises";
import {
  readStableArtifact,
  type StableArtifactSnapshot,
} from "../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  ArtifactFileCancelled,
  bindArtifactFileCleanup,
  artifactFileCancellationCause,
  assertArtifactReadActive,
} from "../artifacts/ArtifactFileOperation.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { Il2cppMetadataPort } from "../application/il2cpp/Il2cppMetadataPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence } from "../domain/evidence.js";
import { createIl2cppMetadataAdmission } from "./Il2cppMetadataAdmission.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  il2cppMetadataSchema,
  type Il2cppMetadata,
  type Il2cppMetadataProviderInput,
} from "../domain/il2cpp/il2cppMetadata.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readIl2cppMetadataSteps,
  type Il2cppMetadataRowCounts,
} from "./Il2cppMetadataFile.js";

/** Bundled format reader identity; the metadata version is a separate observed fact. */
export const IL2CPP_METADATA_PROVIDER_IDENTITY = {
  id: "il2cpp-metadata",
  name: "REA IL2CPP global-metadata reader",
  version: "1",
} as const;
const OPERATION = "inspect_il2cpp_metadata";
const INPUT_BYTES = 256 * 1024 * 1024;
// A 12.9 MB Unity 6000.4 file with 112,232 methods serializes to 7.8 MB.
const OUTPUT_BYTES = 64 * 1024 * 1024;
const failureForPrimary = (cause: unknown, path: string): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof Il2cppMetadataFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
          cause,
        })
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${path} is corrupt: ${cause.message}`,
          },
        ]);
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { maximum_input_bytes: INPUT_BYTES },
        { cause },
      );
    if (cause.reason === "path")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(
    IL2CPP_METADATA_PROVIDER_IDENTITY.id,
    OPERATION,
    {
      cause,
      diagnostics: {
        path,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    },
  );
};

const failureFor = (cause: unknown, path: string): AnalysisError => {
  const primary =
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "failed"
      ? failureForPrimary(cause.fileCleanupFailure.outcome.cause, path)
      : failureForPrimary(cause, path);
  if (
    cause instanceof ArtifactReaderFailure &&
    cause.partialObservation !== undefined &&
    primary.partialObservation === undefined
  )
    primary.retainPartialObservation(cause.partialObservation);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    IL2CPP_METADATA_PROVIDER_IDENTITY.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  const error = analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
  bindArtifactFileCleanup(cause, error);
  return error;
};

const reportLimit = (path: string, maximumBytes: number) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "memory",
    `Complete IL2CPP metadata for ${path} exceeds the retained report budget; no complete inventory is retained.`,
    { maximum_report_bytes: maximumBytes },
  );

const sourceArtifact = (path: string, snapshot: StableArtifactSnapshot) => ({
  path,
  sha256: snapshot.sha256,
  bytes: snapshot.bytes.length,
});

/** Source identity survives a failed inventory without claiming decoded coverage. */
const metadataSourceEvidence = (
  artifact: Il2cppMetadata["artifact"],
  counts: Il2cppMetadataRowCounts | undefined,
) =>
  createEvidence(
    {
      path: artifact.path,
      sha256: artifact.sha256,
      format: "file",
    },
    IL2CPP_METADATA_PROVIDER_IDENTITY,
    {
      operation: "observe_il2cpp_metadata_source",
      predicateType: "rea.il2cpp-metadata-source",
      parameters: { path: artifact.path },
      result: {
        artifact,
        inventory_status: "not-returned-as-complete",
        ...(counts === undefined
          ? {}
          : { validated_section_row_counts: { ...counts } }),
      },
      confidence: "observed",
      limitations: [
        "This partial source observation does not contain a complete metadata inventory. Section row counts, when available, are derived from the validated header extents and record layout; names and relationships may remain unexamined.",
      ],
      locations: [
        { kind: "artifact-path", path: artifact.path },
        {
          kind: "file-offset-range",
          start: 0,
          end: artifact.bytes,
        },
      ],
    },
  );

/** Stable in-process decoding without subprocesses, temporary files, native binaries or decryption. */
export class Il2cppMetadataProvider implements Il2cppMetadataPort {
  readonly identity = IL2CPP_METADATA_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();
  #inspecting = false;

  /** `outputBytes` exists so tests can reach the guard with small files. */
  constructor(
    private readonly outputBytes: number = OUTPUT_BYTES,
    private readonly yieldControl: () => Promise<void> = setImmediate,
  ) {}

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      if (
        !(cause instanceof ArtifactReaderFailure) ||
        cause.cleanup === undefined
      )
        throw cause;
      const error = new ProviderCleanupError(
        IL2CPP_METADATA_PROVIDER_IDENTITY.id,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: OPERATION },
      );
      bindArtifactFileCleanup(cause, error);
      throw error;
    }
  }

  /** Read every image, type and method name from one stable file snapshot. */
  async inspect(
    input: Il2cppMetadataProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<Il2cppMetadata, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    if (this.#inspecting)
      return err(
        new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          "Only one IL2CPP metadata inspection is admitted per reader.",
          { maximum_concurrent_inspections: 1 },
        ),
      );
    this.#inspecting = true;
    const observed: {
      artifact?: Il2cppMetadata["artifact"];
      counts?: Il2cppMetadataRowCounts;
    } = {};
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          INPUT_BYTES,
          options?.signal,
          undefined,
          this.#resources,
        ).catch((cause: unknown) => {
          // Only this awaited stable read owns these typed physical outcomes.
          const outcome =
            cause instanceof ArtifactFileCleanupFailure
              ? (cause as ArtifactFileCleanupFailure<StableArtifactSnapshot>)
                  .fileCleanupFailure.outcome
              : cause instanceof ArtifactFileCancelled
                ? (cause as ArtifactFileCancelled<StableArtifactSnapshot>)
                    .fileCancellation.outcome
                : undefined;
          if (outcome?.kind === "completed")
            observed.artifact = sourceArtifact(input.path, outcome.value);
          throw cause;
        });
        const artifact = sourceArtifact(input.path, snapshot);
        observed.artifact = artifact;
        assertArtifactReadActive(options?.signal);
        const limit = this.outputBytes;
        const admission = createIl2cppMetadataAdmission(limit, () => {
          throw reportLimit(input.path, limit);
        });
        const steps = readIl2cppMetadataSteps(snapshot.bytes, {
          ...admission,
          beforeRows: (counts) => {
            observed.counts = counts;
            admission.beforeRows(counts);
          },
        });
        let step = steps.next();
        while (!step.done) {
          await this.yieldControl();
          assertArtifactReadActive(options?.signal);
          step = steps.next();
        }
        const decoded = step.value;
        const report = {
          ...decoded,
          artifact,
          limitations: [
            "Only unencrypted global-metadata.dat versions 24, 27, 29, 31 and 39 are decoded; names, counts and string literals are observed file content, not runtime behavior.",
            "Native code addresses, IL2CPP binary registration, member types, signatures and generic instances are not recovered.",
            "declaring_type for types is derived from the nestedTypes section, and member and parameter owners from the owners' index ranges; row positions are the metadata indices.",
          ],
        };
        if (jsonValueByteLength(report, limit) > limit)
          throw reportLimit(input.path, limit);
        const parsed = il2cppMetadataSchema.safeParse(report);
        if (!parsed.success)
          throw new AnalysisOutputError(
            OPERATION,
            "IL2CPP metadata reader produced invalid section ranges or report values.",
            { cause: parsed.error },
          );
        assertArtifactReadActive(options?.signal);
        return ok(parsed.data);
      });
    } catch (cause: unknown) {
      const failure = failureFor(cause, input.path);
      if (
        observed.artifact !== undefined &&
        failure.partialObservation === undefined
      )
        failure.retainPartialObservation(
          metadataSourceEvidence(observed.artifact, observed.counts),
        );
      return err(failure);
    } finally {
      this.#inspecting = false;
    }
  }
}
