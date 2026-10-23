import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  marshalCode,
  pythonPycFixture,
  pythonPycHeader,
} from "../../../src/python/PythonPyc.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Python pyc inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_python_pyc and reads nested code objects",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_python_pyc",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      if (advertised?.outputSchema === undefined)
        throw new Error("Missing inspect_python_pyc output schema");
      const outputSchema: Record<string, unknown> = advertised.outputSchema;
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      expect(ajv.validateSchema(outputSchema)).toBe(true);
      const root = await createTestTempDirectory("rea-python-pyc-mcp-");
      const path = join(root, "sample.pyc");
      const nested = marshalCode("py311", {
        name: "inner",
        firstlineno: -7,
      });
      await writeFile(
        path,
        Buffer.concat([
          pythonPycHeader(3531),
          marshalCode("py311", {
            firstlineno: -1,
            consts: [nested],
          }),
        ]),
      );
      const response = await client.callTool({
        name: "inspect_python_pyc",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract("inspect_python_pyc").outputSchema.parse(
        response.structuredContent,
      );
      expect(
        ajv.validate(outputSchema, response.structuredContent),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      expect(evidence.normalized_result.header.python_version).toBe("3.12");
      expect(evidence.normalized_result.code_objects[0]?.firstlineno).toBe(-1);
      expect(evidence.normalized_result.code_objects[1]?.name).toBe("inner");
      expect(evidence.normalized_result.code_objects[0]?.consts).toContainEqual(
        {
          kind: "code",
          name: "inner",
          firstlineno: -7,
        },
      );
    } finally {
      await session.close();
    }
  },
);

mcpTest("requires an absolute path for inspect_python_pyc", async ({ mcp }) => {
  const { client, session } = await connect(mcp);
  try {
    const response = await client.callTool({
      name: "inspect_python_pyc",
      arguments: { path: "sample.pyc" },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_python_pyc" },
    });
  } finally {
    await session.close();
  }
});

mcpTest("reports an unknown pyc magic as unsupported", async ({ mcp }) => {
  const { client, session } = await connect(mcp);
  try {
    const root = await createTestTempDirectory("rea-python-pyc-mcp-magic-");
    const path = join(root, "unknown.pyc");
    const bytes = pythonPycFixture("py311");
    bytes.writeUInt16LE(1, 0);
    await writeFile(path, bytes);
    const response = await client.callTool({
      name: "inspect_python_pyc",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "unsupported_target",
      details: { operation: "inspect_python_pyc" },
    });
  } finally {
    await session.close();
  }
});
