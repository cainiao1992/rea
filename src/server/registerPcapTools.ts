import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { PcapAnalysisService } from "../application/pcap/PcapAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import type { Logger } from "pino";
import {
  createContractToolHandler,
  createEvidenceToolHandler,
} from "./contractToolHandler.js";
import {
  toolRegistrationOptions,
  applicationToolRegistrationOptions,
} from "./toolRegistrationOptions.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { retainedSummaryDelivery } from "./retainedSummaryDelivery.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err } from "../domain/result.js";

/** Bind pcap handlers to their exact named contracts through admission. */
export const registerPcapTools = (
  server: EvidenceMcpServer,
  service: PcapAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
  evidenceById?: EvidenceLookup,
): void => {
  const handler = createContractToolHandler(
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  const clientContract = toolContract("inspect_pcap_client");
  server.registerTool(
    clientContract.name,
    toolRegistrationOptions(clientContract),
    handler(clientContract),
  );
  const contract = toolContract("inspect_pcap_capture");
  const delivery = retainedSummaryDelivery(new Set([contract.name]), {
    recordEvidence,
    evidenceById,
  });
  const capture = createEvidenceToolHandler(
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
      const result = await service.execute(contract.name, input, options);
      return result.ok
        ? delivery.projectEvidence(contract.name, parameters, result.value)
        : result;
    },
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    applicationToolRegistrationOptions(contract),
    capture(contract),
  );
};
