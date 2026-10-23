import { expect, it } from "vitest";
import { readGoBinaryImage } from "../../go/GoBinaryImage.js";
import { readPeImage } from "./PeImage.js";
import { pe } from "../../domain/binaryTarget.fixture.js";
import { BinaryFormatFailure } from "./BinaryContainer.js";
import {
  createGoBinaryFixture,
  setGoPeVirtualSize,
} from "../../../tests/fixtures/go/image.js";

it("classifies a confirmed overlapping PE as an unsupported layout", () => {
  try {
    readPeImage(pe(0x014c, 4));
    throw new Error("Expected an unsupported PE layout");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BinaryFormatFailure);
    expect(cause).toMatchObject({ kind: "unsupported" });
    expect((cause as Error).message).toContain("overlapping PE header");
  }
});

it("keeps a DOS-valid but unsigned Windows-header candidate unresolved", () => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt16LE(128, 2);
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(2, 6);
  bytes.writeUInt16LE(4, 8);
  bytes.writeUInt16LE(28, 24);
  bytes.write("ABCD", 60, "ascii");
  expect(() => readPeImage(bytes)).toThrow(
    "MZ Windows new-header candidate is unresolved",
  );
});

it.each([32, 64] as const)(
  "uses raw-size fallback for PE%d Go build-info and keeps RVA mappings intact",
  (bits) => {
    for (const encoding of ["inline", "pointer"] as const) {
      const fixture = createGoBinaryFixture({ format: "pe", bits, encoding });
      const expected = readGoBinaryImage(fixture.bytes).build_info;
      expect(expected).not.toBeNull();
      setGoPeVirtualSize(fixture.bytes, 0);

      const container = readPeImage(fixture.bytes);
      expect(container.sections[0]).toMatchObject({
        name: ".data",
        offset: 1024,
        size: 2048,
        file_backed: true,
      });
      expect(container.mappings[0]).toMatchObject({
        address: 0x10400n,
        offset: 1024,
        size: 2048,
      });
      expect(container.sections[0]).toMatchObject({
        virtual_address: 0x400,
        virtual_size: 0,
        raw_size: 2048,
        characteristics: 0xc0000040,
      });
      expect(container).not.toHaveProperty("data_ranges");
      expect(container.image_base).toBe(0x10000n);
      expect(container.executable_mappings).toEqual([]);
      expect(readGoBinaryImage(fixture.bytes).build_info).toEqual(expected);
    }
  },
);

it("keeps Go fallback candidates when a PE section has no printable name", () => {
  const fixture = createGoBinaryFixture({ format: "pe", bits: 64 });
  const expected = readGoBinaryImage(fixture.bytes).build_info;
  const pe = fixture.bytes.readUInt32LE(0x3c);
  const section = pe + 24 + fixture.bytes.readUInt16LE(pe + 20);
  fixture.bytes.fill(0, section, section + 8);

  const container = readPeImage(fixture.bytes);
  expect(container.sections[0]).toMatchObject({
    name: "",
    characteristics: 0xc0000040,
  });
  expect(readGoBinaryImage(fixture.bytes).build_info).toEqual(expected);
});

it.each(["inline", "pointer"] as const)(
  "does not search PE raw alignment padding beyond a nonzero VirtualSize (%s)",
  (encoding) => {
    const fixture = createGoBinaryFixture({ format: "pe", bits: 64, encoding });
    // Put an otherwise valid, aligned record in the raw-only tail.
    fixture.bytes.copy(
      fixture.bytes,
      fixture.headerOffset + 512,
      fixture.headerOffset,
      fixture.headerOffset + 512,
    );
    fixture.bytes.fill(0, fixture.headerOffset, fixture.headerOffset + 512);
    setGoPeVirtualSize(fixture.bytes, 512);

    const container = readPeImage(fixture.bytes);
    expect(container.sections[0]).toMatchObject({
      size: 512,
      file_backed: true,
    });
    expect(container.mappings[0]).toMatchObject({ size: 2048, offset: 1024 });
    expect(container.sections[0]).toMatchObject({
      size: 512,
      offset: 1024,
      virtual_size: 512,
      raw_size: 2048,
    });
    expect(container).not.toHaveProperty("data_ranges");
    expect(readGoBinaryImage(fixture.bytes).build_info).toBeNull();
  },
);
