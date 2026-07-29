import type {
  AnalysisClientFactory,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisProvider,
} from "./AnalysisProvider.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { BinarySession } from "./BinarySession.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { AnalysisError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";

type BinarySessionOptions = {
  readonly resolveAnalysisProfile?: (
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) => Promise<Result<AnalysisProfileResolution, AnalysisError>>;
};

type BinarySessionOptionsOrResolver =
  | BinarySessionOptions
  | BinarySessionOptions["resolveAnalysisProfile"];

const normalizeBinarySessionOptions = (
  optionsOrResolver?: BinarySessionOptionsOrResolver,
): BinarySessionOptions =>
  typeof optionsOrResolver === "function"
    ? { resolveAnalysisProfile: optionsOrResolver }
    : (optionsOrResolver ?? {});

/**
 * Compose one provider-neutral session from deep-provider selection and
 * disjoint auxiliary operation families.
 */
export const composeBinarySession = (
  registry: AnalysisProviderRegistry | SessionProviderRouter,
  auxiliaryProviders: readonly AnalysisProvider[] = [],
): BinarySession =>
  new BinarySession(
    registry instanceof SessionProviderRouter
      ? registry
      : SessionProviderRouter.selectable(registry, auxiliaryProviders),
  );

/**
 * Compose a session through the same internal seam for focused adapter tests.
 * The constructor remains private to this composition module, so callers test
 * provider behavior without coupling to BinarySession construction.
 */
export const composeBinarySessionFromFactory = (
  provider: AnalysisProvider | AnalysisClientFactory | SessionProviderRouter,
  optionsOrResolver?: BinarySessionOptionsOrResolver,
): BinarySession =>
  new BinarySession(provider, normalizeBinarySessionOptions(optionsOrResolver));

/** Compose a focused session from any provider-shaped test seam. */
export const composeBinarySessionFromProvider = (
  provider: AnalysisProvider | AnalysisClientFactory | SessionProviderRouter,
  optionsOrResolver?: BinarySessionOptionsOrResolver,
): BinarySession =>
  new BinarySession(provider, normalizeBinarySessionOptions(optionsOrResolver));
