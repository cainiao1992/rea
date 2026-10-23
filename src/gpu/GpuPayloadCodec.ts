import { nodeCodecResult } from "../compression/NodeCodecResult.js";
import { constants, inflate, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import { decodeLz4Block } from "./Lz4Block.js";
import { rejectGpu } from "./GpuSource.js";
const unzip = promisify(inflate);
const unzstd = promisify(zstdDecompress);
/** Locate one standard Zstandard frame without interpreting compressed literals. */
const zstdFrameBytes = (bytes: Buffer): number => {
  const require = (offset: number, size: number): void => {
    if (offset > bytes.length - size)
      rejectGpu("GPU Zstandard frame is truncated");
  };
  require(0, 5);
  if (bytes.readUInt32LE(0) !== 0xfd2fb528)
    rejectGpu("GPU Zstandard frame magic is invalid");
  const descriptor = bytes[4]!;
  if ((descriptor & 0x08) !== 0)
    rejectGpu("GPU Zstandard frame uses a reserved header bit");
  const singleSegment = (descriptor & 0x20) !== 0;
  const sizeFlag = descriptor >>> 6;
  const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 2 ** sizeFlag;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  let at = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + sizeBytes;
  require(0, at);
  for (;;) {
    require(at, 3);
    const header = bytes.readUIntLE(at, 3);
    const kind = (header >>> 1) & 3;
    if (kind === 3) rejectGpu("GPU Zstandard block uses a reserved type");
    const length = kind === 1 ? 1 : header >>> 3;
    at += 3;
    require(at, length);
    at += length;
    if ((header & 1) !== 0) break;
  }
  const checksumBytes = (descriptor & 4) === 0 ? 0 : 4;
  require(at, checksumBytes);
  return at + checksumBytes;
};

const decodeGpuCodec = async (
  bytes: Buffer,
  compression: "zlib" | "zstd",
  expected: number,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; consumedBytes: number }> => {
  assertArtifactReadActive(signal);
  let result: unknown;
  try {
    const maxOutputLength = Math.max(1, expected);
    result = await (compression === "zstd"
      ? unzstd(bytes, {
          maxOutputLength,
          info: true,
          params: { [constants.ZSTD_d_windowLogMax]: 27 },
        })
      : unzip(bytes, { maxOutputLength, info: true }));
  } catch {
    assertArtifactReadActive(signal);
    return rejectGpu(
      "GPU payload decompression failed or exceeded its declared length",
    );
  }
  assertArtifactReadActive(signal);
  const decoded = nodeCodecResult(result);
  if (decoded.buffer.length !== expected)
    rejectGpu("GPU decompressed length disagrees with its declaration");
  return decoded;
};

/** Decode one framed payload, retaining its codec-owned encoded extent. */
export const decodeGpuPayloadStream = (
  bytes: Buffer,
  compression: "zlib" | "zstd",
  expected: number,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; consumedBytes: number }> =>
  decodeGpuCodec(
    compression === "zstd" ? bytes.subarray(0, zstdFrameBytes(bytes)) : bytes,
    compression,
    expected,
    signal,
  );
export const decodeGpuPayload = async (
  bytes: Buffer,
  compression: "zlib" | "zstd" | "lz4",
  expected: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  assertArtifactReadActive(signal);
  if (compression === "lz4") return decodeLz4Block(bytes, expected, signal);
  const { buffer: decoded, consumedBytes: consumed } = await decodeGpuCodec(
    bytes,
    compression,
    expected,
    signal,
  );
  if (consumed !== bytes.length)
    rejectGpu(
      "GPU compressed payload contains bytes outside its complete codec stream",
    );
  return decoded;
};
