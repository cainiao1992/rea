import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { Logger } from "pino";
import { registerEvidenceTools } from "./registerEvidenceTools.js";

/** Register provider-neutral static inspection operations. */
export const registerNativeTools = (
  server: EvidenceMcpServer,
  options: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly withAdmittedAnalysis: import("./analysisAdmission.js").WithAdmittedAnalysis;
  },
): void =>
  registerEvidenceTools(server, NATIVE_TOOL_CONTRACTS, {
    ...options,
  });
