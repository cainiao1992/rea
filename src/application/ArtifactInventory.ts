import { realpath } from "node:fs/promises";

import type { ArtifactLimits } from "../artifacts/ArtifactReader.js";
import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "../domain/artifactGraph.js";
import { abortIfNeeded } from "./ArtifactInventory/hash.js";
import { scanCanonicalArtifactInventory } from "./ArtifactInventory/scanCanonical.js";
import type {
  ArtifactIntegrityPolicy,
  ArtifactInventoryOptions,
  ArtifactInventorySnapshot,
  ArtifactNativeMountPolicy,
} from "./ArtifactInventory/types.js";

export { scanCanonicalArtifactInventory } from "./ArtifactInventory/scanCanonical.js";

export type {
  ArtifactIntegrityPolicy,
  ArtifactInventoryOptions,
  ArtifactInventorySnapshot,
  ArtifactNativeMountPolicy,
} from "./ArtifactInventory/types.js";

/** Inventory one local artifact without extracting or mounting it. */
export const inventoryArtifact = async (
  inputPath: string,
  limits: ArtifactLimits,
  options: {
    readonly signal?: AbortSignal;
    readonly nativeMount?: ArtifactNativeMountPolicy;
    readonly integrity?: ArtifactIntegrityPolicy;
  } = {},
): Promise<ArtifactInventoryResult> => {
  const snapshot = await scanArtifactInventory(inputPath, limits, options);
  return artifactInventoryResultSchema.parse(snapshot);
};

/** Inventory one artifact and return every graph collection in one response. */
export const inventoryArtifactFully = async (
  inputPath: string,
  limits: ArtifactLimits,
  options: {
    readonly signal?: AbortSignal;
    readonly nativeMount?: ArtifactNativeMountPolicy;
    readonly integrity?: ArtifactIntegrityPolicy;
  } = {},
): Promise<ArtifactInventoryResult> => {
  const snapshot = await scanArtifactInventory(inputPath, limits, options);
  return artifactInventoryResultSchema.parse(snapshot);
};

/** Scan an artifact once and retain the complete immutable graph for projection. */
export const scanArtifactInventory = async (
  inputPath: string,
  limits: ArtifactLimits,
  options: ArtifactInventoryOptions = {},
): Promise<ArtifactInventorySnapshot> => {
  abortIfNeeded(options.signal);
  const path = await realpath(inputPath);
  return scanCanonicalArtifactInventory(path, limits, options);
};
