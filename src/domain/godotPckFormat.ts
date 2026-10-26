/** "GDPC" read as a little-endian uint32: the Godot Engine pack magic. */
export const GODOT_PCK_MAGIC = 0x43504447;

/** Whether bytes start with a standalone Godot PCK header. */
export const hasGodotPckHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x47 &&
  bytes[1] === 0x44 &&
  bytes[2] === 0x50 &&
  bytes[3] === 0x43;

/** Common declared fields; support and pack extent admission belong to callers. */
export interface GodotPckHeaderFacts {
  readonly formatVersion: number;
  readonly engineMajor: number;
  readonly engineMinor: number;
  readonly enginePatch: number;
}

/** Decode declared fields after the caller admits a complete 20-byte header. */
export const readGodotPckHeaderFacts = (
  bytes: Uint8Array,
): GodotPckHeaderFacts => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    formatVersion: view.getUint32(4, true),
    engineMajor: view.getUint32(8, true),
    engineMinor: view.getUint32(12, true),
    enginePatch: view.getUint32(16, true),
  };
};
