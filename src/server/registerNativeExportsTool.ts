import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { NativeExportsService } from "../application/binaryDiagnostics/NativeExportsService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { applicationToolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { retainedSummaryDelivery } from "./retainedSummaryDelivery.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err } from "../domain/result.js";

/** Register the explicit-file export-table workflow and retain its complete Evidence. */
export const registerNativeExportsTool = (
  server: EvidenceMcpServer,
  service: NativeExportsService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  evidenceById?: EvidenceLookup,
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_native_exports");
  const delivery = retainedSummaryDelivery(new Set([contract.name]), {
    recordEvidence,
    evidenceById,
  });
  const handler = createEvidenceToolHandler(
    server,
    async (rawInput, options) => {
      const parsed = contract.inputSchema.safeParse(rawInput);
      if (!parsed.success)
        return err(
          analysisInputErrorFromIssues(
            contract.name,
            parsed.error.issues,
            rawInput,
            { cause: parsed.error },
          ),
        );
      const { detail, ...input } = parsed.data;
      const parameters = { detail };
      const ready = delivery.preflight(contract.name, parameters);
      if (!ready.ok) return ready;
      const inspected = await service.inspect(input, options);
      return inspected.ok
        ? delivery.projectEvidence(contract.name, parameters, inspected.value)
        : inspected;
    },
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    applicationToolRegistrationOptions(contract),
    handler(contract),
  );
};
