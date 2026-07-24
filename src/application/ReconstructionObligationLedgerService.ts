import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import {
  reconstructionObligationLedgerInputSchema,
  reconstructionObligationLedgerPageSchema,
  type ReconstructionObligationLedgerInput,
  type ReconstructionObligationLedgerPage,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";
import { deriveReconstructionObligationCandidates } from "./ReconstructionObligationCandidates.js";
import { evaluateReconstructionObligationLedger } from "./ReconstructionObligationLedgerEvaluation.js";

const OPERATION = "build_reconstruction_obligation_ledger" as const;

/** Parse one portable ledger request for both CLI and MCP adapters. */
export const resolveReconstructionObligationLedgerRequest = (
  input: unknown,
): Result<ReconstructionObligationLedgerInput, AnalysisError> => {
  const parsed = reconstructionObligationLedgerInputSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
};

/** Build one deterministic ledger page and wrap it in portable Evidence v2. */
export const buildReconstructionObligationLedgerEvidenceValidated = (
  input: ReconstructionObligationLedgerInput,
): Result<Evidence, AnalysisError> => {
  try {
    const generated = deriveReconstructionObligationCandidates(
      input.evidence_bundle,
      input.reviewed_obligations,
    );
    const ledger = evaluateReconstructionObligationLedger({
      candidates: generated.candidates,
      bundle: input.evidence_bundle,
      manifest: input.manifest,
      maxObligations: input.limits.max_obligations,
      generationLimitations: generated.limitations,
    });
    const page = pageLedger(ledger, input.page.offset, input.page.limit);
    return ok(createLedgerEvidence(input, page));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(new AnalysisInputError(OPERATION, { cause }));
    return err(
      new AnalysisProtocolError(
        "Reconstruction obligation ledger generation failed",
        { cause },
      ),
    );
  }
};

const pageLedger = (
  ledger: ReturnType<typeof evaluateReconstructionObligationLedger>,
  offset: number,
  limit: number,
): ReconstructionObligationLedgerPage => {
  const obligations = ledger.obligations.slice(offset, offset + limit);
  const nextOffset =
    offset + obligations.length < ledger.obligations.length
      ? offset + obligations.length
      : null;
  const { obligations: _allObligations, ...summary } = ledger;
  return reconstructionObligationLedgerPageSchema.parse({
    ...summary,
    page: {
      offset,
      limit,
      total: ledger.obligations.length,
      returned: obligations.length,
      next_offset: nextOffset,
    },
    obligations,
  });
};

const createLedgerEvidence = (
  input: ReconstructionObligationLedgerInput,
  page: ReconstructionObligationLedgerPage,
): Evidence =>
  createEvidence(undefined, JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER, {
    predicateType: "rea.reconstruction-obligation-ledger/v1",
    operation: OPERATION,
    parameters: jsonObjectSchema.parse({
      ledger_id: page.ledger_id,
      closure_digest: page.closure_digest,
      limits: input.limits,
      page: input.page,
    }),
    result: jsonValueSchema.parse(page),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: page.limitations,
    evidenceLinks: page.evidence_links,
  });
