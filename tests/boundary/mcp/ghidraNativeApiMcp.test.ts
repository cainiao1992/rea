import { describe, expect, it } from "vitest";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";

describe("Ghidra MCP native API evidence", () => {
  it("records approved native API truncation once and links its evidence", async () => {
    const harness = await connectGhidraMcp("ghidra-native-api");
    const { mcp, session } = harness;
    try {
      const unapprovedInspection = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "inspect_native_api",
            arguments: { procedure: "fixture_truncated" },
          })
        ).structuredContent,
      );
      expect(unapprovedInspection.normalized_result).toMatchObject({
        boundary: {
          available: true,
          jump_tables: [{ mappings_truncated: true }],
        },
        residual_unknowns: [
          expect.stringContaining("additional data sources or targets"),
        ],
      });
      expect(
        (
          await mcp.callTool({
            name: "list_unknowns",
            arguments: {},
          })
        ).structuredContent,
      ).toMatchObject({ result: { items: [] } });

      const approvedInspection = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "inspect_native_api",
            arguments: {
              procedure: "fixture_truncated",
              unknown_registry_approved: true,
            },
          })
        ).structuredContent,
      );
      await mcp.callTool({
        name: "inspect_native_api",
        arguments: {
          procedure: "fixture_truncated",
          unknown_registry_approved: true,
        },
      });
      expect(
        (
          await mcp.callTool({
            name: "list_unknowns",
            arguments: {},
          })
        ).structuredContent,
      ).toMatchObject({
        result: {
          items: [
            {
              unknown: {
                status: "open",
                domain: "native-api",
                question: expect.stringContaining(
                  "additional data sources or targets",
                ),
                supporting_evidence_ids: [approvedInspection.evidence_id],
                recommended_probes: [
                  {
                    operation: "inspect_native_api",
                    rationale: expect.stringContaining("ABI probe"),
                  },
                ],
              },
            },
          ],
        },
      });
    } finally {
      await harness.close();
    }
  }, 30_000);
});
