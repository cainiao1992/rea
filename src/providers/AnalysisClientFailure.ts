import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";

/** Attribute producer-owned failure facts without inferring interruption. */
export const analysisClientFailureForOperation = (
  cause: unknown,
  providerId: string,
  operation: string,
): AnalysisError => {
  if (!(cause instanceof AnalysisError)) {
    const failure = new ProviderAdapterError(providerId, operation, {
      cause,
      ...(cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
        ? { cleanup: cause.cleanup }
        : {}),
    });
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
  if (
    !(cause instanceof AnalysisCancelledError) &&
    !(cause instanceof ProviderAdapterError) &&
    !(cause instanceof AnalysisCapabilityUnavailableError)
  )
    return cause;
  const context = {
    cause,
    ...(cause.cleanupPrimary === undefined
      ? {}
      : {
          cleanupPrimary: analysisClientFailureForOperation(
            cause.cleanupPrimary,
            providerId,
            operation,
          ),
        }),
    ...(cause.partialObservation === undefined
      ? {}
      : { partialObservation: cause.partialObservation }),
    ...(cause.capturedOutput === undefined
      ? {}
      : { capturedOutput: cause.capturedOutput }),
    ...(cause.diagnostics === undefined
      ? {}
      : { diagnostics: cause.diagnostics }),
    ...(cause.cleanupIncomplete
      ? {
          cleanup: {
            reason: cause.cleanup?.reason ?? cause.message,
            resources: cause.cleanupResources,
          },
        }
      : {}),
  };
  const result =
    cause instanceof AnalysisCancelledError
      ? new AnalysisCancelledError(operation, {
          ...context,
          cause: cause.cause,
        })
      : cause instanceof AnalysisCapabilityUnavailableError
        ? new AnalysisCapabilityUnavailableError(
            cause.providerId,
            operation,
            cause.reason,
            {
              ...context,
              ...(cause.userMessage === undefined
                ? {}
                : { userMessage: cause.userMessage }),
              retryable: cause.retryable,
            },
          )
        : new ProviderAdapterError(providerId, operation, {
            ...context,
            ...(cause.userMessage === undefined
              ? {}
              : { userMessage: cause.userMessage }),
            ...(cause.remediationAction === undefined
              ? {}
              : { remediationAction: cause.remediationAction }),
          });
  return cause.cleanupIncomplete
    ? result.bindCleanupDependencies([cause])
    : result;
};
