import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { streamChunkToBuffer } from "../../artifacts/StreamBytes.js";

export type HashResult = {
  readonly sha256: string;
  readonly bytes: number;
  readonly prefix: Buffer;
};

export const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact inventory cancelled",
    );
};

export const hashReadable = async (
  stream: Readable,
  signal?: AbortSignal,
): Promise<HashResult> => {
  const hash = createHash("sha256");
  const prefixes: Buffer[] = [];
  let prefixBytes = 0;
  let bytes = 0;
  for await (const raw of stream) {
    abortIfNeeded(signal);
    const chunk = streamChunkToBuffer(raw);
    bytes += chunk.length;
    hash.update(chunk);
    if (prefixBytes < 16) {
      const selected = chunk.subarray(0, 16 - prefixBytes);
      prefixes.push(selected);
      prefixBytes += selected.length;
    }
  }
  return { sha256: hash.digest("hex"), bytes, prefix: Buffer.concat(prefixes) };
};
