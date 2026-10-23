import { requireAuthenticationHeadroom } from "../JsonAuthenticationHeadroom.js";

import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { INSPECT_ANALYSIS_VIEW_OPERATION } from "../../domain/analysisView/analysisViewErrors.js";
import { err, type Result } from "../../domain/result.js";
import type { Evidence } from "../../domain/evidence.js";
import { safeParseEvidence } from "../../domain/evidenceValidation.js";
import { EvidenceFileError } from "../../domain/evidenceErrors.js";
import { projectInputIssues } from "../../domain/inputIssueProjection.js";
import { readJsonFile } from "../JsonFiles.js";

/** The request's cancellation and the scope that owns descriptors whose close failed. */
export interface EvidenceFileReadOptions {
  readonly signal?: AbortSignal;
  readonly resources?: ArtifactResourceScope;
}

/** Read and authenticate one Evidence file under the request's cancellation and resource scope. */
export const readEvidenceFileSource = async (
  path: string,
  options: EvidenceFileReadOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const { signal, resources } = options;
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION, {
        cause: signal.reason,
      }),
    );
  const loaded = await readJsonFile(
    path,
    signal,
    resources,
    INSPECT_ANALYSIS_VIEW_OPERATION,
  );
  if (!loaded.ok) return loaded;
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION, {
        cause: signal.reason,
      }),
    );
  const headroom = requireAuthenticationHeadroom(loaded.value, {
    operation: INSPECT_ANALYSIS_VIEW_OPERATION,
    path,
    description: "Insufficient heap headroom to authenticate the Evidence file",
  });
  if (!headroom.ok) return headroom;
  const parsed = safeParseEvidence(loaded.value);
  return parsed.ok
    ? parsed
    : err(
        new EvidenceFileError("read", "wrong-kind", {
          path,
          cause: parsed.error,
          contentIssues: projectInputIssues(parsed.error.issues, loaded.value),
          userMessage:
            "The selected file does not contain valid Evidence. Repair or recreate the file and try again.",
        }),
      );
};
