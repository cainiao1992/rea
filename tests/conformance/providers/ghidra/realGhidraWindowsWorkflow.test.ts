import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("real Windows Ghidra workflow trust boundary", () => {
  it("runs only default-branch code on the fixed self-hosted environment", async () => {
    const workflow = parse(
      await readFile(
        new URL(
          "../../../../.github/workflows/real-ghidra-windows.yml",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    expect(workflow.on).toEqual({
      repository_dispatch: { types: ["real-ghidra-windows"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow).toMatchObject({
      jobs: {
        verify: {
          if: "github.ref == 'refs/heads/main'",
          environment: "real-ghidra-windows",
          "runs-on": ["self-hosted", "Windows", "x64", "ghidra-12-1-2"],
          steps: [
            {},
            { uses: "actions/setup-node@v4" },
            { run: "npm ci" },
            {
              env: { REA_ANALYSIS_PROVIDER: "ghidra" },
              run: "npm run verify:ghidra:windows | Tee-Object -FilePath windows-ghidra-proof.log",
            },
            {
              uses: "actions/upload-artifact@v4",
              with: { path: "windows-ghidra-proof.log" },
            },
          ],
        },
      },
    });
    expect(workflow.jobs.verify.steps).toHaveLength(5);
  });
});
