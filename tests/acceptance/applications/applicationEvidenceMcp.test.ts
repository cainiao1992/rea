import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type { BinarySession } from "../../../src/application/BinarySession.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE,
  SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
} from "../../../src/contracts/javascriptApplicationWorkflowExamples.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { observed } from "../../fixtures/analysisExecution.js";

interface TestHarness {
  readonly client: Client;
  readonly session: BinarySession;
  readonly close: () => Promise<void>;
}

async function createTestHarness(): Promise<TestHarness> {
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session);
  const client = new Client({
    name: "application-workflow-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    session,
    close: async () => {
      await client.close();
      await server.close();
      await session.close();
    },
  };
}

async function runInlineEvidenceScenarios(
  client: Client,
  session: BinarySession,
): Promise<void> {
  const traced = await client.callTool({
    name: "trace_application_feature",
    arguments: JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
  });
  expect(traced.isError).not.toBe(true);
  expect(traced.structuredContent).toMatchObject({
    result: {
      source_graph_id: expect.any(String),
      coverage: { status: expect.any(String) },
    },
  });

  const compared = await client.callTool({
    name: "compare_application_versions",
    arguments: {
      ...JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE,
    },
  });
  expect(compared.isError).not.toBe(true);
  expect(compared.structuredContent).toMatchObject({
    result: {
      summary: { unknown: expect.any(Number) },
      coverage: { status: expect.any(String) },
    },
  });

  const sourceCompared = await client.callTool({
    name: "compare_source_to_bundle",
    arguments: {
      reference: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference,
      application: JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application,
    },
  });
  expect(sourceCompared.isError).not.toBe(true);
  expect(sourceCompared.structuredContent).toMatchObject({
    result: {
      reference: {
        root_sha256: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference.root_sha256,
      },
      scoring: { algorithm: "rea-source-to-bundle-signals" },
    },
  });
  expect(session.exportEvidenceBundle().records.length).toBeGreaterThan(2);
}

async function runInlineWorkflowScenarios(harness: TestHarness): Promise<void> {
  const tracedInline = await harness.client.callTool({
    name: "trace_application_feature",
    arguments: {
      ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
    },
  });
  expect(tracedInline.isError).not.toBe(true);

  const comparedInline = await harness.client.callTool({
    name: "compare_application_versions",
    arguments: {
      ...JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE,
    },
  });
  expect(comparedInline).toMatchObject({
    structuredContent: {
      result: {
        evidence_links: expect.arrayContaining([
          JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.left.evidence_id,
          JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.right.evidence_id,
        ]),
      },
    },
  });

  const idsRejected = await harness.client.callTool({
    name: "compare_application_versions",
    arguments: {
      left_evidence_id:
        JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.left.evidence_id,
      right_evidence_id:
        JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.right.evidence_id,
    },
  });
  expect(idsRejected.isError).toBe(true);

  const sourceComparedById = await harness.client.callTool({
    name: "compare_source_to_bundle",
    arguments: {
      ...SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
    },
  });
  expect(sourceComparedById.isError).not.toBe(true);
}

async function assertRejectedEvidenceReferences(
  client: Client,
  session: BinarySession,
): Promise<void> {
  const wrongOperation = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: "inventory_artifact", parameters: {}, result: {} },
  );
  const wrongPredicate = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      predicateType: "fixture.application/v1",
      operation: "analyze_javascript_application",
      parameters: {},
      result: {},
    },
  );
  expect(session.recordEvidence(wrongOperation).ok).toBe(true);
  expect(session.recordEvidence(wrongPredicate).ok).toBe(true);
  for (const record of [wrongOperation, wrongPredicate]) {
    const rejected = await client.callTool({
      name: "trace_application_feature",
      arguments: {
        ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
        application: record,
      },
    });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: { error: expect.any(Object) },
    });
  }
}

async function assertRejectedInlineEvidence(client: Client): Promise<void> {
  const duplicateNative = await client.callTool({
    name: "trace_application_feature",
    arguments: {
      ...JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
      native_observations: [
        JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application,
        JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application,
      ],
    },
  });
  expect(duplicateNative.isError).toBe(true);

  const spoofed = await client.callTool({
    name: "trace_application_feature",
    arguments: {
      ...JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE,
      application: {
        ...JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application,
        provider: { id: "spoofed", name: "spoofed", version: "1" },
      },
    },
  });
  expect(spoofed.isError).toBe(true);

  const legacyComparisonReferences = await client.callTool({
    name: "compare_application_versions",
    arguments: {
      left_evidence_id:
        JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.left.evidence_id,
      right_evidence_id:
        JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE.right.evidence_id,
    },
  });
  expect(legacyComparisonReferences.isError).toBe(true);
}

describe("application workflow MCP parity", () => {
  it("traces and compares authenticated graph Evidence in the session", async () => {
    const harness = await createTestHarness();
    try {
      await runInlineEvidenceScenarios(harness.client, harness.session);
      await runInlineWorkflowScenarios(harness);
      await assertRejectedEvidenceReferences(harness.client, harness.session);
      await assertRejectedInlineEvidence(harness.client);
    } finally {
      await harness.close();
    }
  });
});
