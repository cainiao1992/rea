import { satisfies } from "semver";

/** Supported runtime range, kept in sync with the published package engines. */
export const SUPPORTED_NODE_VERSION_RANGE = "^22.19.0 || ^24.11.0 || >=26.0.0";

/** Return whether a Node.js version satisfies REA's tested runtime families. */
export const supportsNodeVersion = (version: string): boolean =>
  satisfies(version, SUPPORTED_NODE_VERSION_RANGE);
