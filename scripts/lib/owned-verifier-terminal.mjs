let implementation;

/** Load the development terminal owner and canonical process helpers together. */
export async function runOwnedVerifierTerminal(options, dependencies) {
  implementation ??= import("tsx/esm/api").then(({ tsImport }) =>
    tsImport(
      new URL("./verifier-terminal-owner.mts", import.meta.url).href,
      import.meta.url,
    ),
  );
  const module = await implementation;
  return module.runOwnedVerifierTerminal(options, dependencies);
}
