import { expect, it } from "vitest";
import {
  mappedFileOffset,
  readMappedCString,
  type BinaryContainer,
} from "./BinaryContainer.js";

const mappings = [
  { address: 100n, offset: 0, size: 4 },
  { address: 104n, offset: 4, size: 4 },
];
it("maps a span crossing adjacent ranges with one consistent file translation", () => {
  expect(mappedFileOffset(mappings, 102n, 4)).toBe(2);
  expect(mappedFileOffset(mappings, 108n, 0)).toBe(8);
});
it.each(
  [
    [{ address: 105n, offset: 5, size: 3 }],
    [{ address: 104n, offset: 7, size: 4 }],
    [...mappings, { address: 103n, offset: 7, size: 2 }],
  ].map((ranges) => [ranges] as const),
)(
  "refuses gaps or inconsistent translations across the selected span",
  (ranges) => {
    expect(() =>
      mappedFileOffset([mappings[0]!, ...ranges], 102n, 4),
    ).toThrow();
  },
);
it("refuses a zero-fill alias inside a span spanning multiple mappings", () => {
  expect(() =>
    mappedFileOffset(mappings, 102n, 4, [{ address: 104n, size: 1n }]),
  ).toThrow(/zero-fill/);
});
it("reads strings across discontiguous source ranges without examining bytes after NUL", () => {
  const image: BinaryContainer = {
    format: "pe",
    architecture: "amd64",
    bits: 64,
    byte_order: "little",
    pe_header_mapping: mappings[0]!,
    mappings: [{ address: 104n, offset: 8, size: 4 }],
    zero_fills: [{ address: 106n, size: 2n }],
    sections: [],
  };
  expect(
    readMappedCString(Buffer.from("ABCDxxxxE\0xx"), image, 102n, 8).toString(),
  ).toBe("CDE");
  expect(() =>
    mappedFileOffset([...mappings.slice(0, 1), ...image.mappings], 102n, 4),
  ).toThrow(/ambiguous/);
});
