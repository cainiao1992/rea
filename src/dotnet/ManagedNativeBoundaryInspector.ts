import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  managedNativeBoundaryInspectionSchema,
  type ManagedNativeBoundaryInspection,
  type ManagedParseIssue,
} from "../domain/managedArtifact.js";
import {
  readManagedMetadataInventory,
  type ManagedResourceDirectory,
} from "./ManagedMetadataInventory.js";
import {
  readManagedMetadataLayout,
  type ManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  readManagedPeLayout,
  type ManagedPeLayout,
} from "./ManagedPeReader.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";
import {
  buildNativeBoundaryInspection,
  cliNative,
  nativeImplementations,
  parseFields,
  parseImplMaps,
  parseMethods,
  parseModuleRefs,
} from "./ManagedNativeBoundaryHelpers.js";

type Inventory = ReturnType<typeof readManagedMetadataInventory>;

/** Report a PE whose CLI data is absent or cannot be admitted. */
const emptyInspection = (
  target: BinaryTarget,
  bytes: Buffer,
  classification: "not-managed" | "malformed",
  issues: readonly ManagedParseIssue[] = [],
): ManagedNativeBoundaryInspection =>
  managedNativeBoundaryInspectionSchema.parse({
    artifact: {
      path: target.path,
      sha256: target.sha256,
      byte_length: bytes.length,
      format: "pe",
    },
    module: null,
    metadata: {
      status: classification === "malformed" ? "malformed" : "absent",
      version: null,
      table_row_counts: {},
    },
    identity_scope: {
      token_identity: "build-local",
      requires_artifact_sha256: target.sha256,
      requires_mvid: null,
    },
    cli_native: {
      il_only: false,
      requires_32bit: false,
      strong_name_signed: false,
      native_entry_point: false,
      ready_to_run_signature: false,
      managed_native_header_rva: 0,
      managed_native_header_size: 0,
    },
    module_refs: [],
    pinvoke_imports: [],
    native_implementations: [],
    summary: {
      module_ref_count: 0,
      pinvoke_import_count: 0,
      native_implementation_count: 0,
      ready_to_run: false,
      mixed_mode_or_native_header: false,
    },
    coverage: { state: "unavailable", issues },
    limitations: [
      "No CLI data was admitted; native boundary declarations are unavailable.",
      "Static inspection does not load or execute target code, so native export resolution is not performed.",
    ],
  });

const readBoundaryInventory = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  cli: NonNullable<ManagedPeLayout["cli"]>,
): {
  readonly layout: ManagedMetadataLayout;
  readonly inventory: Inventory;
} => {
  const metadataOffset = pe.rvaToOffset(
    cli.metadata.rva,
    cli.metadata.size,
    "cli.metadata",
  );
  const layout = readManagedMetadataLayout(
    bytes,
    metadataOffset,
    cli.metadata.size,
  );
  const resourceDirectory: ManagedResourceDirectory = {
    offset: pe.rvaToOffset(
      cli.resources.rva,
      cli.resources.size,
      "cli.resources",
    ),
    size: cli.resources.size,
  };
  const inventory = readManagedMetadataInventory(
    bytes,
    layout,
    resourceDirectory,
  );
  return { layout, inventory };
};

/** Inspect managed/native boundary declarations from PE metadata without execution. */
export const inspectManagedNativeBoundariesBytes = (
  bytes: Buffer,
  target: BinaryTarget,
): ManagedNativeBoundaryInspection => {
  let pe: ManagedPeLayout;
  try {
    pe = readManagedPeLayout(bytes);
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    return emptyInspection(target, bytes, "malformed", [cause.issue]);
  }
  if (pe.cli === null)
    return emptyInspection(
      target,
      bytes,
      pe.cliDirectoryPresent ? "malformed" : "not-managed",
      pe.cliIssue === null ? [] : [pe.cliIssue],
    );
  let layout: ManagedMetadataLayout;
  let inventory: Inventory;
  try {
    ({ layout, inventory } = readBoundaryInventory(bytes, pe, pe.cli));
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    return emptyInspection(target, bytes, "malformed", [cause.issue]);
  }
  const heapExtent = Math.max(layout.strings.size, layout.blob.size);
  const moduleRefs = parseModuleRefs(bytes, layout, heapExtent);
  const members = new Map([
    ...parseFields(bytes, layout, heapExtent),
    ...parseMethods(bytes, layout, heapExtent),
  ]);
  const imports = parseImplMaps({
    bytes,
    layout,
    heapExtent,
    modules: moduleRefs,
    members,
  });
  const pinvokeTokens = new Set(
    imports
      .map(({ member_token }) => member_token)
      .filter((token): token is string => token !== null),
  );
  const implementations = nativeImplementations(
    members.values(),
    pinvokeTokens,
  );
  return buildNativeBoundaryInspection({
    target,
    bytes,
    pe,
    layout,
    inventory,
    moduleRefs,
    imports,
    implementations,
    native: cliNative(pe),
    issues: [],
  });
};
