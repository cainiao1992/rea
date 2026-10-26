import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  type EvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { expect, it } from "vitest";

interface VerifierResults {
  readonly requireMcpEvidenceBundle: (result: unknown) => EvidenceBundle;
  readonly requireMcpLifecycleResult: (
    result: unknown,
    operation: string,
  ) => unknown;
  readonly expandMcpSessionStatus: (status: unknown) => {
    readonly analysis_provider_candidates: unknown;
  };
  readonly expandProviderOutput: (providers: unknown) => {
    readonly analysis_provider_candidates: unknown;
  };
}

// The verifier helper imports the compiled contracts, so this runs after build.
const verifierResults = (): Promise<VerifierResults> =>
  import(
    new URL("../../../scripts/lib/mcp-verifier-results.mjs", import.meta.url)
      .href
  ) as Promise<VerifierResults>;

const provider = { id: "alpha", name: "alpha provider", version: null };
const summaryCandidate = {
  provider,
  availability: { status: "available", code: null, reason: null },
  target_support: { status: "unknown", code: null, reason: "No target." },
  selected: false,
};
const emptyTools = {
  client_requirements: {
    required: [],
    optional: [],
    missing_required: [],
    missing_optional: [],
  },
  groups: [],
};

it("keeps summary candidates only for MCP summary status", async () => {
  const { expandMcpSessionStatus } = await verifierResults();
  expect(
    expandMcpSessionStatus({
      detail: "summary",
      capabilities: [],
      analysis_provider_candidates: [summaryCandidate],
      tool_availability: emptyTools,
    }).analysis_provider_candidates,
  ).toEqual([summaryCandidate]);
  expect(() =>
    expandMcpSessionStatus({
      detail: "complete",
      capabilities: [],
      analysis_provider_candidates: [summaryCandidate],
      tool_availability: emptyTools,
    }),
  ).toThrow();
});

it("requires candidate capabilities in CLI provider output", async () => {
  const { expandProviderOutput } = await verifierResults();
  expect(() =>
    expandProviderOutput({
      capabilities: [],
      analysis_provider_candidates: [summaryCandidate],
    }),
  ).toThrow();
  expect(
    expandProviderOutput({
      capabilities: [],
      analysis_provider_candidates: [{ ...summaryCandidate, capabilities: [] }],
    }).analysis_provider_candidates,
  ).toEqual([{ ...summaryCandidate, capabilities: [] }]);
});

const retainedBundle = (value = 7) =>
  createEvidenceBundle([
    createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "observe",
        parameters: {},
        result: { value },
      },
    ),
  ]);
const bundleReply = (bundle: unknown) => ({
  content: [{ type: "text", text: JSON.stringify({ result: bundle }) }],
  structuredContent: { result: bundle },
});

it("authenticates complete retained bundles and preserves the text-only transport option", async () => {
  const { requireMcpEvidenceBundle } = await verifierResults();
  const bundle = retainedBundle();
  expect(requireMcpEvidenceBundle(bundleReply(bundle))).toEqual(bundle);
  const { structuredContent: _structured, ...textOnly } = bundleReply(bundle);
  expect(requireMcpEvidenceBundle(textOnly)).toEqual(bundle);
});

it("rejects duplicate retained record IDs instead of selecting the first matching record", async () => {
  const { requireMcpEvidenceBundle, requireMcpLifecycleResult } =
    await verifierResults();
  const bundle = retainedBundle();
  const duplicate = {
    ...bundle,
    records: [...bundle.records, ...bundle.records],
  };
  // The named wire contract admits this shape; authentication must reject it.
  expect(
    requireMcpLifecycleResult(bundleReply(duplicate), "get_evidence_bundle"),
  ).toEqual(duplicate);
  expect(() => requireMcpEvidenceBundle(bundleReply(duplicate))).toThrow(
    "duplicate record IDs",
  );
});

it("rejects shape-valid retained Evidence whose semantic identifier was tampered", async () => {
  const { requireMcpEvidenceBundle, requireMcpLifecycleResult } =
    await verifierResults();
  const bundle = retainedBundle();
  const tampered = {
    ...bundle,
    records: bundle.records.map((record) => ({
      ...record,
      normalized_result: { value: 8 },
    })),
  };
  expect(
    requireMcpLifecycleResult(bundleReply(tampered), "get_evidence_bundle"),
  ).toEqual(tampered);
  expect(() => requireMcpEvidenceBundle(bundleReply(tampered))).toThrow(
    /semantic identifier/u,
  );
});

it("rejects noncanonical manifests even when a selected retained record is authentic", async () => {
  const { requireMcpEvidenceBundle, requireMcpLifecycleResult } =
    await verifierResults();
  const broken = { ...retainedBundle(), providers: [] };
  expect(
    requireMcpLifecycleResult(bundleReply(broken), "get_evidence_bundle"),
  ).toEqual(broken);
  expect(() => requireMcpEvidenceBundle(bundleReply(broken))).toThrow(
    /not canonical/u,
  );
});

it("rejects differing named text/structured bundle representations", async () => {
  const { requireMcpEvidenceBundle } = await verifierResults();
  const text = retainedBundle();
  const structured = retainedBundle(8);
  expect(() =>
    requireMcpEvidenceBundle({
      ...bundleReply(text),
      structuredContent: { result: structured },
    }),
  ).toThrow("text and structured results disagree");
});

it("retains summary discovery in the generic lifecycle reader but refuses it as complete Evidence", async () => {
  const { requireMcpEvidenceBundle, requireMcpLifecycleResult } =
    await verifierResults();
  const summary = {
    kind: "evidence-bundle-summary",
    filters: {},
    total_retained_records: 0,
    matching_records: 0,
    unknown_revisions: 0,
    records: [],
  };
  expect(
    requireMcpLifecycleResult(bundleReply(summary), "get_evidence_bundle"),
  ).toEqual(summary);
  expect(() => requireMcpEvidenceBundle(bundleReply(summary))).toThrow(
    "summary metadata instead of complete Evidence",
  );
});
