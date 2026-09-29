import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { packageHopperEnvironment } from "../../../scripts/verify-package-environment.mjs";

const workflowStepSchema = z
  .object({
    run: z.unknown().optional(),
    name: z.unknown().optional(),
    env: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const workflowSchema = z
  .object({
    jobs: z.record(
      z.string(),
      z
        .object({
          steps: z.array(workflowStepSchema).default([]),
          needs: z.union([z.array(z.string()), z.string()]).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
type Workflow = z.output<typeof workflowSchema>;

describe("package installation workflows", () => {
  it("runs package E2E without the retired native rebuild script", async () => {
    const continuousIntegration = await readWorkflow("ci.yml");
    const realHopperLinux = await readWorkflow("real-hopper-linux.yml");
    const realHopperMac = await readWorkflow("real-hopper.yml");

    expect(workflowJob(continuousIntegration, "package-e2e")).toMatchObject({
      strategy: { matrix: { os: ["ubuntu-latest", "macos-14"] } },
      steps: expect.arrayContaining([{ run: "npm run verify:package" }]),
    });
    expect(
      workflowJob(continuousIntegration, "static").steps.map(
        ({ run }: { readonly run?: unknown }) => run,
      ),
    ).toContain("npm run check:ci");
    expect(workflowJob(continuousIntegration, "test-shard")).toMatchObject({
      strategy: { matrix: { shard: ["1/4", "2/4", "3/4", "4/4"] } },
      steps: expect.arrayContaining([
        { run: "npm run test:ci:shard:run -- --shard=${{ matrix.shard }}" },
      ]),
    });
    const testJob = workflowJob(continuousIntegration, "test");
    expect(testJob.needs).toContain("test-shard");
    expect(testJob.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Require successful test shards",
          env: expect.objectContaining({
            CODE_REQUIRED: "${{ needs.changes.outputs.code }}",
          }),
        }),
        expect.objectContaining({
          run: expect.stringContaining("npm run test:ci:merge"),
        }),
      ]),
    );

    for (const workflow of [realHopperLinux, realHopperMac]) {
      const verifyJob = workflowJob(workflow, "verify");
      const verificationStep = verifyJob.steps.find(
        ({ run }: { readonly run?: unknown }) =>
          typeof run === "string" && run.includes("npm run verify:hopper"),
      );
      expect(
        verifyJob.steps.some(
          ({ run }: { readonly run?: unknown }) =>
            typeof run === "string" &&
            run.includes("npm install --global --ignore-scripts"),
        ),
      ).toBe(true);
      expect(verificationStep).toBeDefined();
      expect(verificationStep?.env).toMatchObject({
        REA_HOPPER_CONFORMANCE_MANIFEST_PATH:
          "${{ github.workspace }}/build/conformance/manifest.json",
      });
    }

    for (const workflow of [
      continuousIntegration,
      realHopperLinux,
      realHopperMac,
    ]) {
      const commands = Object.values(workflow.jobs).flatMap((job) =>
        job.steps.flatMap(({ run }: { readonly run?: unknown }) =>
          typeof run === "string" ? [run] : [],
        ),
      );
      expect(commands.join("\n")).not.toContain("npm run rebuild:native");
    }
  });

  it("verifies the package before publish and runs published canaries outside the checkout", async () => {
    const release = await readWorkflow("release.yml");

    const publishJob = workflowJob(release, "publish");
    const publishSteps = publishJob.steps;
    const verifyPackageIndex = publishSteps.findIndex(
      ({ run }: { readonly run?: unknown }) => run === "npm run verify:package",
    );
    const npmPublishIndex = publishSteps.findIndex(
      ({ run }: { readonly run?: unknown }) =>
        run === "npm publish --access public",
    );
    expect(verifyPackageIndex).toBeGreaterThanOrEqual(0);
    expect(npmPublishIndex).toBeGreaterThan(verifyPackageIndex);

    const publishedCanary = publishSteps.find(
      ({ name }: { readonly name?: unknown }) =>
        name === "Verify published CLI from npm",
    );
    expect(publishedCanary?.run).toContain(
      "scripts/verify-published-package.mjs",
    );
    const publisherJob = workflowJob(release, "publish-mcp");
    const publisherSteps = publisherJob.steps;
    expect(publisherJob).toMatchObject({
      needs: ["release-please", "publish"],
      permissions: { contents: "read", "id-token": "write" },
    });
    expect(
      publisherSteps.map(({ run }: { readonly run?: unknown }) => run),
    ).toEqual(
      expect.arrayContaining([
        "./mcp-publisher validate",
        "./mcp-publisher login github-oidc",
        "./mcp-publisher publish",
      ]),
    );
    expect(
      publisherSteps.find(
        ({ name }: { readonly name?: unknown }) =>
          name === "Install MCP Registry publisher",
      )?.env,
    ).toMatchObject({
      MCP_PUBLISHER_VERSION: "v1.8.0",
      MCP_PUBLISHER_SHA256_LINUX_AMD64: expect.any(String),
    });
  });

  it("uses direct Node ownership on macOS and Windows", () => {
    const root = "/tmp/rea-package";
    const expected = {
      HOPPER_LAUNCHER_PATH: process.execPath,
      HOPPER_LOADER_ARGS_JSON: JSON.stringify([
        `${root}/tests/fixtures/fakeLauncher.mjs`,
      ]),
    };

    expect(packageHopperEnvironment(root, "darwin")).toEqual(expected);
    expect(packageHopperEnvironment(root, "win32")).toEqual(expected);
    expect(packageHopperEnvironment(root, "linux")).toEqual({
      HOPPER_LAUNCHER_PATH: "/bin/sh",
      HOPPER_LOADER_ARGS_JSON: JSON.stringify([
        "-c",
        'node_path=$1; shift; "$node_path" "$@"',
        "rea-package-hopper",
        process.execPath,
        `${root}/tests/fixtures/fakeLauncher.mjs`,
      ]),
    });
  });
});

async function readWorkflow(path: string) {
  const yaml = await readFile(
    new URL(`../../../.github/workflows/${path}`, import.meta.url),
    "utf8",
  );
  return workflowSchema.parse(parse(yaml));
}

const workflowJob = (workflow: Workflow, name: string) => {
  const value = workflow.jobs[name];
  if (value === undefined) throw new Error(`Missing workflow job: ${name}`);
  return value;
};
