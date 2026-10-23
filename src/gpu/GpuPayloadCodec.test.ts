import { expect, it } from "vitest";
import { deflateSync, zstdCompressSync } from "node:zlib";
import { decodeGpuPayload, decodeGpuPayloadStream } from "./GpuPayloadCodec.js";

it.each(["zlib", "zstd"] as const)(
  "retains the first %s stream extent without interpreting following container bytes",
  async (codec) => {
    const source = Buffer.from("ordinary CCOB marker");
    const encoded =
      codec === "zstd"
        ? zstdCompressSync(source)
        : deflateSync(source, { level: 0 });
    const input = Buffer.concat([
      encoded,
      Buffer.alloc(8),
      Buffer.from("CCOB"),
    ]);
    expect(await decodeGpuPayloadStream(input, codec, source.length)).toEqual({
      buffer: source,
      consumedBytes: encoded.length,
    });
    await expect(
      decodeGpuPayloadStream(
        encoded.subarray(0, encoded.length - 1),
        codec,
        source.length,
      ),
    ).rejects.toMatchObject({ kind: "malformed" });
  },
);
it.each(["zlib", "zstd"] as const)(
  "requires all declared %s input bytes to belong to the codec stream",
  async (codec) => {
    const source = Buffer.from("kernel"),
      encode = codec === "zstd" ? zstdCompressSync : deflateSync,
      compressed = encode(source);
    expect(await decodeGpuPayload(compressed, codec, source.length)).toEqual(
      source,
    );
    await expect(
      decodeGpuPayload(
        Buffer.concat([compressed, Buffer.from("junk")]),
        codec,
        source.length,
      ),
    ).rejects.toMatchObject({ kind: "malformed" });
  },
);
