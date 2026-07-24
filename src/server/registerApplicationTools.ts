import type { McpServer } from "@modelcontextprotocol/server";

import { registerTraceFeatureTool } from "./registerApplicationTools/traceFeature.js";
import { registerTraceJavaScriptSemanticsTool } from "./registerApplicationTools/traceSemantics.js";
import { registerCompareApplicationVersionsTool } from "./registerApplicationTools/compareVersions.js";
import { registerCompareSourceToBundleTool } from "./registerApplicationTools/compareSourceToBundle.js";
import { registerCompareJavaScriptExportShapesTool } from "./registerApplicationTools/compareExportShapes.js";
import { registerControlledReplayTool } from "./registerApplicationTools/controlledReplay.js";
import { registerCharacterizationTools } from "./registerApplicationTools/characterization.js";
import { registerCoverageTools } from "./registerApplicationTools/coverage.js";
import { registerReconstructionObligationLedgerTool } from "./registerApplicationTools/obligationLedger.js";
import { registerReconstructionReadinessTool } from "./registerApplicationTools/readiness.js";
import type { ApplicationToolRegistration } from "./registerApplicationTools/types.js";

export type { ApplicationToolRegistration };

/** Register provider-neutral JavaScript application graph workflows. */
export const registerApplicationTools = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  registerTraceFeatureTool(server, options);
  registerTraceJavaScriptSemanticsTool(server, options);
  registerCompareApplicationVersionsTool(server, options);
  registerCompareSourceToBundleTool(server, options);
  registerCompareJavaScriptExportShapesTool(server, options);
  registerControlledReplayTool(server, options);
  registerCharacterizationTools(server, options);
  registerReconstructionObligationLedgerTool(server, options);
  registerReconstructionReadinessTool(server, options);
  registerCoverageTools(server, options);
};
