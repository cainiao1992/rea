import { createRequire } from "node:module";

const requireFromTsx = createRequire(import.meta.resolve("tsx/package.json"));
let imports = 0;

/** Load a verifier's source graph, then release the transform service that loaded it. */
export async function importVerifierSource(url, parent) {
  const { tsImport } = await import("tsx/esm/api");
  imports++;
  try {
    return await tsImport(url, parent);
  } finally {
    // tsx's esbuild service otherwise outlives every owned command and appears
    // as a surviving verifier descendant on a cold transform cache.
    if (--imports === 0) requireFromTsx("esbuild").stop();
  }
}
