import type { McpServer } from "@modelcontextprotocol/server";

import {
  buildReconstructionObligationLedgerEvidenceValidated,
  resolveReconstructionObligationLedgerRequest,
} from "../../application/ReconstructionObligationLedgerService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { reconstructionObligationLedgerInputSchema } from "../../domain/reconstructionObligationLedgerSchemas.js";
import { logToolExecution } from "../toolLogging.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { toCallToolResult } from "../toolResult.js";
import { recordResult, recordSources } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract(
  "build_reconstruction_obligation_ledger",
);

/** Register conservative reconstruction-obligation generation and closure. */
export const registerReconstructionObligationLedgerTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const parsed = safeParseToolInput(
        reconstructionObligationLedgerInputSchema,
        input,
        contract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, contract);
      const resolved = resolveReconstructionObligationLedgerRequest(
        parsed.value,
      );
      if (!resolved.ok) return toCallToolResult(resolved, contract);
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(
          buildReconstructionObligationLedgerEvidenceValidated(resolved.value),
        ),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      const recorded = recordSources(
        options.recordEvidence,
        resolved.value.evidence_bundle.records,
      );
      if (!recorded.ok) return toCallToolResult(recorded, contract);
      return recordResult(options, contract, result.value);
    },
  );
};
