import { nodeCodecResult } from "../compression/NodeCodecResult.js";
import { constants, inflate, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import { decodeLz4Block } from "./Lz4Block.js";
import { rejectGpu } from "./GpuSource.js";
const unzip = promisify(inflate);
const unzstd = promisify(zstdDecompress);
export const decodeGpuPayload = async (
  bytes: Buffer,
  compression: "zlib" | "zstd" | "lz4",
  expected: number,
  signal?: AbortSignal,
  allowZeroPadding = false,
): Promise<Buffer> => {
  assertArtifactReadActive(signal);
  if (compression === "lz4") return decodeLz4Block(bytes, expected, signal);
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
  const { buffer: decoded, consumedBytes: consumed } = nodeCodecResult(result);
  if (
    consumed !== bytes.length &&
    (!allowZeroPadding ||
      consumed < 0 ||
      consumed > bytes.length ||
      !bytes.subarray(consumed).every((byte) => byte === 0))
  )
    rejectGpu(
      "GPU compressed payload contains bytes outside its complete codec stream",
    );
  if (decoded.length !== expected)
    rejectGpu("GPU decompressed length disagrees with its declaration");
  return decoded;
};
