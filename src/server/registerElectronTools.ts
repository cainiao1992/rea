import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ElectronActiveObservationPort } from "../application/ElectronActiveObservationPort.js";
import { captureElectronScenario } from "../application/ElectronActiveObservationService.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/ElectronObservationService.js";
import { analyzeJavaScriptApplicationValidated } from "../application/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntimeEvidenceValidated } from "../application/JavaScriptRuntimeReconciliationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { ELECTRON_TOOL_CONTRACTS } from "../contracts/electronToolContracts.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/errors.js";
import { AnalysisInputError } from "../domain/errors.js";
import { resolveEvidenceReferences } from "../application/EvidenceReferenceResolver.js";
import type { Evidence } from "../domain/evidence.js";
import { err, type Result } from "../domain/result.js";
import {
  electronTargetListSchema,
  inspectElectronPageInputSchema,
  inspectElectronPageToolInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/electronObservation.js";
import type { Logger } from "../logger.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface ElectronToolRegistration {
  readonly logger: Logger;
  readonly electron: ElectronObservationPort | undefined;
  readonly electronActive: ElectronActiveObservationPort | undefined;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly evidenceLookup:
    | ((evidenceId: string) => Evidence | undefined)
    | undefined;
}

interface ElectronToolContext {
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
}

/** Register Electron tools even when provider or permission policy is absent. */
// oxlint-disable-next-line max-lines-per-function -- direct SDK calls retain each schema-handler type correlation.
export const registerElectronTools = (
  server: McpServer,
  options: ElectronToolRegistration,
): void => {
  const [
    listContract,
    inspectContract,
    analyzeContract,
    reconcileContract,
    activeContract,
  ] = ELECTRON_TOOL_CONTRACTS;

  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input, context) =>
      runElectronTool(
        options,
        listContract,
        { input, context },
        (parsed, { signal }) =>
          listElectronTargets(
            options.electron,
            options.permissionAuthority,
            parsed,
            {
              signal,
            },
          ),
      ),
  );
  server.registerTool(
    inspectContract.name,
    toolRegistrationOptions(inspectContract),
    (input, context) =>
      runElectronTool(
        options,
        inspectContract,
        { input, context },
        async (parsed, { signal, progress }) => {
          const request = inspectElectronPageToolInputSchema.parse(parsed);
          const source = resolveEvidenceReferences(
            options.evidenceLookup,
            [request.discovery_evidence_id],
            [
              {
                operation: "list_electron_targets",
                predicate: "rea.electron-target-list",
              },
            ],
          );
          if (!source.ok) return err(source.error);
          const discovery = source.value[0];
          if (discovery === undefined) return err(invalidDiscoveryEvidence());
          const scope = listElectronTargetsInputSchema.safeParse(
            discovery.parameters,
          );
          const listed = electronTargetListSchema.safeParse(
            discovery.normalized_result,
          );
          if (!scope.success || !listed.success)
            return err(invalidDiscoveryEvidence());
          if (
            !listed.data.targets.some(
              ({ target_id }) => target_id === request.target_id,
            )
          )
            return {
              ok: false,
              error: new AnalysisInputError(
                "inspect_electron_page",
                undefined,
                [
                  {
                    path: ["target_id"],
                    reason: "invalid_value",
                    message:
                      "Choose a target returned by the referenced discovery Evidence",
                  },
                ],
              ),
            };
          return inspectElectronPage(
            options.electron,
            options.permissionAuthority,
            inspectElectronPageInputSchema.parse({
              ...scope.data,
              target_id: request.target_id,
              observation_ms: request.observation_ms,
              include_script_sources: request.include_script_sources,
            }),
            { signal, progress },
          );
        },
      ),
  );
  server.registerTool(
    analyzeContract.name,
    toolRegistrationOptions(analyzeContract),
    (input, context) =>
      runElectronTool(
        options,
        analyzeContract,
        { input, context },
        (parsed, { signal, progress }) =>
          analyzeJavaScriptApplicationValidated(parsed, { signal, progress }),
      ),
  );
  server.registerTool(
    reconcileContract.name,
    toolRegistrationOptions(reconcileContract),
    (input, context) =>
      runElectronTool(
        options,
        reconcileContract,
        { input, context },
        (parsed) =>
          Promise.resolve(reconcileJavaScriptRuntimeEvidenceValidated(parsed)),
      ),
  );
  server.registerTool(
    activeContract.name,
    toolRegistrationOptions(activeContract),
    (input, context) =>
      runElectronTool(
        options,
        activeContract,
        { input, context },
        (parsed, { signal, progress }) =>
          captureElectronScenario(
            options.electronActive,
            options.permissionAuthority,
            parsed,
            { signal, progress },
          ),
      ),
  );
};

const invalidDiscoveryEvidence = () =>
  new AnalysisInputError("inspect_electron_page", undefined, [
    {
      path: ["discovery_evidence_id"],
      reason: "invalid_value",
      message:
        "The referenced Evidence is not a usable Electron target discovery",
    },
  ]);

const runElectronTool = async <Input>(
  options: ElectronToolRegistration,
  contract: ToolContract,
  request: {
    readonly input: Input;
    readonly context: ServerContext;
  },
  execute: (
    input: Input,
    context: ElectronToolContext,
  ) => Promise<Result<Evidence, AnalysisError>>,
) => {
  const { input, context } = request;
  const result = await logToolExecution(options.logger, contract.name, () =>
    execute(input, {
      signal: context.mcpReq.signal,
      progress: mcpProgressReporter(context),
    }),
  );
  if (!result.ok) return toCallToolResult(result, contract);
  return evidenceResult(options, contract, result.value);
};

const evidenceResult = (
  options: ElectronToolRegistration,
  contract: ToolContract,
  evidence: Evidence,
) => {
  const recorded = options.recordEvidence?.(evidence);
  return recorded !== undefined && !recorded.ok
    ? toCallToolResult(recorded, contract)
    : toCallToolResult({ ok: true, value: evidence }, contract);
};
