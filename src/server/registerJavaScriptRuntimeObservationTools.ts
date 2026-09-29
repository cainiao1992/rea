import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../application/JavaScriptRuntimeObservationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import { resolveEvidenceReferences } from "../application/EvidenceReferenceResolver.js";
import { JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS } from "../contracts/javascriptRuntimeObservationToolContracts.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/errors.js";
import { AnalysisInputError } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import { err, type Result } from "../domain/result.js";
import {
  javascriptRuntimeTargetListSchema,
  listJavaScriptRuntimeTargetsInputSchema,
  observeJavaScriptRuntimeInputSchema,
  observeJavaScriptRuntimeToolInputSchema,
} from "../domain/javascriptRuntimeObservation.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface RuntimeToolRegistration {
  readonly logger: Logger;
  readonly runtime: JavaScriptRuntimeObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly evidenceLookup:
    | ((evidenceId: string) => Evidence | undefined)
    | undefined;
}

/** Register passive Inspector tools even when policy keeps them unavailable. */
export const registerJavaScriptRuntimeObservationTools = (
  server: McpServer,
  options: RuntimeToolRegistration,
): void => {
  const [listContract, observeContract] =
    JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS;
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runRuntimeTool(
        options,
        listContract,
        { input, context },
        (parsed, signal) =>
          listJavaScriptRuntimeTargets(
            options.runtime,
            options.permissionAuthority,
            parsed,
            { signal },
          ),
      ),
  );
  server.registerTool(
    observeContract.name,
    toolRegistrationOptions(observeContract),
    (input, context) =>
      runRuntimeTool(
        options,
        observeContract,
        { input, context },
        async (parsed, signal) => {
          const request = observeJavaScriptRuntimeToolInputSchema.parse(parsed);
          const source = resolveEvidenceReferences(
            options.evidenceLookup,
            [request.discovery_evidence_id],
            [
              {
                operation: "list_javascript_runtime_targets",
                predicate: "rea.javascript-runtime-target-list",
              },
            ],
          );
          if (!source.ok) return err(source.error);
          const discovery = source.value[0];
          if (discovery === undefined) return err(invalidDiscoveryEvidence());
          const scope = listJavaScriptRuntimeTargetsInputSchema.safeParse(
            discovery.parameters,
          );
          const listed = javascriptRuntimeTargetListSchema.safeParse(
            discovery.normalized_result,
          );
          if (!scope.success || !listed.success)
            return err(invalidDiscoveryEvidence());
          if (
            !listed.data.targets.some(
              ({ target_id }) => target_id === request.target_id,
            )
          )
            return err(
              new AnalysisInputError("observe_javascript_runtime", undefined, [
                {
                  path: ["target_id"],
                  reason: "invalid_value",
                  message:
                    "Choose a target returned by the referenced discovery Evidence",
                },
              ]),
            );
          return observeJavaScriptRuntime(
            options.runtime,
            options.permissionAuthority,
            observeJavaScriptRuntimeInputSchema.parse({
              ...scope.data,
              target_id: request.target_id,
              ...(request.runtime_kind === undefined
                ? {}
                : { runtime_kind: request.runtime_kind }),
              observation_ms: request.observation_ms,
            }),
            { signal },
          );
        },
      ),
  );
};

const invalidDiscoveryEvidence = () =>
  new AnalysisInputError("observe_javascript_runtime", undefined, [
    {
      path: ["discovery_evidence_id"],
      reason: "invalid_value",
      message:
        "The referenced Evidence is not a usable Inspector target discovery",
    },
  ]);

const runRuntimeTool = async <Input>(
  options: RuntimeToolRegistration,
  contract: ToolContract,
  request: { readonly input: Input; readonly context: ServerContext },
  execute: (
    input: Input,
    signal: AbortSignal,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context } = request;
  const result = await logToolExecution(options.logger, contract.name, () =>
    execute(input, context.mcpReq.signal),
  );
  if (!result.ok) return toCallToolResult(result, contract);
  const recorded = options.recordEvidence?.(result.value);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: result.value }, contract);
};
