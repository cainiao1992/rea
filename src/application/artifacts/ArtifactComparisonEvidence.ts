import {
  resolveEvidenceInput,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { inspectAnalysisViewValidated } from "../analysisView/AnalysisViewService.js";
import {
  artifactInventorySummaryViewResultSchema,
  sealAnalysisView,
} from "../../domain/analysisView/analysisView.js";
import {
  EvidenceIntegrityError,
  EvidenceReferenceError,
} from "../../domain/evidenceErrors.js";
import {
  evidenceSemanticContent,
  rebindEvidenceToTargetPath,
  type Evidence,
} from "../../domain/evidence.js";
import { readEvidence } from "../../domain/evidenceValidation.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import { ARTIFACT_INVENTORY_VIEW_CAVEATS } from "../../domain/analysisView/artifactInventoryViewCaveats.js";
import { err, ok, type Result } from "../../domain/result.js";

/**
 * Resolve an already-authenticated artifact summary's exact retained owner.
 * The caller must authenticate the supplied Evidence before invoking this helper.
 */
export const resolveArtifactComparisonEvidence = (
  evidence: Evidence,
  evidenceById: EvidenceLookup | undefined,
): Result<Evidence, AnalysisError> => {
  if (evidence.operation !== "inspect_analysis_view") return ok(evidence);

  const summary = artifactInventorySummaryViewResultSchema.safeParse(
    evidence.normalized_result,
  );
  if (!summary.success)
    return err(
      new AnalysisInputError("compare_artifacts", undefined, [
        {
          path: ["evidence"],
          reason: "invalid_value",
          message:
            "Artifact comparison accepts only an artifact inventory summary from inspect_analysis_view.",
        },
      ]),
    );

  const parentId = summary.data.parent_evidence_id;
  const parent = evidenceById?.(parentId);
  if (parent === undefined)
    return err(
      new EvidenceReferenceError(
        parentId,
        "missing",
        "retained complete artifact inventory Evidence",
        null,
      ),
    );
  const selected = resolveEvidenceInput(
    { kind: "retained-evidence", evidence_id: parentId },
    () => parent,
  );
  if (!selected.ok) return selected;
  const authenticated = readEvidence(selected.value);
  if (!authenticated.ok) return authenticated;
  const owner = authenticated.value;
  const subject = evidence.subject;
  if (
    subject === null ||
    owner.subject === null ||
    subject.digest.sha256 !== owner.subject.digest.sha256 ||
    subject.format !== owner.subject.format ||
    subject.architecture !== owner.subject.architecture
  )
    return mismatch();
  // The ledger preserves its original display path; summary delivery may use a
  // later caller-selected alias for this same authenticated owner identity.
  const presentation = rebindEvidenceToTargetPath(owner, {
    path: summary.data.artifact.path,
    sha256: subject.digest.sha256,
    format: subject.format,
    ...(subject.architecture === null
      ? {}
      : { architecture: subject.architecture }),
  });
  const reprojected = inspectAnalysisViewValidated(
    {
      source: { kind: "retained-evidence", evidence_id: parentId },
      view: { kind: "summary" },
    },
    (evidenceId) => (evidenceId === parentId ? presentation : undefined),
  );
  if (!reprojected.ok) return reprojected;
  if (!summaryProjectionIds(reprojected.value).includes(evidence.evidence_id))
    return mismatch();
  return ok(owner);
};

const mismatch = (): Result<never, EvidenceIntegrityError> =>
  err(
    new EvidenceIntegrityError(
      "Artifact summary does not match its retained parent inventory.",
    ),
  );

/** Exact shipped projections, rather than arbitrary omission or prose tolerance. */
const summaryProjectionIds = (current: Evidence): readonly string[] => {
  const result = artifactInventorySummaryViewResultSchema.parse(
    current.normalized_result,
  );
  const format = result.summary.manifest.root_format;
  if (
    format === "godot-pck" ||
    format === "pyinstaller" ||
    format === "node-sea"
  )
    return [current.evidence_id];
  const { view_digest: _digest, ...projection } = result;
  // b395190e4 began disclosing unavailable hashes for ordinary root formats.
  const beforeHashDisclosure = {
    ...projection,
    unknowns: projection.unknowns.filter(
      (value) => value !== ARTIFACT_INVENTORY_VIEW_CAVEATS.unknownContentHashes,
    ),
  };
  // ce1f4b1bb began carrying traversal coverage and its caveat for these roots.
  const { source_coverage: _coverage, ...summary } = projection.summary;
  const beforeTraversalDisclosure = {
    ...beforeHashDisclosure,
    summary,
    unknowns: beforeHashDisclosure.unknowns.filter(
      (value) => value !== ARTIFACT_INVENTORY_VIEW_CAVEATS.unknownTraversal,
    ),
  };
  return [
    current.evidence_id,
    ...[beforeHashDisclosure, beforeTraversalDisclosure].map(
      (variant) =>
        `ev_${digestCanonicalValue(
          evidenceSemanticContent({
            ...current,
            normalized_result: artifactInventorySummaryViewResultSchema.parse(
              sealAnalysisView(variant),
            ),
          }),
          "Evidence",
        )}`,
    ),
  ];
};
