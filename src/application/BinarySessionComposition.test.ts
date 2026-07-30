import { describe, expect, it } from "vitest";

import type {
  AnalysisClient,
  AnalysisProvider,
  ProviderIdentity,
} from "./AnalysisProvider.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { composeBinarySession } from "./BinarySessionComposition.js";

const auxiliaryProvider = (identity: ProviderIdentity): AnalysisProvider => ({
  identity: () => identity,
  capabilities: () => [],
  createClient: (): AnalysisClient => {
    throw new Error("The composition check must not create provider clients");
  },
});

describe("composeBinarySession", () => {
  it("exposes the complete configured provider set without starting clients", () => {
    const session = composeBinarySession(new AnalysisProviderRegistry([]), [
      auxiliaryProvider({
        id: "test-auxiliary",
        name: "Test auxiliary provider",
        version: "1.0.0",
      }),
    ]);

    expect(session.providerIdentity()).toEqual({
      id: "composite:test-auxiliary",
      name: "REA composite analysis provider",
      version: null,
    });
  });
});
