import type { ByteEntropyService } from "../application/binaryDiagnostics/ByteEntropyService.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import { retainedSummaryDelivery } from "./retainedSummaryDelivery.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { runEvidenceToolOperation } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

/** Reject an unretained byte-entropy summary before reading the selected file. */
export const registerByteEntropyTool = (
  server: EvidenceMcpServer,
  entropyService: ByteEntropyService,
  logger: Logger,
  recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
  evidenceById: EvidenceLookup | undefined,
  withAdmittedAnalysis: WithAdmittedAnalysis | undefined,
): void => {
  const contract = toolContract("inspect_byte_entropy");
  const delivery = retainedSummaryDelivery(contract.name, {
    recordEvidence,
    evidenceById,
  });
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async ({ detail, ...request }, context) =>
      runEvidenceToolOperation(
        { server, logger, recordEvidence, withAdmittedAnalysis },
        contract,
        undefined,
        { input: request, context },
        async (input, { signal }) => {
          const parameters = { detail };
          const ready = delivery.preflight(parameters);
          if (!ready.ok) return ready;
          const inspected = await entropyService.inspect(input, { signal });
          return inspected.ok
            ? delivery.projectEvidence(parameters, inspected.value)
            : inspected;
        },
      ),
  );
};
