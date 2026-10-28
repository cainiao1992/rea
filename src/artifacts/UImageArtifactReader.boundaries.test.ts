import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { UImageArtifactReader } from "./UImageArtifactReader.js";
import { buildUImage, buildMultiPayload } from "../../tests/fixtures/uimage.js";
import {
  parseUImageHeaderFields,
  parseMultiImageTable,
} from "../domain/uimageFormat.js";

const fixture = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-uimage-boundary-"),
    "image",
  );
  await writeFile(path, bytes);
  return path;
};
const entries = async (reader: UImageArtifactReader) => {
  const result = [];
  for await (const entry of reader.entries()) result.push(entry);
  return result;
};

it.each([
  [13, "nios", 13, "lynxos"],
  [14, "microblaze", 14, "vxworks"],
  [21, "openrisc", 16, "qnx"],
  [22, "arm64", 17, "u-boot"],
  [26, "riscv", 29, "elf"],
] as const)(
  "retains official architecture %s and OS identifiers",
  (arch, archName, os, osName) => {
    const result = parseUImageHeaderFields(buildUImage({ arch, os }));
    expect(result).toMatchObject({
      ok: true,
      value: { arch, archName, os, osName },
    });
  },
);

it("retains raw name bytes when mkimage's fixed field truncates UTF-8", () => {
  const bytes = buildUImage({ name: "测".repeat(11) });
  const result = parseUImageHeaderFields(bytes);
  expect(result).toMatchObject({
    ok: true,
    value: { name: null, nameBytesHex: bytes.subarray(32, 64).toString("hex") },
  });
});

it("aligns large component extents without signed 32-bit coercion or allocation", () => {
  const table = Buffer.alloc(12);
  table.writeUInt32BE(0x8000_0001, 0);
  table.writeUInt32BE(1, 4);
  expect(parseMultiImageTable(table, 12 + 0x8000_0004 + 1)).toEqual({
    ok: true,
    value: [
      { index: 0, byteOffset: 76, declaredSize: 0x8000_0001 },
      { index: 1, byteOffset: 76 + 0x8000_0004, declaredSize: 1 },
    ],
  });
});

it("preserves cancellation during payload CRC admission", async () => {
  const path = await fixture(
    buildUImage({ payload: Buffer.alloc(128 * 1024, 0x61) }),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new UImageArtifactReader(path, admitted);
  const controller = new AbortController(),
    reason = new Error("cancel CRC verification");
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  const reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await Reflect.apply(nativeRead, admitted.handle, args);
    if (args[3] === 64) controller.abort(reason);
    return result;
  }) as typeof admitted.handle.read);
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries(controller.signal)) {
          /* Exhaust the admitted operation. */
        }
      })(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  } finally {
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

it("admits a multi-image count before scanning the remaining payload", async () => {
  const payload = Buffer.concat([
    buildMultiPayload(Array.from({ length: 4097 }, () => Buffer.from("x"))),
    Buffer.alloc(1024 * 1024),
  ]);
  const path = await fixture(buildUImage({ type: 4, payload }));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new UImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
    });
    expect(reads).toHaveBeenCalledTimes(2); // header and bounded table, no payload scan
  } finally {
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

it("does not complete paused inventory after its reader closes", async () => {
  const reader = new UImageArtifactReader(
    await fixture(
      buildUImage({
        type: 4,
        payload: buildMultiPayload([Buffer.from("a"), Buffer.from("b")]),
      }),
    ),
  );
  const iterator = reader.entries()[Symbol.asyncIterator]();
  try {
    expect((await iterator.next()).done).toBe(false);
    await reader.close();
    await expect(iterator.next()).rejects.toMatchObject({
      reason: "unavailable",
    });
  } finally {
    await reader.close();
  }
});

it.each(["cancel", "close"] as const)(
  "retires fully buffered, unconsumed member bytes on %s",
  async (action) => {
    const reader = new UImageArtifactReader(await fixture(buildUImage()));
    const controller = new AbortController();
    const reason = new Error("cancel buffered member");
    try {
      const [entry] = await entries(reader);
      const stream = await reader.open(entry!, controller.signal);
      await finished(stream, { readable: false, cleanup: true });
      await setImmediate();
      expect(stream.readableLength).toBeGreaterThan(0);
      if (action === "cancel") controller.abort(reason);
      else await reader.close();
      await expect(buffer(stream)).rejects.toMatchObject(
        action === "cancel"
          ? { reason: "cancelled", cause: reason }
          : { reason: "unavailable" },
      );
      expect(stream.destroyed).toBe(true);
    } finally {
      await reader.close();
    }
  },
);

it("joins a member's outstanding positional read before descriptor closure", async () => {
  const path = await fixture(buildUImage());
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new UImageArtifactReader(path, admitted);
  const reached = createDeferred<void>(),
    release = createDeferred<void>();
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  const reads = vi.spyOn(admitted.handle, "read");
  let outcome: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const [entry] = await entries(reader);
    reads.mockImplementation((async (...args: unknown[]) => {
      reached.resolve();
      await release.promise;
      return Reflect.apply(nativeRead, admitted.handle, args);
    }) as typeof admitted.handle.read);
    const stream = await reader.open(entry!);
    outcome = buffer(stream).then(
      () => ({ ok: true }),
      (cause: unknown) => ({ ok: false, cause }),
    );
    await awaitAcknowledgement(
      reached.promise,
      outcome,
      "member positional read",
    );
    let closed = false;
    closing = reader.close().then(() => {
      closed = true;
    });
    await setImmediate();
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    expect(stream.closed).toBe(true);
  } finally {
    release.resolve();
    await outcome;
    await closing;
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

it("retains failed descriptor cleanup for retry", async () => {
  const reader = new UImageArtifactReader(await fixture(buildUImage()));
  const [entry] = await entries(reader);
  const stream = await reader.open(entry!);
  const failure = new Error("uImage close denied");
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValueOnce(failure);
  try {
    await expect(reader.close()).rejects.toBe(failure);
    await expect(reader.open(entry!)).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(stream.closed).toBe(true);
    await reader.close();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    close.mockRestore();
    await reader.close();
  }
});

it.each(["cancel", "cancel-with-validation-error", "close"] as const)(
  "joins final freshness validation during %s",
  async (action) => {
    const path = await fixture(buildUImage());
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    const reader = new UImageArtifactReader(path, admitted);
    const reached = createDeferred<void>(),
      release = createDeferred<void>();
    const nativeStat = admitted.handle.stat.bind(admitted.handle);
    const nativeRead = admitted.handle.read.bind(admitted.handle);
    const reads = vi.spyOn(admitted.handle, "read");
    const stats = vi.spyOn(admitted.handle, "stat");
    const controller = new AbortController(),
      reason = new Error("cancel final validation");
    const validationFailure = new Error("final descriptor stat failed");
    let outcome: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const [entry] = await entries(reader);
      const memberEnd = BigInt(entry!.byteOffset! + entry!.declaredSize!);
      let memberReadComplete = false;
      reads.mockImplementation((async (...args: unknown[]) => {
        const result = (await Reflect.apply(
          nativeRead,
          admitted.handle,
          args,
        )) as {
          bytesRead: number;
          buffer: Buffer;
        };
        if (typeof args[3] === "bigint")
          memberReadComplete = args[3] + BigInt(result.bytesRead) === memberEnd;
        return result;
      }) as typeof admitted.handle.read);
      stats.mockImplementation((async (...args: unknown[]) => {
        const result = await Reflect.apply(nativeStat, admitted.handle, args);
        if (memberReadComplete) {
          memberReadComplete = false;
          reached.resolve();
          await release.promise;
          if (action === "cancel-with-validation-error")
            throw validationFailure;
        }
        return result;
      }) as typeof admitted.handle.stat);
      const stream = await reader.open(entry!, controller.signal);
      outcome = buffer(stream).then(
        () => ({ ok: true }) as const,
        (cause: unknown) => ({ ok: false, cause }) as const,
      );
      await awaitAcknowledgement(
        reached.promise,
        outcome,
        "post-read freshness validation",
      );
      let closed = false;
      if (action !== "close") controller.abort(reason);
      else
        closing = reader.close().then(() => {
          closed = true;
        });
      await setImmediate();
      expect(closed).toBe(false);
      release.resolve();
      expect(await outcome).toMatchObject({
        ok: false,
        cause:
          action === "cancel-with-validation-error"
            ? validationFailure
            : action === "cancel"
              ? { reason: "cancelled", cause: reason }
              : { reason: "unavailable" },
      });
      await closing;
    } finally {
      release.resolve();
      await outcome;
      await closing;
      await reader.close();
      stats.mockRestore();
      reads.mockRestore();
      await admitted.handle.close();
    }
  },
);

it("rejects a source changed after its header and CRC were prepared", async () => {
  const bytes = buildUImage();
  const path = await fixture(bytes),
    reader = new UImageArtifactReader(path);
  try {
    const [entry] = await entries(reader);
    await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]));
    await expect(reader.open(entry!)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
});

it("checks a multi-chunk stored payload incrementally and preserves read cancellation", async () => {
  const bytes = buildUImage({ payload: Buffer.alloc(2 * 1024 * 1024, 0x61) });
  const path = await fixture(bytes);
  const reader = new UImageArtifactReader(path);
  try {
    const [entry] = await entries(reader);
    const controller = new AbortController(),
      reason = new Error("cancel member bytes");
    const stream = await reader.open(entry!, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(reason);
    await expect(iterator.next()).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect(
      (await buffer(await reader.open(entry!))).equals(bytes.subarray(64)),
    ).toBe(true);
  } finally {
    await reader.close();
  }
});
