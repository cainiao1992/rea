import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

/** Project the command owner's bounded output without losing examined byte counts. */
export const capturedApktoolCommandOutput = (
  output: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: output.stdout.text,
  stderr: output.stderr.text,
  truncated:
    output.diagnosticTruncated === true || output.outputIncomplete === true,
  stdout_bytes: output.stdout.observedBytes,
  stderr_bytes: output.stderr.observedBytes,
  exit_code: output.exitCode ?? null,
  signal: output.signal ?? null,
});
