import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { erlangBeamFixture } from "../../../src/erlang/Beam.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("BEAM inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_erlang_beam and reads the module atom",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_erlang_beam",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-beam-mcp-");
      const path = join(root, "app.beam");
      await writeFile(path, erlangBeamFixture("mcp_mod"));
      const response = await client.callTool({
        name: "inspect_erlang_beam",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract("inspect_erlang_beam").outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.module).toBe("mcp_mod");
      expect(evidence.normalized_result.atom_encoding).toBe("utf8");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_erlang_beam",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_erlang_beam",
        arguments: { path: "app.beam" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_erlang_beam" },
      });
    } finally {
      await session.close();
    }
  },
);
