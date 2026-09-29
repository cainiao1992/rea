import { describe, expect, it } from "vitest";

import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

describe("binary session", () => {
  it("returns detached provider and target metadata", async () => {
    const [first] = await createBinarySessionTargets();
    const session = createTestBinarySession(createCacheProvider([]));
    expect((await session.open(first)).ok).toBe(true);
    expect(session.status()).toMatchObject({
      analysis_run: {
        run_id: expect.any(String),
        process_lineage: { status: "not_observed" },
      },
    });
    expect(session.listUnknowns()).toEqual([]);
    const identity = session.providerIdentity();
    Reflect.set(identity, "id", "forged");
    expect(session.providerIdentity().id).toBe("fixture");

    const active = session.activeTarget();
    expect(active).toBeDefined();
    if (active !== undefined) Reflect.set(active, "path", "/tmp/forged");
    expect(session.activeTarget()?.path).toBe(first);

    await session.close();
  });
});
