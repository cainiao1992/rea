import { buildManagedNestedTypeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { readManagedPeLayout } from "../../src/dotnet/ManagedPeReader.js";
import {
  metadataRowOffset,
  readManagedMetadataLayout,
} from "../../src/dotnet/ManagedMetadataLayout.js";

/** Two nested Inner declarations, one with its own Fixture namespace. */
export const namespaceBearingNestedTypes = () => {
  const bytes = buildManagedNestedTypeFixture();
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Missing fixture CLI");
  const layout = readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "fixture"),
    pe.cli.metadata.size,
  );
  const column = 4 + layout.stringIndexSize;
  const namespace = bytes.readUInt16LE(
    metadataRowOffset(layout, 2, 2) + column,
  );
  bytes.writeUInt16LE(namespace, metadataRowOffset(layout, 2, 4) + column);
  return bytes;
};
