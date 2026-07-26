import type {
  AnyToolHandler,
  JsonSchemaValidator,
  jsonSchemaValidator,
  McpServer,
  RegisteredTool,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import {
  fromJsonSchema,
  isCallToolResult,
  isInputRequiredResult,
} from "@modelcontextprotocol/server";

import { GENERATED_MCP_TOOL_CATALOG } from "../generatedMcpToolCatalog.js";
import type { ToolKind } from "../contracts/toolContractTypes.js";

type HydrateToolRegistrations = (kind: ToolKind) => Promise<void>;

/**
 * Advertise the generated MCP catalog immediately and hydrate its callbacks
 * through the existing registrars on first execution.
 */
export class LazyToolCatalog {
  readonly #server: McpServer;
  readonly #hydrateRegistrations: HydrateToolRegistrations;
  readonly #includeSessionTools: boolean;
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #hydrations = new Map<ToolKind, Promise<void>>();
  #hydrationQueue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    server: McpServer,
    hydrateRegistrations: HydrateToolRegistrations,
    includeSessionTools = true,
  ) {
    this.#server = server;
    this.#hydrateRegistrations = hydrateRegistrations;
    this.#includeSessionTools = includeSessionTools;
  }

  /** Register every generated tool with a lazy callback. */
  register(): void {
    for (const contract of GENERATED_MCP_TOOL_CATALOG) {
      if (contract.requiresSession && !this.#includeSessionTools) continue;
      const inputSchema = advertisedSchema(contract.inputSchema);
      const outputSchema = advertisedSchema(contract.outputSchema);
      let registered: RegisteredTool | undefined;
      const callback: AnyToolHandler<StandardSchemaWithJSON> = async (
        input,
        context,
      ) => {
        await this.#hydrate(contract.kind);
        const handler = registered?.handler;
        if (handler === undefined || handler === callback)
          throw new Error(`MCP tool ${contract.name} was not hydrated`);
        const result: unknown = await Reflect.apply(handler, undefined, [
          input,
          context,
        ]);
        if (isCallToolResult(result) || isInputRequiredResult(result))
          return result;
        throw new TypeError(
          `MCP tool ${contract.name} returned an invalid result`,
        );
      };
      registered = this.#server.registerTool(
        contract.name,
        {
          title: contract.title,
          description: contract.description,
          inputSchema,
          outputSchema,
          annotations: contract.annotations,
        },
        callback,
      );
      this.#tools.set(contract.name, registered);
    }
  }

  /** Wait for in-flight hydration and reject future first-use loading. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#hydrations.values());
  }

  async #hydrate(kind: ToolKind): Promise<void> {
    if (this.#closed) throw new Error("MCP tool catalog is closed");
    const existing = this.#hydrations.get(kind);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const hydration = this.#hydrationQueue
      .catch(() => undefined)
      .then(() => this.#runHydration(kind));
    this.#hydrationQueue = hydration;
    this.#hydrations.set(kind, hydration);
    try {
      await hydration;
    } catch (cause: unknown) {
      if (this.#hydrations.get(kind) === hydration)
        this.#hydrations.delete(kind);
      throw cause;
    }
  }

  async #runHydration(kind: ToolKind): Promise<void> {
    if (this.#closed) throw new Error("MCP tool catalog is closed");
    const expected = GENERATED_MCP_TOOL_CATALOG.filter(
      (contract) =>
        contract.kind === kind &&
        (this.#includeSessionTools || !contract.requiresSession),
    ).map((contract) => contract.name);
    const expectedNames = new Set(expected);
    const hydrated = new Set<string>();
    const originalRegisterTool = this.#server.registerTool;
    const hydrationRegisterTool = (...args: unknown[]): unknown => {
      const [name, config, callback] = args;
      if (
        typeof name !== "string" ||
        !isRecord(config) ||
        typeof callback !== "function"
      )
        throw new TypeError("Invalid lazy MCP tool registration");
      const registered = this.#tools.get(name);
      if (registered === undefined || !expectedNames.has(name))
        throw new TypeError(
          `MCP tool ${name} is not in the ${kind} catalog family`,
        );
      if (hydrated.has(name))
        throw new TypeError(`MCP tool ${name} was hydrated more than once`);
      hydrated.add(name);
      Reflect.apply(registered.update, registered, [
        {
          title: config.title,
          description: config.description,
          paramsSchema: config.inputSchema,
          outputSchema: config.outputSchema,
          annotations: config.annotations,
          callback,
        },
      ]);
      return registered;
    };
    if (!Reflect.set(this.#server, "registerTool", hydrationRegisterTool))
      throw new TypeError("Unable to install lazy MCP tool hydration");
    try {
      await this.#hydrateRegistrations(kind);
    } finally {
      Reflect.set(this.#server, "registerTool", originalRegisterTool);
    }
    const missing = expected.filter((name) => !hydrated.has(name));
    if (missing.length > 0)
      throw new TypeError(
        `Generated MCP tools were not hydrated: ${missing.join(", ")}`,
      );
  }
}

const advertisedSchema = (
  jsonSchema: Readonly<Record<string, unknown>>,
): StandardSchemaWithJSON =>
  fromJsonSchema(jsonSchema, DEFERRED_VALIDATION_PROVIDER);

class DeferredValidationProvider implements jsonSchemaValidator {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    });
  }
}

const DEFERRED_VALIDATION_PROVIDER = new DeferredValidationProvider();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
