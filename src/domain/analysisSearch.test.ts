import { expect, it } from "vitest";

import { literalSubstringPredicate } from "./analysisSearch.js";

it("uses Unicode simple case folding for literal substrings", () => {
  const matchesSigma = literalSubstringPredicate("Σ", false);
  expect(matchesSigma("ΟΣ")).toBe(true);
  expect(matchesSigma("ος")).toBe(true);
  expect(matchesSigma("unrelated")).toBe(false);
  expect(literalSubstringPredicate("Σ", true)("ος")).toBe(false);
  expect(literalSubstringPredicate("A.B", false)("a.b")).toBe(true);
  expect(literalSubstringPredicate("A.B", false)("axb")).toBe(false);
});
