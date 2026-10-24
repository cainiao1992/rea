import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { onTestFinished } from "vitest";
import { ArtifactReaderFailure } from "../../src/artifacts/ArtifactReader.js";
import { classifyAndHashRoot as classifyAndHashRootOwned } from "../../src/artifacts/inventory/classify.js";
import {
  inventoryArtifact as inventoryArtifactOwned,
  scanArtifactInventoryInScope,
} from "../../src/artifacts/inventory/ArtifactInventory.js";
import { scanCanonicalArtifactInventoryInScope } from "../../src/artifacts/inventory/scanCanonical.js";
import type { createReader } from "../../src/artifacts/inventory/reader.js";
import {
  materializeArtifactInventoryInScope,
  type ArtifactExtractionInput,
} from "../../src/artifacts/extraction/ArtifactExtraction.js";
import type { ArtifactInventorySnapshot } from "../../src/domain/artifactInventorySnapshot.js";
import type { ArtifactInventoryOptions } from "../../src/artifacts/inventory/types.js";

type InventoryOptions = Omit<ArtifactInventoryOptions, "resourceScope">;

export const inventoryArtifact = (
  path: string,
  options: InventoryOptions = {},
) =>
  withArtifactResourceScope((resourceScope) =>
    inventoryArtifactOwned(path, { ...options, resourceScope }),
  );

export const classifyAndHashRoot = (
  path: string,
  directory: boolean,
  expectedMetadata: import("node:fs").Stats,
  signal?: AbortSignal,
) =>
  withArtifactResourceScope((resourceScope) =>
    classifyAndHashRootOwned(path, directory, expectedMetadata, {
      resourceScope,
      ...(signal === undefined ? {} : { signal }),
    }),
  );

export const scanArtifactInventory = (
  path: string,
  options: InventoryOptions = {},
) =>
  withArtifactResourceScope((resourceScope) =>
    resourceScope.run(() =>
      scanArtifactInventoryInScope(path, { ...options, resourceScope }),
    ),
  );

export const scanCanonicalArtifactInventory = (
  path: string,
  options: InventoryOptions = {},
  readerFactory?: typeof createReader,
) =>
  withArtifactResourceScope((resourceScope) =>
    resourceScope.run(() =>
      scanCanonicalArtifactInventoryInScope(
        path,
        { ...options, resourceScope },
        readerFactory,
      ),
    ),
  );

export const materializeArtifactInventory = (
  input: Omit<ArtifactExtractionInput, "resourceScope">,
  sourcePath: string,
  snapshot: ArtifactInventorySnapshot,
  signal?: AbortSignal,
) =>
  withArtifactResourceScope((resourceScope) =>
    resourceScope.run(() =>
      materializeArtifactInventoryInScope(
        { ...input, resourceScope },
        sourcePath,
        snapshot,
        signal,
      ),
    ),
  );

export const withArtifactResourceScope = async <T>(
  operation: (resourceScope: ArtifactResourceScope) => Promise<T>,
): Promise<T> => {
  const resourceScope = new ArtifactResourceScope();
  onTestFinished(() => resourceScope.close());
  let outcome:
    | { readonly kind: "completed"; readonly value: T }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    outcome = {
      kind: "completed",
      value: await operation(resourceScope),
    };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  try {
    await resourceScope.close();
  } catch (cleanupCause: unknown) {
    if (outcome.kind === "failed")
      throw ArtifactReaderFailure.withCleanup(
        outcome.cause,
        ArtifactReaderFailure.cleanupObservation(
          cleanupCause,
          "artifact resources",
        ),
      );
    throw cleanupCause;
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};
