import { expect, it } from "vitest";
import { z } from "zod";
import {
  freezeOwnedJsonTreeSnapshot,
  isImmutableJsonSnapshot,
} from "../immutableJson.js";
import type { AnalysisViewParent } from "./analysisView.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";

const parent = (normalizedResult: unknown): AnalysisViewParent => ({
  evidenceId: `ev_${"a".repeat(64)}`,
  operation: "inspect_python_pyc",
  normalizedResult,
  sealedResult: true,
  limitations: [],
});

it("does not trust a caller's sealed flag or shallow freeze for mutable facts", () => {
  const item = { value: "valid" };
  const source = Object.freeze({ items: [item] });
  const read = createAnalysisViewResultReader(
    z.strictObject({
      items: z.array(z.strictObject({ value: z.literal("valid") })),
    }),
  );
  expect(read(parent(source)).ok).toBe(true);
  item.value = "changed";
  expect(read(parent(source)).ok).toBe(false);
});

it("keeps schema-specific normalized facts separate without mutating sealed source", () => {
  const source = freezeOwnedJsonTreeSnapshot({});
  const first = createAnalysisViewResultReader(
    z.strictObject({
      value: z.string().default("first"),
    }),
  );
  const second = createAnalysisViewResultReader(
    z.strictObject({
      value: z.string().default("second"),
    }),
  );
  const a = first(parent(source));
  const b = second(parent(source));
  expect(a).toEqual({ ok: true, value: { value: "first" } });
  expect(b).toEqual({ ok: true, value: { value: "second" } });
  expect(source).toEqual({});
  if (a.ok && b.ok) {
    expect(isImmutableJsonSnapshot(a.value)).toBe(true);
    expect(isImmutableJsonSnapshot(b.value)).toBe(true);
  }
});
