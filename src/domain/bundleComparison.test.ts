import { describe, expect, it } from "vitest";

import {
  bundleComparisonResultSchema,
  compareBundles,
} from "./bundleComparison.js";
import { createEvidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import {
  createResidualUnknown,
  recordUnknownInputSchema,
  updateResidualUnknown,
  updateUnknownInputSchema,
} from "./residualUnknown.js";

const PROVIDER = { id: "fixture", name: "Fixture", version: "1" } as const;
const evidence = (label: string) =>
  createEvidence(undefined, PROVIDER, {
    operation: "observe",
    parameters: { label },
    result: { label },
    confidence: "derived",
    authority: "analyst-inference",
  });

describe("bundle comparison", () => {
  it("returns unchanged only for equal canonical bundles", () => {
    const first = evidence("first");
    const second = evidence("second");
    const left = createEvidenceBundle([first, second]);
    const right = createEvidenceBundle([second, first]);
    const result = compareBundles(left, right);
    expect(bundleComparisonResultSchema.parse(result)).toMatchObject({
      status: "unchanged",
      summary: {
        records_unchanged: 2,
        records_added: 0,
        records_removed: 0,
        unresolved: 0,
      },
      changes: [],
    });
    expect(result.left_bundle_sha256).toBe(result.right_bundle_sha256);
  });

  it("classifies explicit pairs and returns every membership change inline", () => {
    const oldRecord = evidence("old");
    const newRecord = evidence("new");
    const removed = evidence("removed");
    const added = evidence("added");
    const left = createEvidenceBundle([oldRecord, removed]);
    const right = createEvidenceBundle([newRecord, added]);
    const pairs = [
      {
        left_evidence_id: oldRecord.evidence_id,
        right_evidence_id: newRecord.evidence_id,
      },
    ];
    const first = compareBundles(left, right, pairs);
    const repeated = compareBundles(left, right, pairs);
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      status: "changed",
      summary: {
        records_added: 1,
        records_removed: 1,
        records_changed: 1,
      },
      changes: expect.arrayContaining([
        expect.objectContaining({ classification: "changed" }),
      ]),
    });
    expect(first.changes).toHaveLength(3);
    expect(first.limitations).toContain(
      "One-sided membership proves only bundle inclusion or omission, not behavioral absence.",
    );
  });

  it("returns more than 500 changes without a display-page ceiling", () => {
    const records = Array.from({ length: 501 }, (_, index) =>
      evidence(`record-${String(index)}`),
    );
    const result = compareBundles(
      createEvidenceBundle([]),
      createEvidenceBundle(records),
    );
    expect(result.changes).toHaveLength(501);
    expect(bundleComparisonResultSchema.parse(result).changes).toHaveLength(
      501,
    );
  });

  it("rejects missing and non-bijective explicit pairs", () => {
    const leftRecord = evidence("left");
    const rightRecord = evidence("right");
    const left = createEvidenceBundle([leftRecord]);
    const right = createEvidenceBundle([rightRecord]);
    expect(() =>
      compareBundles(left, right, [
        {
          left_evidence_id: evidence("missing").evidence_id,
          right_evidence_id: rightRecord.evidence_id,
        },
      ]),
    ).toThrow(/missing left evidence/u);
    expect(() =>
      compareBundles(left, right, [
        {
          left_evidence_id: leftRecord.evidence_id,
          right_evidence_id: rightRecord.evidence_id,
        },
        {
          left_evidence_id: leftRecord.evidence_id,
          right_evidence_id: rightRecord.evidence_id,
        },
      ]),
    ).toThrow(/one-to-one/u);
    expect(() =>
      compareBundles({ ...left, records: [leftRecord, leftRecord] }, right),
    ).toThrow(/duplicate record IDs/u);
  });
});

describe("bundle comparison history", () => {
  it("distinguishes advanced and missing unknown histories from equality", () => {
    const mutationOne = evidence("mutation-one");
    const initial = createResidualUnknown(
      recordUnknownInputSchema.parse({
        approved: true,
        question: "Which branch remains unexplained?",
        severity: "high",
        domain: "comparison",
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        required_authority: "shipped-artifact",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      }),
      mutationOne.evidence_id,
      null,
    );
    const mutationTwo = evidence("mutation-two");
    const advanced = updateResidualUnknown(
      initial,
      updateUnknownInputSchema.parse({
        approved: true,
        unknown_id: initial.unknown_id,
        expected_revision: 1,
        status: "investigating",
        severity: initial.severity,
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        required_authority: initial.required_authority,
        required_confidence: initial.required_confidence,
        required_environment: null,
        recommended_probes: [],
        relationships: [],
        resolution: null,
      }),
      mutationTwo.evidence_id,
    );
    const initialBundle = createEvidenceBundle([mutationOne], [initial]);
    const advancedBundle = createEvidenceBundle(
      [mutationOne, mutationTwo],
      [initial, advanced],
    );
    expect(compareBundles(initialBundle, advancedBundle)).toMatchObject({
      status: "changed",
      summary: { unknowns_advanced: 1, unresolved: 0 },
      changes: [
        expect.objectContaining({
          entity: "evidence",
          classification: "added",
        }),
        expect.objectContaining({
          entity: "residual_unknown",
          classification: "history_advanced",
        }),
      ],
    });
    const absent = createEvidenceBundle([]);
    const missing = compareBundles(initialBundle, absent);
    expect(missing).toMatchObject({
      status: "unknown",
      summary: { unknowns_removed: 1, unresolved: 1 },
    });
    expect(missing.changes).toContainEqual(
      expect.objectContaining({
        classification: "removed",
        conclusion_kind: "unresolved_branch",
        limitations: [
          "A missing unknown history does not establish resolution.",
        ],
      }),
    );
  });
});
