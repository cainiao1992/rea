import { rm } from "node:fs/promises";
import { join } from "node:path";

import { onTestFinished } from "vitest";

import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../support/workspace/workspaceFixture.js";

const TEMPORARY_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*-$/u;

/** Creates a canonical temporary directory owned by the current Vitest case. */
export const createTestTempDirectory = async (
  prefix: string,
): Promise<string> => {
  if (!TEMPORARY_PREFIX.test(prefix) || prefix.length > 80) {
    throw new TypeError(
      "Test temporary directory prefixes must be safe basenames ending in '-'",
    );
  }

  const workspace = await createTestWorkspace(prefix);
  const canonicalDirectory = workspace.root;
  // Preserve the legacy helper's empty-root contract; callers own all content.
  await Promise.all([
    rm(join(canonicalDirectory, "home"), { recursive: true, force: true }),
    rm(join(canonicalDirectory, "xdg"), { recursive: true, force: true }),
  ]);
  onTestFinished(async () => {
    await removeTestWorkspace(canonicalDirectory);
  });
  return canonicalDirectory;
};
