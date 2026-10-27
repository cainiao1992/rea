import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([
  ["complete", '{"kind":"android","facet":"components"}', "view"],
  ["summary", '{"kind":"android","facet":"components"}', "evidence_output"],
  [
    "summary",
    '{"kind":"android","facet":"components","fields":["invented"]}',
    "view",
  ],
  ["summary", "{broken", "view"],
] as const)(
  "rejects invalid Android delivery before missing APK/JAR work (%s, %s)",
  async ([detail, view, field], { cli }) => {
    const result = await cli.run({
      arguments: [
        "inspect-android-package",
        "/nonexistent/selected.apk",
        "--detail",
        detail,
        "--view",
        view,
        "--json",
      ],
      environment: {
        REA_JADX_MCP_JAR: "/nonexistent/selected-engine.jar",
        REA_LOG_LEVEL: "silent",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: expect.arrayContaining([field]) }),
        ]),
      },
    });
  },
);
