import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
  ProviderRequestActivitySnapshot,
  ProviderRuntimeLineageSnapshot,
} from "./AnalysisProvider.js";

type LoadAnalysisProvider = () => Promise<AnalysisProvider>;

/**
 * Preserve synchronous provider discovery while loading implementation modules
 * only when a target-bound client first executes.
 */
export class LazyAnalysisProvider implements AnalysisProvider {
  readonly #providerIdentity: ProviderIdentity;
  readonly #capabilityDescriptors: readonly CapabilityDescriptor[];
  readonly #loadProvider: LoadAnalysisProvider;
  #provider: Promise<AnalysisProvider> | undefined;

  constructor(options: {
    readonly identity: ProviderIdentity;
    readonly capabilities: readonly CapabilityDescriptor[];
    readonly load: LoadAnalysisProvider;
  }) {
    this.#providerIdentity = options.identity;
    this.#capabilityDescriptors = options.capabilities;
    this.#loadProvider = options.load;
  }

  /** Return generated provider identity without loading its implementation. */
  identity(): ProviderIdentity {
    return this.#providerIdentity;
  }

  /** Return generated capability metadata without loading its implementation. */
  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilityDescriptors;
  }

  /** Create a client whose implementation is loaded on first execution. */
  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    context?: AnalysisClientContext,
  ): AnalysisClient {
    return new LazyAnalysisClient(async () => {
      const provider = await this.#load();
      return provider.createClient(target, profile, context);
    });
  }

  async #load(): Promise<AnalysisProvider> {
    this.#provider ??= this.#loadProvider().catch((cause: unknown) => {
      this.#provider = undefined;
      throw cause;
    });
    return this.#provider;
  }
}

class LazyAnalysisClient implements AnalysisClient {
  readonly #loadClient: () => Promise<AnalysisClient>;
  #client: AnalysisClient | undefined;
  #loading: Promise<AnalysisClient> | undefined;
  #closed = false;

  constructor(loadClient: () => Promise<AnalysisClient>) {
    this.#loadClient = loadClient;
  }

  execute: AnalysisClient["execute"] = async (
    operation,
    parameters,
    options,
  ) => {
    const client = await this.#load();
    return client.execute(operation, parameters, options);
  };

  runtimeLineageSnapshots(): readonly ProviderRuntimeLineageSnapshot[] {
    return this.#client?.runtimeLineageSnapshots?.() ?? [];
  }

  requestActivitySnapshots(): readonly ProviderRequestActivitySnapshot[] {
    return this.#client?.requestActivitySnapshots?.() ?? [];
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#loading === undefined) return;
    const client = await this.#loading;
    await client.close();
  }

  async #load(): Promise<AnalysisClient> {
    if (this.#closed) throw new Error("Lazy analysis client is closed");
    this.#loading ??= this.#loadClient()
      .then((client) => {
        this.#client = client;
        return client;
      })
      .catch((cause: unknown) => {
        this.#loading = undefined;
        throw cause;
      });
    return this.#loading;
  }
}
