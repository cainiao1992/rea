import { describe, expect, it } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

describe("managed artifact failure classification", () => {
  it("distinguishes native, malformed, and unsupported metadata", () => {
    const nativeBytes = buildNativePeFixture();
    const native = inspectManagedArtifactBytes(
      nativeBytes,
      managedPeFixtureTarget(nativeBytes),
    );
    expect(native).toMatchObject({
      classification: { status: "not-managed" },
      metadata: { status: "absent" },
      coverage: { state: "unavailable" },
    });

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedArtifactBytes(
      malformedBytes,
      managedPeFixtureTarget(malformedBytes),
    );
    expect(malformed.classification.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);

    const unsupportedTableBytes = buildManagedPeFixture({
      metadataValidMaskExtra: 1n << 50n,
    });
    const unsupportedTable = inspectManagedArtifactBytes(
      unsupportedTableBytes,
      managedPeFixtureTarget(unsupportedTableBytes),
    );
    expect(unsupportedTable.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-tables" }),
    ]);
  });
});
