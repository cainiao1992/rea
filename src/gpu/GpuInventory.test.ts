import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { GpuInventory } from "./GpuInventory.js";
import { GpuBufferSource } from "./GpuSource.js";
import {
  ccobFixture,
  cubinFixture,
  cudaFixture,
  hipFixture,
} from "../../tests/fixtures/gpu/codeObjects.js";

it("uses the zlib stream extent for legacy CCOB even when encoded literals contain CCOB", async () => {
  const bundle = hipFixture(
    Buffer.from("ordinary CCOB marker"),
    "host-x86_64-unknown-linux",
  );
  const compressed = deflateSync(bundle, { level: 0 });
  expect(compressed.indexOf("CCOB")).toBeGreaterThan(0);
  const legacyHeader = Buffer.alloc(20);
  legacyHeader.write("CCOB");
  legacyHeader.writeUInt16LE(1, 4);
  legacyHeader.writeUInt32LE(bundle.length, 8);
  createHash("md5").update(bundle).digest().copy(legacyHeader, 12, 0, 8);
  const legacy = Buffer.concat([legacyHeader, compressed]);
  const following = ccobFixture(2, "zlib", bundle);
  for (const bytes of [
    legacy,
    Buffer.concat([legacy, Buffer.alloc(4), following]),
  ]) {
    const inventory = new GpuInventory({
      path: "/fixture",
      analysis: "inventory",
    });
    await inventory.inspect(new GpuBufferSource(bytes, "fixture"));
    expect(inventory.discovery).toBe("complete");
    expect(inventory.objects[0]).toMatchObject({
      encoded_size: compressed.length,
      location: { offset: 20, size: compressed.length },
      inspection: "complete",
    });
    if (bytes !== legacy)
      expect(
        inventory.objects.filter((row) => row.kind === "hip-bundle"),
      ).toHaveLength(2);
  }
});

it.each(["hip-amdgcn-amd-amdhsa--gfx1100", "hip-amdgcn-amd-amdhsa--"])(
  "keeps HIP bitcode %s unsupported with its digest and target declaration",
  async (id) => {
    const payload = Buffer.from("4243c0de00000000", "hex");
    const inventory = new GpuInventory({
      path: "/fixture",
      analysis: "kernels",
    });
    await inventory.inspect(
      new GpuBufferSource(hipFixture(payload, id), "fixture"),
    );
    expect(inventory.objects.at(-1)).toMatchObject({
      inspection: "unsupported",
      limitations: expect.arrayContaining([
        expect.stringContaining("LLVM bitcode"),
      ]),
    });
    if (id.endsWith("gfx1100"))
      expect(inventory.objects.at(-1)?.sha256).toBe(
        createHash("sha256").update(payload).digest("hex"),
      );
    expect(inventory.kernels).toEqual([]);
  },
);

it.each(["cuda", "ccob"] as const)(
  "refuses oversized %s output before reading compressed input",
  async (kind) => {
    const bytes =
      kind === "cuda"
        ? cudaFixture("zstd", [{ kind: 2, target: 80, bytes: cubinFixture() }])
        : ccobFixture(3);
    const payloadOffset = kind === "cuda" ? 80 : 32;
    bytes.writeBigUInt64LE(
      BigInt(128 * 1024 * 1024 + 1),
      kind === "cuda" ? 72 : 16,
    );
    const source = new GpuBufferSource(bytes, "fixture"),
      reads: number[] = [],
      inventory = new GpuInventory({ path: "/fixture", analysis: "kernels" });
    await inventory.inspect({
      size: source.size,
      containerId: source.containerId,
      read: async (offset, size) => {
        reads.push(offset);
        return source.read(offset, size);
      },
    });
    expect(reads).not.toContain(payloadOffset);
    expect(inventory.objects[0]).toMatchObject({
      inspection: "capacity",
      sha256: null,
    });
    expect(inventory.kernels).toEqual([]);
  },
);
it("observes cancellation while walking flat empty bundles in a decoded buffer", async () => {
  const empty = Buffer.alloc(32);
  empty.write("__CLANG_OFFLOAD_BUNDLE__");
  const bytes = Buffer.concat(Array.from({ length: 4096 }, () => empty));
  const controller = new AbortController(),
    reason = { selected: "cancel-buffer-walk" };
  const inventory = new GpuInventory(
    { path: "/fixture", analysis: "inventory" },
    controller.signal,
  );
  const result = inventory.inspect(new GpuBufferSource(bytes, "fixture"));
  setImmediate(() => controller.abort(reason));
  await expect(result).rejects.toMatchObject({
    reason: "cancelled",
    cause: reason,
  });
});
