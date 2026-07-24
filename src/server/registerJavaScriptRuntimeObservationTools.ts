import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../application/JavaScriptRuntimeObservationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "../contracts/javascriptRuntimeObservationToolContracts.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import {
  listJavaScriptRuntimeTargetsInputSchema,
  observeJavaScriptRuntimeInputSchema,
} from "../domain/javascriptRuntimeObservation.js";
import type { Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface RuntimeToolRegistration {
  readonly logger: Logger;
  readonly runtime: JavaScriptRuntimeObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
}

interface RuntimeToolSpec<Schema extends z.ZodType> {
  readonly contract: ToolContract;
  readonly schema: Schema;
  readonly execute: (
    parsed: z.output<Schema>,
    signal: AbortSignal,
  ) => Promise<Result<Evidence, AnalysisError>>;
}

/** Register passive Inspector tools even when policy keeps them unavailable. */
export const registerJavaScriptRuntimeObservationTools = (
  server: McpServer,
  options: RuntimeToolRegistration,
): void => {
  const [listContract, observeContract] =
    JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS;
  registerRuntimeTool(server, options, {
    contract: listContract,
    schema: listJavaScriptRuntimeTargetsInputSchema,
    execute: (parsed, signal) =>
      listJavaScriptRuntimeTargets(
        options.runtime,
        options.permissionAuthority,
        parsed,
        { signal },
      ),
  });
  registerRuntimeTool(server, options, {
    contract: observeContract,
    schema: observeJavaScriptRuntimeInputSchema,
    execute: (parsed, signal) =>
      observeJavaScriptRuntime(
        options.runtime,
        options.permissionAuthority,
        parsed,
        { signal },
      ),
  });
};

const registerRuntimeTool = <Schema extends z.ZodType>(
  server: McpServer,
  options: RuntimeToolRegistration,
  spec: RuntimeToolSpec<Schema>,
): void => {
  server.registerTool(
    spec.contract.name,
    toolRegistrationOptions(spec.contract),
    async (input, context) => {
      const parsed = safeParseToolInput(spec.schema, input, spec.contract.name);
      if (!parsed.ok) return toCallToolResult(parsed, spec.contract);
      const result = await logToolExecution(
        options.logger,
        spec.contract.name,
        () => spec.execute(parsed.value, context.mcpReq.signal),
      );
      if (!result.ok) return toCallToolResult(result, spec.contract);
      const recorded = options.recordEvidence?.(result.value);
      return recorded !== undefined && !recorded.ok
        ? toCallToolResult(recorded, spec.contract)
        : toCallToolResult({ ok: true, value: result.value }, spec.contract, {
            evidenceResourcesAvailable: recorded !== undefined,
          });
    },
  );
};
