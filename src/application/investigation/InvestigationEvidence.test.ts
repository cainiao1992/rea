import { expect, it } from "vitest";

import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import { InvestigationRecords } from "./InvestigationRecords.js";
import {
  investigationEvidenceBundle,
  investigationEvidenceLookup,
  resolveInvestigationEvidenceClosure,
} from "./InvestigationEvidence.js";

const observation = (path: string, links: readonly string[] = []): Evidence =>
  createEvidence(
    { path, sha256: "a".repeat(64), format: "elf" },
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "observe",
      parameters: {},
      result: { value: "observed" },
      evidenceLinks: [...links],
    },
  );

it.each(["immutable", "detached"] as const)(
  "reads current metadata through a %s reader while preserving earlier snapshots",
  (mode) => {
    const records = new InvestigationRecords();
    const first = observation("/original");
    const added = records.recordEvidence(first);
    if (!added.ok) throw added.error;
    const reader =
      mode === "immutable"
        ? records
        : {
            evidenceById: records.evidenceById.bind(records),
            exportEvidenceBundle: records.exportEvidenceBundle.bind(records),
          };
    const lookup = investigationEvidenceLookup(reader);
    const snapshot = investigationEvidenceBundle(reader);
    const replacement = observation("/moved");
    expect(replacement.evidence_id).toBe(first.evidence_id);
    const merged = records.mergeEvidenceBundle(
      createEvidenceBundle([replacement]),
    );
    if (!merged.ok) throw merged.error;
    expect(merged.value.replacements).toEqual([
      { kind: "subject-display", previous: first, current: replacement },
    ]);
    expect(lookup(first.evidence_id)?.subject?.local_path).toBe("/moved");
    expect(
      investigationEvidenceBundle(reader).records[0]?.subject?.local_path,
    ).toBe("/moved");
    expect(snapshot.records[0]?.subject?.local_path).toBe("/original");
    if (mode === "immutable") {
      expect(Object.isFrozen(snapshot.records[0]?.subject)).toBe(true);
    } else {
      const subject = snapshot.records[0]?.subject;
      if (subject === undefined || subject === null)
        throw new Error("Expected detached subject");
      subject.local_path = "/caller-edited";
      expect(lookup(first.evidence_id)?.subject?.local_path).toBe("/moved");
    }
    records.clear();
    expect(lookup(first.evidence_id)).toBeUndefined();
    expect(investigationEvidenceBundle(reader).records).toEqual([]);
    expect(snapshot.records).toHaveLength(1);
  },
);

it("keeps a selected transitive closure distinct from unrelated records and rejects a missing dependency", () => {
  const records = new InvestigationRecords();
  const leaf = observation("/leaf");
  const middle = observation("/middle", [leaf.evidence_id]);
  const root = observation("/root", [middle.evidence_id, leaf.evidence_id]);
  const unrelated = observation("/unrelated", [root.evidence_id]);
  for (const record of [leaf, middle, root, unrelated]) {
    const added = records.recordEvidence(record);
    if (!added.ok) throw added.error;
  }
  expect(
    resolveInvestigationEvidenceClosure(records, [root.evidence_id]),
  ).toEqual({
    ok: true,
    value: [leaf.evidence_id, middle.evidence_id, root.evidence_id].sort(),
  });
  records.clear();
  const added = records.recordEvidence(root);
  if (!added.ok) throw added.error;
  expect(
    resolveInvestigationEvidenceClosure(records, [root.evidence_id]),
  ).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError" },
  });
});

it("rejects a lookup that returns another semantic Evidence identity", () => {
  const record = observation("/source");
  const selectedId = `ev_${"0".repeat(64)}`;
  expect(
    resolveInvestigationEvidenceClosure({ evidenceById: () => record }, [
      selectedId,
    ]),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      reason: "identity_mismatch",
      evidenceId: selectedId,
      actual: record.evidence_id,
    },
  });
});
