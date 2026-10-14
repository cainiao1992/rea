import type {
  AnalysisOperation,
  ProviderIdentity,
} from "./AnalysisProvider.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

/** One provider-owned caveat tied to the operation that reported it. */
export interface SourceLimitation {
  readonly provider: ProviderIdentity;
  readonly operation: AnalysisOperation;
  readonly limitation: string;
}

/** Stable exact-provenance key for deduplication before rendering. */
export const sourceLimitationKey = ({
  provider,
  operation,
  limitation,
}: SourceLimitation): string =>
  JSON.stringify([
    provider.id,
    provider.name,
    provider.version,
    operation,
    limitation,
  ]);

/** Render unique source caveats without losing their provider or operation. */
export const renderSourceLimitations = (
  limitations: readonly SourceLimitation[],
): string[] => {
  const rendered = new Map<string, string>();
  for (const { provider, operation, limitation } of limitations) {
    const provenance = sourceLimitationKey({
      provider,
      operation,
      limitation,
    });
    const version = provider.version === null ? "" : ` ${provider.version}`;
    rendered.set(
      provenance,
      `${provider.name} (${provider.id}${version}) ${operation}: ${limitation}`,
    );
  }
  return [...rendered.values()].sort(compareUnicodeCodePoints);
};
