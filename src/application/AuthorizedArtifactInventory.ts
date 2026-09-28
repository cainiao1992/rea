import { realpath } from "node:fs/promises";

import type { ArtifactLimits } from "../artifacts/ArtifactReader.js";
import {
  scanCanonicalArtifactInventory,
  type ArtifactInventoryOptions,
  type ArtifactInventorySnapshot,
} from "./ArtifactInventory.js";

/** Resolve, authorize, and scan one artifact without a second path resolution. */
export const scanAuthorizedArtifactInventory = async (
  inputPath: string,
  limits: ArtifactLimits,
  options: ArtifactInventoryOptions = {},
): Promise<ArtifactInventorySnapshot> => {
  const path = await realpath(inputPath);
  return scanCanonicalArtifactInventory(path, limits, options);
};
