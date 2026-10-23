import {
  resolveEvidenceInput,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import type { EvidenceReader } from "./InvestigationRecordPort.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import { uniqueSorted } from "../../domain/canonicalOrdering.js";
import type { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { ok, type Result } from "../../domain/result.js";

type InvestigationLookup = Pick<
  EvidenceReader,
  "evidenceForAnalysis" | "evidenceById"
>;

/** Prefer owned immutable records; detached-only readers retain their contract. */
export const investigationEvidenceLookup =
  (reader: InvestigationLookup): EvidenceLookup =>
  (id) =>
    reader.evidenceForAnalysis?.(id) ?? reader.evidenceById(id);

/** Borrow the owner's immutable snapshot for read-only projection or delivery. */
export const investigationEvidenceBundle = (
  reader: Pick<
    EvidenceReader,
    "immutableEvidenceBundle" | "exportEvidenceBundle"
  >,
): EvidenceBundle =>
  reader.immutableEvidenceBundle?.() ?? reader.exportEvidenceBundle();

/** Follow exact session references without exporting unrelated records or Unknowns. */
export const resolveInvestigationEvidenceClosure = (
  reader: InvestigationLookup,
  seedIds: readonly string[],
): Result<string[], EvidenceIntegrityError> => {
  const lookup = investigationEvidenceLookup(reader);
  const visited = new Set<string>();
  const pending = [...seedIds];
  while (pending.length > 0) {
    const evidenceId = pending.pop();
    if (evidenceId === undefined || visited.has(evidenceId)) continue;
    const evidence = resolveEvidenceInput(
      { kind: "retained-evidence", evidence_id: evidenceId },
      lookup,
    );
    if (!evidence.ok) return evidence;
    visited.add(evidenceId);
    pending.push(...evidence.value.evidence_links);
  }
  return ok(uniqueSorted([...visited]));
};
