import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import {
  RECORDED_LINUX_CORE_PROFILES,
  type RecordedCrash,
} from "../../domain/native/recordedCrash.js";

const segmentMatches = (
  segment: RecordedCrash["segments"][number],
  raw: Buffer,
): boolean => {
  const type = raw.readUInt32LE(0);
  return (
    type === segment.type_id &&
    BigInt(segment.flags) === BigInt(raw.readUInt32LE(4)) &&
    segment.file_backing ===
      (type === 0 || raw.readBigUInt64LE(32) === 0n ? "none" : "file") &&
    (
      [
        [segment.offset, 8],
        [segment.virtual_address, 16],
        [segment.physical_address, 24],
        [segment.file_size, 32],
        [segment.memory_size, 40],
        [segment.alignment, 48],
      ] as const
    ).every(
      ([field, relative]) => BigInt(field) === raw.readBigUInt64LE(relative),
    )
  );
};

/** Bind coverage-bearing ELF and note headers to the same snapshot as their payloads. */
export function validateRecordedCrashStructure(
  report: RecordedCrash,
  snapshot: Buffer,
  diagnostics: RecordedCrash["decoder_diagnostics"],
): void {
  const fail = () => {
    throw new AnalysisOutputError(
      "inspect_recorded_crash",
      "Reported core structure differs from its original ELF/note headers.",
      { capturedOutput: diagnostics },
    );
  };
  const bytesAt = (offset: bigint, bytes: number): Buffer => {
    if (offset < 0n || offset > BigInt(snapshot.length - bytes)) return fail();
    return snapshot.subarray(Number(offset), Number(offset) + bytes);
  };
  const header = bytesAt(0n, 64);
  const expectedMachine =
    RECORDED_LINUX_CORE_PROFILES[report.architecture].machine;
  if (
    !header
      .subarray(0, 6)
      .equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) ||
    header[6] !== 1 ||
    header.readUInt32LE(20) !== 1 ||
    ![0, 3].includes(header[7] ?? -1) ||
    header[8] !== 0 ||
    header.readUInt16LE(16) !== 4 ||
    header.readUInt16LE(18) !== expectedMachine
  )
    fail();
  const table = header.readBigUInt64LE(32);
  const entryBytes = header.readUInt16LE(54);
  let count = header.readUInt16LE(56);
  if (count === 0xffff) {
    if (header.readUInt16LE(58) < 64) return fail();
    count = bytesAt(header.readBigUInt64LE(40), 64).readUInt32LE(44);
  }
  if (count !== report.segments.length || (count > 0 && entryBytes < 56))
    fail();
  for (const segment of report.segments) {
    const offset = table + BigInt(segment.index) * BigInt(entryBytes);
    if (
      BigInt(segment.header_location.offset) !== offset ||
      BigInt(segment.header_location.bytes) !== BigInt(entryBytes)
    )
      fail();
    const raw = bytesAt(offset, entryBytes);
    if (!segmentMatches(segment, raw)) fail();
  }
  for (const note of report.notes) {
    const raw = bytesAt(BigInt(note.location.offset), 12);
    if (
      BigInt(note.owner_location.bytes) !== BigInt(raw.readUInt32LE(0)) ||
      BigInt(note.descriptor_location.bytes) !== BigInt(raw.readUInt32LE(4)) ||
      raw.readUInt32LE(8) !== note.type_id
    )
      fail();
  }
}
