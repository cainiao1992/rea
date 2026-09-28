import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { inventoryArtifactFully } from "../application/ArtifactInventory.js";
import { extractArtifact } from "../application/ArtifactExtraction.js";
import {
  ARTIFACT_TOOL_CONTRACTS,
  artifactInspectionInputSchema,
  artifactInventoryInputSchema,
  artifactExtractionInputSchema,
  type ArtifactToolName,
} from "../contracts/artifactToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCapabilityUnavailableError,
  ArtifactOperationError,
  type AnalysisError,
} from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import {
  ArtifactReaderFailure,
  type ArtifactLimits,
} from "./ArtifactReader.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../application/InvestigationProviders.js";
import { createEvidence } from "../domain/evidence.js";
import { createArtifactInspection } from "../domain/artifactInspection.js";
import {
  resolveArtifactIntegrityPolicy,
  resolveNativeMountPolicy,
} from "../application/ArtifactInventory/policy.js";

const IDENTITY: ProviderIdentity = Object.freeze(ARTIFACT_GRAPH_PROVIDER);

/** Read-only inventory and exclusively owned extraction provider. */
export class ArtifactProvider implements AnalysisProvider {
  constructor(
    private readonly nativeMountEnabled = false,
    private readonly integrityContinueEnabled = false,
  ) {}

  readonly #capabilities: readonly CapabilityDescriptor[] = Object.freeze(
    ARTIFACT_TOOL_CONTRACTS.map((contract) =>
      Object.freeze({
        provider: IDENTITY,
        operation: contract.name,
        available: true as const,
        reason: null,
        pagination:
          contract.name === "inspect_artifact"
            ? ("none" as const)
            : ("offset" as const),
        exhaustive: false,
        effects: Object.freeze({
          mutatesArtifact: false,
          launchesProcess: true,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: contract.name === "extract_artifact",
          changesPermissions: false,
          requiresRoot: false,
        }),
        limits: Object.freeze({
          maxResults: 500,
          maxPayloadBytes: 4 * 1024 * 1024,
          timeoutMs: 120_000,
        }),
        limitations: Object.freeze([
          "DMG child inventory is macOS-only and requires per-call approval plus operator policy; PKG remains root-hash-only.",
          "ASAR files discovered in filesystem-backed inventories are expanded without bulk extraction; other nested containers remain recorded only.",
        ]),
      }),
    ),
  );

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new ArtifactClient(
      target,
      this.nativeMountEnabled,
      this.integrityContinueEnabled,
    );
  }
}

class ArtifactClient implements AnalysisClient {
  constructor(
    private readonly target: BinaryTarget,
    private readonly nativeMountEnabled: boolean,
    private readonly integrityContinueEnabled: boolean,
  ) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (operation === "health")
      return ok(createAnalysisExecution(null, IDENTITY));
    if (!isArtifactOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Operation is not implemented by artifact graph provider.",
        ),
      );
    try {
      if (operation === "inspect_artifact") {
        const inspected = await this.inspectArtifact(parameters, options);
        return inspected;
      }
      if (operation === "extract_artifact") {
        const parsed = artifactExtractionInputSchema.parse(parameters);
        const result = await extractArtifact(
          {
            inputPath: this.target.sourcePath ?? this.target.path,
            inputFormat: this.target.format,
            outputRoot: parsed.output_root,
            occurrenceIds: parsed.occurrence_ids,
            offset: 0,
            limit: parsed.occurrence_ids.length,
            limits: DEFAULT_ARTIFACT_LIMITS,
          },
          options?.signal,
        );
        return ok(
          createAnalysisExecution(result, IDENTITY, {
            rawResult: null,
            limitations: result.limitations,
            subject: subjectFor(
              this.target.sourcePath ?? this.target.path,
              result.manifest,
            ),
            locations: result.artifacts.items.map(
              ({ relative_path: path }) => ({
                kind: "artifact-path" as const,
                path,
              }),
            ),
          }),
        );
      }
      const parsed = artifactInventoryInputSchema.parse(parameters);
      const result = await this.inventory(parsed, options);
      return ok(
        createAnalysisExecution(result, IDENTITY, {
          rawResult: null,
          limitations: result.limitations,
          subject: subjectFor(
            this.target.sourcePath ?? this.target.path,
            result.manifest,
          ),
          locations: result.occurrences.items.map(({ logical_path: path }) => ({
            kind: "artifact-path" as const,
            path,
          })),
        }),
      );
    } catch (cause: unknown) {
      return err(translateFailure(operation, cause));
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private async inspectArtifact(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const parsed = artifactInspectionInputSchema.parse(parameters);
    const inventoryParameters = artifactInventoryInputSchema.parse({
      native_mount_approved: parsed.native_mount_approved,
      integrity_policy: parsed.integrity_policy,
      integrity_continue_approved: parsed.integrity_continue_approved,
      max_integrity_mismatches: parsed.max_integrity_mismatches,
    });
    await options?.progress?.report({
      phase: "inspect_artifact.inventory",
      completed: 0,
      total: 1,
      message: "inventory substep started",
    });
    const inventory = await this.inventory(inventoryParameters, options);
    const subject = subjectFor(
      this.target.sourcePath ?? this.target.path,
      inventory.manifest,
    );
    const locations = inventory.occurrences.items.map(
      ({ logical_path: path }) => ({
        kind: "artifact-path" as const,
        path,
      }),
    );
    const inventoryEvidence = createEvidence(subject, IDENTITY, {
      operation: "inventory_artifact",
      parameters: inventoryParameters,
      result: inventory,
      rawResult: null,
      limitations: inventory.limitations,
      locations,
    });
    const result = createArtifactInspection(inventoryEvidence);
    await options?.progress?.report({
      phase: "inspect_artifact.inventory",
      completed: 1,
      total: 1,
      message: "inventory substep completed",
    });
    return ok(
      createAnalysisExecution(result, IDENTITY, {
        rawResult: null,
        limitations: result.limitations,
        subject,
        locations,
      }),
    );
  }

  private inventory(
    parsed: {
      readonly native_mount_approved: boolean;
      readonly integrity_policy: "fail" | "record-and-continue";
      readonly integrity_continue_approved: boolean;
      readonly max_integrity_mismatches: number;
    },
    options?: ExecutionOptions,
  ) {
    return inventoryArtifactFully(
      this.target.sourcePath ?? this.target.path,
      DEFAULT_ARTIFACT_LIMITS,
      {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        nativeMount: resolveNativeMountPolicy(
          parsed.native_mount_approved === true,
          this.nativeMountEnabled,
        ),
        integrity: resolveArtifactIntegrityPolicy(
          parsed.integrity_policy === "fail"
            ? { mode: "fail" }
            : {
                mode: parsed.integrity_policy,
                maxMismatches: parsed.max_integrity_mismatches,
              },
          this.integrityContinueEnabled,
        ),
      },
    );
  }
}

const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
  maxEntries: 10_000,
  maxTotalBytes: 1_073_741_824,
  maxEntryBytes: 268_435_456,
  maxCompressionRatio: 1_000,
  maxDepth: 20,
  maxPathBytes: 4_096,
};

const isArtifactOperation = (
  operation: AnalysisOperation,
): operation is ArtifactToolName =>
  ARTIFACT_TOOL_CONTRACTS.some(({ name }) => name === operation);

const translateFailure = (
  operation: ArtifactToolName,
  cause: unknown,
): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure)
    return new ArtifactOperationError(operation, cause.reason, cause.details);
  return new ArtifactOperationError(operation, "io");
};

const subjectFor = (
  path: string,
  manifest: {
    readonly root_sha256: string;
    readonly root_format: import("../domain/artifactGraph.js").ArtifactNode["format"];
  },
) => ({
  path,
  sha256: manifest.root_sha256,
  format: manifest.root_format,
});
