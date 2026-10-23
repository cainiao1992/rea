import { expect, it } from "vitest";

import { decodeMarshalUtf8 } from "./marshalUtf8.js";

it.each([
  ["efbbbfeda080efbbbfedbfbfefbbbf", "\ufeff\ud800\ufeff\udfff\ufeff"],
  ["ed9fbfeda080ee8080", "\ud7ff\ud800\ue000"],
  ["f0908080eda080f48fbfbf", "\ud800\udc00\ud800\udbff\udfff"],
  ["eda080edbfbf", "\ud800\udfff"],
  ["616263eda080646566edbfbf676869", "abc\ud800def\udfffghi"],
])(
  "preserves ordinary UTF-8 spans around marshal surrogates (%s)",
  (hex, value) => {
    expect(decodeMarshalUtf8(Buffer.from(hex, "hex"))).toEqual({
      ok: true,
      value,
    });
  },
);

it.each([
  "c2eda080",
  "e282eda080",
  "f09080eda080",
  "80eda080",
  "eda08080",
  "eda080c2",
  "eda080e08080",
  "eda080f4908080",
  "eda080eda0",
  "eda0eda080",
])("does not hide malformed bytes beside a marshal surrogate (%s)", (hex) => {
  expect(decodeMarshalUtf8(Buffer.from(hex, "hex"))).toEqual({
    ok: false,
    error: { kind: "invalid-marshal-utf8" },
  });
});
