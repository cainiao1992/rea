import { expect, it } from "vitest";

import {
  CANONICAL_BASE64_PATTERN,
  IDENTIFIER_PATTERN,
  PADDED_BASE64_PATTERN,
  STABLE_IDENTIFIER_PATTERN,
} from "./stringPatterns.js";

it("preserves identifier grammars under Unicode and Unicode-set compilation", () => {
  const variants = [
    { pattern: IDENTIFIER_PATTERN, previous: /^[A-Za-z][A-Za-z0-9._-]*$/u },
    {
      pattern: STABLE_IDENTIFIER_PATTERN,
      previous: /^[A-Za-z][A-Za-z0-9._:/-]*$/u,
    },
  ];
  const samples = [
    "",
    "a",
    "A",
    "_id",
    "1id",
    "é",
    "aé",
    "a/b:c",
    "a-b.c_1",
    "a\n",
    "a\\b",
  ];
  for (let code = 0; code < 128; code += 1) {
    const character = String.fromCharCode(code);
    samples.push(character, `A${character}`, `A${character}B`);
  }
  for (const { pattern, previous } of variants) {
    for (const flag of ["u", "v"]) {
      const projected = new RegExp(pattern.source, flag);
      for (const sample of samples)
        expect(projected.test(sample), JSON.stringify({ flag, sample })).toBe(
          previous.test(sample),
        );
    }
  }
});

it("preserves canonical base64 padding and pad-bit validation", () => {
  const previous =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;
  const samples = [
    "",
    "AA==",
    "AB==",
    "AAA=",
    "AAB=",
    "////",
    "A",
    "AA",
    "AAA",
    "====",
    "AA==\n",
    "AA==\r\n",
    "AA==\u2028",
    "AA==\u2029",
    "AA\nAA",
    "AA=\n=",
    "AA-_",
    "a b c",
  ];
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const first of alphabet)
    for (const second of alphabet)
      samples.push(`${first}${second}==`, `A${first}${second}=`);
  for (const flag of ["u", "v"]) {
    const projected = new RegExp(CANONICAL_BASE64_PATTERN.source, flag);
    for (const sample of samples)
      expect(projected.test(sample), JSON.stringify({ flag, sample })).toBe(
        previous.test(sample),
      );
  }
});

it("validates large canonical base64 under JSON Schema Unicode modes", () => {
  // Near the 32 MiB capture input budget: a quartet expansion alone still
  // overflows at this size, especially in Unicode-set client validators.
  const body = Buffer.alloc(24 * 1024 * 1024 - 3, 0x81);
  const encoded = body.toString("base64");
  for (const flag of ["", "u", "v"]) {
    const pattern = new RegExp(CANONICAL_BASE64_PATTERN.source, flag);
    expect(pattern.test(encoded), flag).toBe(true);
    expect(pattern.test(`${encoded.slice(0, -1)}!`), flag).toBe(false);
    expect(pattern.test(`${encoded.slice(0, -3)}R==`), flag).toBe(false);
    expect(pattern.test(`${encoded}A`), flag).toBe(false);
    const padded = new RegExp(PADDED_BASE64_PATTERN.source, flag);
    expect(padded.test(encoded), flag).toBe(true);
    expect(padded.test(`${encoded.slice(0, -1)}!`), flag).toBe(false);
  }
});
