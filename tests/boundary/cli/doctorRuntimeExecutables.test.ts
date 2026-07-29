import { describe, expect, it } from "vitest";

import { runDoctor, type DoctorHost } from "../../../src/application/Doctor.js";
import { CATALOG_IDENTITY } from "../../../src/catalogIdentity.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";

const host = (overrides: Partial<DoctorHost> = {}): DoctorHost => ({
  platform: "darwin",
  architecture: "x64",
  nodeVersion: "24.18.0",
  macosVersion: () => Promise.resolve("12.0"),
  linuxDistribution: () => Promise.resolve(undefined),
  validTarget: (path) => Promise.resolve(path.includes("Hopper")),
  executable: (path) => Promise.resolve(path.includes("Hopper")),
  supportedLinuxHopper: () => Promise.resolve(true),
  linuxDemoRuntimeCheck: () =>
    Promise.resolve({
      name: "hopper-demo-runtime",
      ok: true,
      classification: "healthy",
    }),
  brewHopperPath: () => Promise.resolve(undefined),
  manualHopperPaths: () => Promise.resolve([]),
  installedSkillIdentity: () =>
    Promise.resolve({
      version: PRODUCT_IDENTITY.skillVersion,
      toolCount: CATALOG_IDENTITY.counts.mcp_tools,
      catalogDigest: CATALOG_IDENTITY.digests.combined_sha256,
    }),
  ...overrides,
});

describe("doctor runtime executable diagnostics", () => {
  it("reports a broken shadowed Node candidate without hiding the healthy launcher", async () => {
    const result = await runDoctor(
      undefined,
      host({
        runtimeExecutables: () =>
          Promise.resolve({
            launcher_node: "/healthy/node",
            candidates: [
              {
                tool: "node",
                lexical_path: "/healthy/node",
                canonical_path: "/healthy/node",
                path_index: null,
                selection: "rea-launcher",
                version: "v24.18.0",
                healthy: true,
                failure: null,
              },
              {
                tool: "node",
                lexical_path: "/opt/homebrew/bin/node",
                canonical_path: "/opt/homebrew/Cellar/node/25.2.1/bin/node",
                path_index: 2,
                selection: "path-shadowed",
                version: null,
                healthy: false,
                failure: {
                  code: "runtime_dynamic_library_missing",
                  exit_code: 134,
                  signal: null,
                  dependency:
                    "/opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib",
                  stderr: "dyld: Library not loaded",
                },
              },
            ],
          }),
      }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity?.runtime_executables).toMatchObject({
      launcher_node: "/healthy/node",
      candidates: [
        { healthy: true, selection: "rea-launcher" },
        {
          healthy: false,
          failure: { code: "runtime_dynamic_library_missing" },
        },
      ],
    });
    expect(
      result.checks.find(({ name }) => name === "node-toolchains"),
    ).toMatchObject({
      ok: false,
      classification: "missing_dependency",
      remediation: expect.stringContaining("Do not create"),
    });
  });
});
