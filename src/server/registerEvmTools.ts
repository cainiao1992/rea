import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { EvmInterfaceService } from "../application/evm/EvmInterfaceService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { retainedSummaryDelivery } from "./retainedSummaryDelivery.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err } from "../domain/result.js";
import { evmInterfaceModule } from "../composition/evm.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { applicationToolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind the named EVM contract to shared validation and session Evidence recording. */
export const registerEvmTools = (
  server: EvidenceMcpServer,
  service: EvmInterfaceService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
  evidenceById?: EvidenceLookup,
): void => {
  const contract = evmInterfaceModule.contract;
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
