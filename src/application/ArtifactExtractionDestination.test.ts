import { describe, expect, it } from "vitest";

import { PermissionAuthority } from "./PermissionAuthority.js";
import { artifactExtractionPermissionRequest } from "./ArtifactExtractionDestination.js";
import { createPermissionPolicy } from "../domain/permissionPolicy.js";

describe("artifact extraction permission", () => {
  it("authorizes the REA-selected temporary destination with one stable grant", async () => {
    const request = artifactExtractionPermissionRequest();
    const { operation_identity: operationIdentity, ...scope } = request;
    const authority = new PermissionAuthority(
      createPermissionPolicy(
        [scope],
        [
          {
            ...scope,
            grant_id: "artifact-extraction-once",
            lifetime: "once",
            operation_identity: operationIdentity,
            expires_at: null,
          },
        ],
      ),
    );

    await expect(authority.authorize(request, "write")).resolves.toMatchObject({
      ok: true,
    });
    await expect(authority.authorize(request, "write")).resolves.toMatchObject({
      ok: false,
    });
  });
});
