import { describe, expect, it } from "vitest";
import {
  processTraceSpecificationSchema,
  type ProcessTraceSpecification,
} from "./processTraceSpecification.js";

const ready = { sequence: 0, at_ms: 10, data: "ready" };
const worker = {
  at_ms: 20,
  pid: 1,
  parent_pid: 0,
  command: "worker",
  process_group_id: 1,
  session_id: 1,
};
const specification = (): ProcessTraceSpecification => ({
  events: [
    {
      id: "ready",
      source: "terminal_raw",
      exact: ready,
      cardinality: { kind: "required" },
    },
    {
      id: "worker",
      source: "process",
      exact: worker,
      cardinality: { kind: "required" },
    },
  ],
  language: {
    kind: "partial_order",
    happens_before: [{ before: "ready", after: "worker" }],
    not_before: [],
    unordered_groups: [],
    prefix: ["ready"],
    suffix: ["worker"],
  },
});

describe("process trace specification", () => {
  it("reports independent declaration errors alongside a cycle", () => {
    const base = specification();
    const result = processTraceSpecificationSchema.safeParse({
      ...base,
      language: {
        ...base.language,
        happens_before: [
          { before: "ready", after: "worker" },
          { before: "worker", after: "ready" },
        ],
        not_before: [{ event: "missing", anchor: "ready" }],
        unordered_groups: [{ events: ["missing", "missing"] }],
        prefix: ["missing"],
        suffix: ["missing"],
      },
    });
    if (result.success) throw new Error("Expected invalid trace declarations");
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "happens-before graph must be acyclic",
        }),
        expect.objectContaining({
          path: ["language", "not_before", 0, "event"],
        }),
        expect.objectContaining({
          path: ["language", "unordered_groups", 0, "events"],
        }),
        expect.objectContaining({ path: ["language", "prefix", 0] }),
        expect.objectContaining({ path: ["language", "suffix", 0] }),
      ]),
    );
  });

  it("accepts an acyclic order with shared successors and explicit unordered peers", () => {
    const result = processTraceSpecificationSchema.parse({
      events: ["a", "b", "c", "d"].map((id) => ({
        id,
        source: "lifecycle",
        exact: { marker: id },
      })),
      language: {
        kind: "partial_order",
        happens_before: [
          { before: "a", after: "b" },
          { before: "a", after: "c" },
          { before: "b", after: "d" },
          { before: "c", after: "d" },
        ],
        unordered_groups: [{ events: ["b", "c"] }],
        prefix: ["a"],
        suffix: ["d"],
      },
    });
    expect(result.language.kind).toBe("partial_order");
  });

  it("counts only undeclared pairs after transitive, not-before and unordered relations", () => {
    const events = ["a", "b", "c", "d"].map((id) => ({
      id,
      source: "lifecycle" as const,
      exact: { fixture: id },
      cardinality: { kind: "optional" as const },
    }));
    const result = processTraceSpecificationSchema.safeParse({
      events,
      language: {
        kind: "partial_order",
        happens_before: [
          { before: "a", after: "b" },
          { before: "b", after: "c" },
        ],
        not_before: [{ event: "d", anchor: "c" }],
        unordered_groups: [{ events: ["a", "d"] }],
      },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the missing b/d relation");
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ["language"],
        message: "event pair b/d must be explicitly ordered or unordered",
      }),
    ]);
  });

  it("reports one duplicate-pair diagnostic per overlapping group", () => {
    const result = processTraceSpecificationSchema.safeParse({
      events: ["z", "a", "b"].map((id) => ({
        id,
        source: "lifecycle",
        exact: { fixture: id },
        cardinality: { kind: "optional" },
      })),
      language: {
        kind: "partial_order",
        unordered_groups: [
          { events: ["z", "a", "b"] },
          { events: ["b", "a", "z"] },
        ],
      },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected a duplicate unordered pair");
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ["language", "unordered_groups", 1],
        message: "unordered event pairs must be declared once",
      }),
    ]);
  });

  it("rejects invalid ignores and unsatisfiable variants", () => {
    const base = specification();
    expect(
      processTraceSpecificationSchema.safeParse({
        events: [
          {
            id: "bad",
            source: "terminal_raw",
            exact: "ready",
            ignore_fields: ["at_ms"],
          },
        ],
        language: {
          kind: "finite_traces",
          variants: [{ id: "one", trace: ["bad"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      processTraceSpecificationSchema.safeParse({
        events: [
          {
            ...base.events[0],
            cardinality: { kind: "exact", count: 2 },
          },
        ],
        language: {
          kind: "finite_traces",
          variants: [{ id: "once", trace: ["ready"] }],
        },
      }).success,
    ).toBe(false);
  });
});
