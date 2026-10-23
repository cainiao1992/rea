import {
  Client,
  InMemoryTransport,
  type JsonSchemaType,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { createCatalogSchemaValidator } from "../../fixtures/catalogSchemaValidator.js";

const integerSchema: JsonSchemaType = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:rea:test:output",
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"],
  additionalProperties: false,
};

it("validates reused documents without freezing or changing caller data", () => {
  const schema = structuredClone(integerSchema);
  const validator = createCatalogSchemaValidator([schema]);
  for (const document of [schema, structuredClone(schema)]) {
    const validate = validator.getValidator(document);
    const input = { value: 7 };
    expect(validate(input)).toEqual({
      valid: true,
      data: input,
      errorMessage: undefined,
    });
    expect(validate({ value: "7" }).valid).toBe(false);
    expect(validate({ value: 7, extra: true }).valid).toBe(false);
    expect(input).toEqual({ value: 7 });
  }
  expect(schema).toEqual(integerSchema);
  expect(Object.isFrozen(schema)).toBe(false);
});

it("isolates changed and unknown schemas even when their id was compiled", () => {
  const schema = structuredClone(integerSchema);
  const validator = createCatalogSchemaValidator([schema]);
  expect(validator.getValidator(schema)({ value: 7 }).valid).toBe(true);

  schema.properties = { value: { type: "string", minLength: 2 } };
  const changed = validator.getValidator(schema);
  expect(changed({ value: "ok" }).valid).toBe(true);
  expect(changed({ value: 7 }).valid).toBe(false);
  expect(changed({ value: "x" }).valid).toBe(false);
  expect(validator.getValidator(integerSchema)({ value: 7 }).valid).toBe(true);
  expect(validator.getValidator(integerSchema)({ value: "ok" }).valid).toBe(
    false,
  );

  const withoutId: JsonSchemaType = { type: "string", format: "email" };
  expect(validator.getValidator(withoutId)("valid@example.com").valid).toBe(
    true,
  );
  expect(validator.getValidator(withoutId)("invalid").valid).toBe(false);
  expect(() =>
    validator.getValidator({ ...integerSchema, pattern: "[" }),
  ).toThrow();
  expect(validator.getValidator(integerSchema)({ value: 7 }).valid).toBe(true);
});

it("preserves dialect dispatch when a document changes only its dialect", () => {
  const schema: JsonSchemaType = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:rea:test:dialect",
    type: "array",
    prefixItems: [{ type: "integer" }],
    items: { type: "string" },
  };
  const validator = createCatalogSchemaValidator([schema]);
  expect(validator.getValidator(schema)([7]).valid).toBe(true);
  expect(validator.getValidator(schema)(["seven"]).valid).toBe(false);
  const draft7 = {
    ...schema,
    $schema: "http://json-schema.org/draft-07/schema#",
  };
  expect(validator.getValidator(draft7)([7]).valid).toBe(false);
  expect(validator.getValidator(draft7)(["seven"]).valid).toBe(true);
});

it("refuses an expected catalog that aliases different documents by id", () => {
  expect(() =>
    createCatalogSchemaValidator([
      integerSchema,
      { ...integerSchema, required: [] },
    ]),
  ).toThrow("reuse an id for different documents");
});

it("keeps SDK output validation active across fresh clients and schema changes", async () => {
  const validator = createCatalogSchemaValidator([integerSchema]);
  for (const { schema, valid } of [
    { schema: integerSchema, valid: { value: 7 } },
    { schema: structuredClone(integerSchema), valid: { value: 7 } },
    {
      schema: {
        ...integerSchema,
        properties: { value: { type: "string" as const } },
      },
      valid: { value: "seven" },
    },
  ]) {
    let payload: Record<string, unknown> = valid;
    const server = new Server(
      { name: "output-validation-control", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [
        {
          name: "checked",
          inputSchema: { type: "object" },
          outputSchema: schema,
        },
      ],
    }));
    server.setRequestHandler("tools/call", async () => ({
      content: [],
      structuredContent: payload,
    }));
    const client = new Client(
      { name: "validated-client", version: "1" },
      { jsonSchemaValidator: validator },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();
      expect(
        (await client.callTool({ name: "checked" })).structuredContent,
      ).toEqual(payload);
      payload = { unexpected: true };
      await expect(client.callTool({ name: "checked" })).rejects.toThrow(
        "Structured content does not match the tool's output schema",
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  }
});
