import { describe, expect, it } from "vitest";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";

describe("Ghidra MCP evidence parity", () => {
  it("preserves provider evidence, composed parity, and capability routing", async () => {
    const harness = await connectGhidraMcp("ghidra-parity");
    const { mcp, session } = harness;
    try {
      const listed = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "list_procedures",
            arguments: {},
          })
        ).structuredContent,
      );
      expect(listed).toMatchObject({
        operation: "list_procedures",
        provider: { id: "ghidra", name: "Ghidra", version: "12.1.2" },
        analysis_profile: {
          provider: { id: "ghidra", version: "12.1.2" },
          parameters: {
            import_mode: "ephemeral-read-only",
            analyzer_preset: "ghidra-default",
          },
        },
        normalized_result: {
          items: [
            {
              address: "0x401000",
              value: "fixture_main",
              procedure: {
                external: false,
                thunk: false,
                thunk_target: null,
              },
            },
          ],
          total: 1,
        },
        raw_result: {
          items: [{ value_truncated: false }],
        },
      });

      const mcpOverview = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "binary_overview",
            arguments: { detail: "detailed", limit: 5 },
          })
        ).structuredContent,
      );
      const directOverview = await new EnhancedTools(session).execute(
        "binary_overview",
        { detail: "detailed", limit: 5 },
      );
      expect(directOverview.ok).toBe(true);
      if (!directOverview.ok) return;
      expect(mcpOverview.normalized_result).toEqual(directOverview.value);
      expect(mcpOverview).toMatchObject({
        provider: { id: "rea-workflow" },
        confidence: "derived",
        normalized_result: {
          document: "fixture",
          segment_count: 1,
          procedure_count: 1,
          string_count: 2,
          segments: [{ name: ".text", length: 256 }],
        },
      });

      const pseudocode = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "procedure_pseudo_code",
            arguments: { procedure: "fixture_main" },
          })
        ).structuredContent,
      );
      expect(pseudocode).toMatchObject({
        operation: "procedure_pseudo_code",
        provider: { id: "ghidra", version: "12.1.2" },
        normalized_result: expect.stringContaining("return 42"),
        limitations: expect.arrayContaining([
          expect.stringContaining("not text-equivalent to Hopper"),
          expect.stringContaining("30-second native deadline"),
        ]),
      });

      const analyzed = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "analyze_function",
            arguments: { procedure: "fixture_main", include_assembly: true },
          })
        ).structuredContent,
      );
      expect(analyzed).toMatchObject({
        operation: "analyze_function",
        provider: { id: "rea-workflow", version: "1" },
        normalized_result: {
          procedure: {
            address: "0x401000",
            name: "fixture_main",
            classification: {
              external: false,
              thunk: false,
              provenance: "ghidra-function-manager",
            },
          },
          pseudocode: { truncated: false },
          outgoing_references: {
            items: [
              {
                kind: {
                  available: true,
                  provenance: "ghidra-reference-manager",
                },
              },
            ],
          },
          limitations: expect.arrayContaining([
            expect.stringContaining("indirect flows without target addresses"),
            expect.stringContaining(
              "not original source or Hopper-equivalent text",
            ),
          ]),
        },
        limitations: [
          "Derived by an REA workflow from one or more provider observations.",
        ],
      });
      const directAnalyzed = await new EnhancedTools(session).execute(
        "analyze_function",
        { procedure: "fixture_main", include_assembly: true },
      );
      expect(directAnalyzed.ok).toBe(true);
      if (!directAnalyzed.ok) return;
      expect(analyzed.normalized_result).toEqual(directAnalyzed.value);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
