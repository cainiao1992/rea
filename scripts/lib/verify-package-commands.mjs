let implementation;

/** Load the development owner as one source graph, only when commands are needed. */
export async function createPackageVerifierCommands(options) {
  implementation ??= import("tsx/esm/api").then(({ tsImport }) =>
    tsImport(
      new URL("./package-command-owner.mts", import.meta.url).href,
      import.meta.url,
    ),
  );
  const module = await implementation;
  return module.createPackageVerifierCommands(options);
}
