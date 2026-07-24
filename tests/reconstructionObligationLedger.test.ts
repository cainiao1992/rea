import { describe, expect, it } from "vitest";

import { PROCESS_PROVIDER } from "../src/application/ProcessEvidence.js";
import {
  buildReconstructionObligationLedgerEvidenceValidated,
  resolveReconstructionObligationLedgerRequest,
} from "../src/application/ReconstructionObligationLedgerService.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../src/contracts/processCaptureExample.js";
import { createEvidence, type Evidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import { jsonValueSchema } from "../src/domain/jsonValue.js";
import { processCaptureSchema } from "../src/domain/processCapture.js";
import {
  reconstructionObligationLedgerPageSchema,
  serializeReconstructionObligationLedger,
  type ReconstructionObligationLedgerInput,
  type ReconstructionObligationLedgerPage,
  type ReviewedReconstructionObligation,
} from "../src/domain/reconstructionObligationLedgerSchemas.js";

const proofEvidence = (id: string) =>
  createEvidence(
    undefined,
    { id: `fixture-${id}`, name: "Fixture verifier", version: "1" },
    {
      predicateType: "rea.fixture-verification/v1",
      operation: "run_fixture_verifier",
      parameters: { id },
      result: { passed: true },
      confidence: "observed",
      authority: "controlled-replay",
    },
  );

const processEvidence = () =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture/v4",
    operation: "capture_process_scenario",
    parameters: {},
    result: jsonValueSchema.parse(
      processCaptureSchema.parse(EMPTY_PROCESS_CAPTURE_EXAMPLE),
    ),
    confidence: "observed",
    authority: "controlled-replay",
  });

const boundProofEvidence = (
  id: string,
  result: {
    readonly obligation_ids: readonly string[];
    readonly fixture_ids: readonly string[];
    readonly case_kinds: readonly string[];
    readonly verifier_ids: readonly string[];
    readonly claim_ids: readonly string[];
  },
  authority: "shipped-artifact" | "controlled-replay" = "controlled-replay",
) =>
  createEvidence(
    undefined,
    { id: `proof-${id}`, name: "Reconstruction proof", version: "1" },
    {
      predicateType: "rea.reconstruction-proof/v1",
      operation: "verify_reconstruction_obligations",
      parameters: {},
      result: {
        passed: true,
        obligation_ids: [...result.obligation_ids],
        fixture_ids: [...result.fixture_ids],
        case_kinds: [...result.case_kinds],
        verifier_ids: [...result.verifier_ids],
        claim_ids: [...result.claim_ids],
      },
      confidence: "observed",
      authority,
    },
  );

const request = (
  records: readonly Evidence[],
  overrides: Partial<ReconstructionObligationLedgerInput> = {},
): ReconstructionObligationLedgerInput => ({
  evidence_bundle: createEvidenceBundle(records),
  reviewed_obligations: [],
  manifest: { schema_version: 1, bindings: [], contradictions: [] },
  limits: { max_obligations: 100 },
  page: { offset: 0, limit: 50 },
  ...overrides,
});

const build = (
  input: ReconstructionObligationLedgerInput,
): ReconstructionObligationLedgerPage => {
  const parsed = resolveReconstructionObligationLedgerRequest(input);
  if (!parsed.ok) throw parsed.error;
  const result = buildReconstructionObligationLedgerEvidenceValidated(
    parsed.value,
  );
  if (!result.ok) throw result.error;
  return reconstructionObligationLedgerPageSchema.parse(
    result.value.normalized_result,
  );
};

const completeLedger = (
  page: ReconstructionObligationLedgerPage,
  obligations: ReconstructionObligationLedgerPage["obligations"],
) => {
  const { page: pagination, ...ledger } = page;
  if (pagination.total !== obligations.length)
    throw new TypeError("Incomplete obligation page set");
  return { ...ledger, obligations };
};

const originalCases = (
  obligation: ReconstructionObligationLedgerPage["obligations"][number],
  evidenceId: string,
) =>
  obligation.required_case_kinds.map((caseKind) => ({
    kind: caseKind,
    evidence_id: evidenceId,
    location: `/normalized_result/cases/${caseKind}`,
  }));

describe("reconstruction obligation ledger", () => {
  it("emits deterministic closure identity and paging", () => {
    const evidence = proofEvidence("review");
    const reviewed = [
      reviewedObligation("obl.review.one", evidence.evidence_id),
      reviewedObligation("obl.review.two", evidence.evidence_id),
    ];
    const first = build(
      request([evidence], {
        reviewed_obligations: reviewed,
        page: { offset: 0, limit: 1 },
      }),
    );
    const second = build(
      request([evidence], {
        reviewed_obligations: reviewed,
        page: { offset: 1, limit: 1 },
      }),
    );

    expect(first.page).toEqual({
      offset: 0,
      limit: 1,
      total: 2,
      returned: 1,
      next_offset: 1,
    });
    expect(second.page.next_offset).toBeNull();
    expect(second.ledger_id).toBe(first.ledger_id);
    expect(second.closure_digest).toBe(first.closure_digest);
    expect(first.obligations[0]?.source_state).toBe("reviewed");
    expect(first.status).toBe("open");
    expect(
      serializeReconstructionObligationLedger(
        completeLedger(first, [...first.obligations, ...second.obligations]),
      ),
    ).toBe(
      serializeReconstructionObligationLedger(
        completeLedger(second, [...first.obligations, ...second.obligations]),
      ),
    );
  });

  it("does not let green unit evidence close a packaged-process obligation", () => {
    const capture = processEvidence();
    const proof = proofEvidence("green-unit");
    const initial = build(request([capture, proof]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const unitBinding = {
      obligation_id: obligation.obligation_id,
      owner: {
        module_path: "src/processOwner.ts",
        symbol: "runProcess",
        owner_sha256: "1".repeat(64),
      },
      parser_type: null,
      original_cases: originalCases(obligation, capture.evidence_id),
      fixtures: obligation.required_case_kinds.map((caseKind) => ({
        fixture_id: `fixture.${caseKind}`,
        case_kind: caseKind,
        authority: "unit" as const,
        evidence_ids: [proof.evidence_id],
      })),
      verifier: {
        verifier_id: "verifier.unit",
        claim_id: "claim.process",
        command: "npm test -- processOwner",
        authority: "unit" as const,
        status: "pass" as const,
        result_evidence_id: proof.evidence_id,
        enumerated_obligation_ids: [obligation.obligation_id],
        nondeterminism: {
          mode: "total-order" as const,
          specification: "Exact unit-call order.",
        },
      },
    };

    const result = build(
      request([capture, proof], {
        manifest: {
          schema_version: 1,
          bindings: [unitBinding],
          contradictions: [],
        },
      }),
    );
    const evaluated = result.obligations[0];
    expect(evaluated?.status).toBe("implemented");
    expect(evaluated?.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "weak-fixture-authority",
        "weak-verifier-authority",
      ]),
    );
    expect(result.status).toBe("open");
  });

  it("keeps unobserved original cases open", () => {
    const capture = processEvidence();
    const proof = proofEvidence("packaged-original-gap");
    const initial = build(request([capture, proof]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const result = build(
      request([capture, proof], {
        manifest: {
          schema_version: 1,
          bindings: [
            {
              obligation_id: obligation.obligation_id,
              owner: {
                module_path: "src/processOwner.ts",
                symbol: "runProcess",
                owner_sha256: "4".repeat(64),
              },
              parser_type: null,
              original_cases: obligation.observed_cases,
              fixtures: obligation.required_case_kinds.map((caseKind) => ({
                fixture_id: `packaged.${caseKind}`,
                case_kind: caseKind,
                authority: "packaged-process",
                evidence_ids: [proof.evidence_id],
              })),
              verifier: {
                verifier_id: "verifier.packaged",
                claim_id: "claim.process",
                command: "npm run verify:package -- process",
                authority: "packaged-process",
                status: "pass",
                result_evidence_id: proof.evidence_id,
                enumerated_obligation_ids: [obligation.obligation_id],
                nondeterminism: {
                  mode: "partial-order",
                  specification:
                    "Startup precedes teardown; worker completion is unordered.",
                },
              },
            },
          ],
          contradictions: [],
        },
      }),
    );

    expect(result.obligations[0]?.status).toBe("implemented");
    expect(result.obligations[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-original-case",
          detail: expect.stringContaining("negative"),
        }),
        expect.objectContaining({
          code: "missing-original-case",
          detail: expect.stringContaining("cancellation"),
        }),
      ]),
    );
    expect(result.status).toBe("open");
  });

  it("closes only when every required case and verifier has comparable authority", () => {
    const capture = processEvidence();
    const initial = build(request([capture]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const fixtureIds = obligation.required_case_kinds.map(
      (caseKind) => `packaged.${caseKind}`,
    );
    const proof = boundProofEvidence("packaged", {
      obligation_ids: [obligation.obligation_id],
      fixture_ids: fixtureIds,
      case_kinds: obligation.required_case_kinds,
      verifier_ids: ["verifier.packaged"],
      claim_ids: ["claim.process"],
    });
    const result = build(
      request([capture, proof], {
        manifest: {
          schema_version: 1,
          bindings: [
            {
              obligation_id: obligation.obligation_id,
              owner: {
                module_path: "src/processOwner.ts",
                symbol: "runProcess",
                owner_sha256: "2".repeat(64),
              },
              parser_type: null,
              original_cases: originalCases(obligation, capture.evidence_id),
              fixtures: obligation.required_case_kinds.map((caseKind) => ({
                fixture_id: `packaged.${caseKind}`,
                case_kind: caseKind,
                authority: "packaged-process",
                evidence_ids: [proof.evidence_id],
              })),
              verifier: {
                verifier_id: "verifier.packaged",
                claim_id: "claim.process",
                command: "npm run verify:package -- process",
                authority: "packaged-process",
                status: "pass",
                result_evidence_id: proof.evidence_id,
                enumerated_obligation_ids: [obligation.obligation_id],
                nondeterminism: {
                  mode: "partial-order",
                  specification:
                    "Startup precedes teardown; worker completion is unordered.",
                },
              },
            },
          ],
          contradictions: [],
        },
      }),
    );

    expect(result.obligations[0]).toMatchObject({
      status: "verified",
      diagnostics: [],
    });
    expect(result.status).toBe("ready");
    expect(result.summary.required_open).toBe(0);
  });

  it("does not authenticate packaged-process proof with generic replay evidence", () => {
    const capture = processEvidence();
    const proof = proofEvidence("generic-packaged");
    const initial = build(request([capture, proof]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const result = build(
      request([capture, proof], {
        manifest: {
          schema_version: 1,
          bindings: [
            {
              obligation_id: obligation.obligation_id,
              owner: {
                module_path: "src/processOwner.ts",
                symbol: "runProcess",
                owner_sha256: "5".repeat(64),
              },
              parser_type: null,
              original_cases: originalCases(obligation, capture.evidence_id),
              fixtures: obligation.required_case_kinds.map((caseKind) => ({
                fixture_id: `packaged.${caseKind}`,
                case_kind: caseKind,
                authority: "packaged-process",
                evidence_ids: [proof.evidence_id],
              })),
              verifier: {
                verifier_id: "verifier.packaged",
                claim_id: "claim.process",
                command: "npm run verify:package -- process",
                authority: "packaged-process",
                status: "pass",
                result_evidence_id: proof.evidence_id,
                enumerated_obligation_ids: [obligation.obligation_id],
                nondeterminism: {
                  mode: "partial-order",
                  specification: "Fixture scheduling is partially ordered.",
                },
              },
            },
          ],
          contradictions: [],
        },
      }),
    );

    expect(result.obligations[0]?.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "weak-fixture-authority",
        "weak-verifier-authority",
      ]),
    );
  });

  it("propagates an open dependency through the full obligation chain", () => {
    const ids = ["obl.chain.a", "obl.chain.b", "obl.chain.c"] as const;
    const evidence = boundProofEvidence(
      "fixture-chain",
      {
        obligation_ids: ids,
        fixture_ids: ids.map((id) => `fixture.${id}`),
        case_kinds: ["positive"],
        verifier_ids: ids.map((id) => `verifier.${id}`),
        claim_ids: ids.map((id) => `claim.${id}`),
      },
      "shipped-artifact",
    );
    const reviewed = ids.map((id, index) => ({
      ...reviewedObligation(id, evidence.evidence_id),
      dependency_obligation_ids:
        index === 0 ? [ids[1]] : index === 1 ? [ids[2]] : ["obl.chain.missing"],
    }));
    const bindings = reviewed.map((obligation) => ({
      obligation_id: obligation.obligation_id,
      owner: {
        module_path: `src/${obligation.obligation_id}.ts`,
        symbol: "verify",
        owner_sha256: "6".repeat(64),
      },
      parser_type: null,
      original_cases: [
        {
          kind: "positive" as const,
          evidence_id: evidence.evidence_id,
          location: "/fixture/positive",
        },
      ],
      fixtures: [
        {
          fixture_id: `fixture.${obligation.obligation_id}`,
          case_kind: "positive" as const,
          authority: "unit" as const,
          evidence_ids: [evidence.evidence_id],
        },
      ],
      verifier: {
        verifier_id: `verifier.${obligation.obligation_id}`,
        claim_id: `claim.${obligation.obligation_id}`,
        command: "npm test -- fixture-chain",
        authority: "unit" as const,
        status: "pass" as const,
        result_evidence_id: evidence.evidence_id,
        enumerated_obligation_ids: [obligation.obligation_id],
        nondeterminism: {
          mode: "total-order" as const,
          specification: "Fixture execution is ordered.",
        },
      },
    }));
    const result = build(
      request([evidence], {
        reviewed_obligations: reviewed,
        manifest: { schema_version: 1, bindings, contradictions: [] },
      }),
    );

    expect(result.obligations.map(({ status }) => status)).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
    expect(
      result.obligations.map(({ diagnostics }) =>
        diagnostics.map(({ code }) => code),
      ),
    ).toEqual([
      ["dependency-open"],
      ["dependency-open"],
      ["dependency-missing"],
    ]);
  });

  it("fails closed on parser gaps, ambiguous ownership, and contradiction", () => {
    const original = createEvidence(
      undefined,
      { id: "external", name: "External protocol observer", version: "1" },
      {
        predicateType: "rea.protocol-observation/v1",
        operation: "observe_protocol",
        parameters: {},
        result: { status: 200 },
        confidence: "observed",
        authority: "external-service",
      },
    );
    const proof = proofEvidence("protocol");
    const reviewed: ReviewedReconstructionObligation = {
      ...reviewedObligation("obl.protocol", original.evidence_id),
      application_layer: "protocol" as const,
      family: "json-rpc",
      required_original_authority: "external" as const,
      required_fixture_authority: "protocol" as const,
      required_verifier_authority: "protocol" as const,
      requires_parser_type: true,
      required_case_kinds: ["positive", "negative", "malformed"],
    };
    const binding = {
      obligation_id: reviewed.obligation_id,
      owner: {
        module_path: "src/protocol.ts",
        symbol: "handleRequest",
        owner_sha256: "3".repeat(64),
      },
      parser_type: null,
      original_cases: reviewed.required_case_kinds.map((caseKind) => ({
        kind: caseKind,
        evidence_id: original.evidence_id,
        location: `/protocol/${caseKind}`,
      })),
      fixtures: [
        {
          fixture_id: "fixture.positive",
          case_kind: "positive" as const,
          authority: "unit" as const,
          evidence_ids: [proof.evidence_id],
        },
      ],
      verifier: null,
    };
    const result = build(
      request([original, proof], {
        reviewed_obligations: [reviewed],
        manifest: {
          schema_version: 1,
          bindings: [binding, binding],
          contradictions: [
            {
              obligation_id: reviewed.obligation_id,
              evidence_ids: [original.evidence_id, proof.evidence_id],
            },
          ],
        },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.obligations[0]?.status).toBe("contradicted");
    expect(result.obligations[0]?.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["ambiguous-owner", "contradiction"]),
    );
    expect(result.reports.contradicted_obligation_ids).toEqual([
      reviewed.obligation_id,
    ]);
  });
});

const reviewedObligation = (
  obligationId: string,
  evidenceId: string,
): ReviewedReconstructionObligation => ({
  obligation_id: obligationId,
  obligation_version: 1,
  title: `Reviewed obligation ${obligationId}`,
  application_layer: "other",
  family: "reviewed",
  target: {
    artifact_sha256: null,
    application_node_id: null,
    semantic_node_id: null,
    location: `/reviewed/${obligationId}`,
  },
  required: true,
  required_case_kinds: ["positive"],
  required_original_authority: "static",
  required_fixture_authority: "unit",
  required_verifier_authority: "unit",
  requires_parser_type: false,
  dependency_obligation_ids: [],
  residual_unknown_ids: [],
  unavailable_authority: [],
  required_next_evidence: ["Bind an owner and verifier."],
  disposition: "active",
  review_evidence_ids: [evidenceId],
});
