import { access } from "node:fs/promises";
import { join } from "node:path";
import { DirectoryArtifactTraversalLimit } from "../artifacts/DirectoryArtifactReader.js";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import { androidLocaleQualifierSchema } from "../domain/apktool/apktoolResourceAnalysis.js";
import type { ApktoolWorkspace } from "./ApktoolWorkspace.js";

/** Count files over bounded examined coverage, including omitted special entries. */
export const countDecodedFiles = async (
  workspace: ApktoolWorkspace,
  root: string,
  signal: AbortSignal | undefined,
  maximumEntries: number,
): Promise<{ count: number; capped: boolean; locales: readonly string[] }> => {
  let count = 0;
  let capped = false;
  const locales: string[] = [];
  try {
    for await (const entry of workspace.entries(root, signal, maximumEntries)) {
      assertArtifactReadActive(signal);
      if (entry.kind === "file") count += 1;
      if (entry.kind === "directory") {
        const match = /^res\/values-(.+)$/u.exec(entry.path);
        if (
          match !== null &&
          androidLocaleQualifierSchema.safeParse(match[1]).success &&
          (await access(join(root, entry.path, "strings.xml")).then(
            () => true,
            () => false,
          ))
        )
          locales.push(match[1]!);
      }
    }
  } catch (cause) {
    if (!(cause instanceof DirectoryArtifactTraversalLimit)) throw cause;
    capped = true;
  }
  return { count, capped, locales: locales.sort() };
};
