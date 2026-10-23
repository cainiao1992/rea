import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32")(
  "doctor rejects an IDA registration FIFO without waiting for a writer",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ida-doctor-fifo-");
    const registration = join(root, "registration.json");
    execFileSync("mkfifo", [registration], { timeout: 5_000 });
    const result = await cli.run({
      arguments: ["doctor", "--provider", "ida", "--json"],
      environment: { HOME: root, REA_IDA_MCP_CONFIG: registration },
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      providerInspections: expect.arrayContaining([
        expect.objectContaining({
          id: "ida",
          available: false,
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "registration",
              ok: false,
              detail: expect.stringContaining("regular JSON file"),
            }),
          ]),
        }),
      ]),
    });
  },
);

cliTest.skipIf(process.platform !== "darwin").for([true, false])(
  "doctor checks the IDA workspace parent without creating entries (usable=%s)",
  async (usable, { cli }) => {
    const root = await createTestTempDirectory("rea-ida-doctor-parent-");
    const parent = join(root, "parent");
    await mkdir(parent);
    // Keep the caller's unnormalized spelling; allocation normalizes it too.
    const workspaceRoot = usable
      ? `${parent}/missing/../.`
      : join(parent, "absent");
    const registration = join(root, "registration.json");
    await writeFile(
      registration,
      JSON.stringify({
        command: join(root, "provider-must-not-launch"),
        mode: "headless",
        workspaceRoot,
      }),
    );
    const result = await cli.run({
      arguments: ["doctor", "--provider", "ida", "--json"],
      environment: { HOME: root, REA_IDA_MCP_CONFIG: registration },
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(usable ? 0 : 1);
    expect(result.json).toMatchObject({
      providerInspections: expect.arrayContaining([
        expect.objectContaining({
          id: "ida",
          available: usable,
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "private_workspace",
              ok: usable,
              detail: expect.stringContaining(workspaceRoot),
            }),
          ]),
        }),
      ]),
    });
    expect(await readdir(parent)).toEqual([]);
  },
);

cliTest.for([
  {
    name: "native headless lifecycle conflict",
    registration: {
      mode: "headless",
      protocol: "native",
      url: "http://127.0.0.1:13337/mcp",
    },
    constraint: "requires attached mode",
  },
  {
    name: "nonlocal endpoint",
    registration: {
      url: "http://192.0.2.10:13337/mcp",
      headers: { Authorization: "Bearer registration-secret" },
    },
    constraint: "local HTTP endpoint without URL credentials",
  },
  {
    name: "relative workspace root",
    registration: {
      command: "provider-must-not-launch",
      workspaceRoot: "relative",
    },
    constraint: "workspaceRoot must be absolute",
  },
  {
    name: "valid registration",
    registration: { command: "provider-must-not-launch", args: [] },
    constraint: undefined,
  },
] as const)(
  "doctor retains the IDA registration constraint: $name",
  async ({ registration, constraint }, { cli }) => {
    const root = await createTestTempDirectory("rea-ida-doctor-constraint-");
    const path = join(root, "registration.json");
    await writeFile(path, JSON.stringify(registration));
    const result = await cli.run({
      arguments: ["doctor", "--provider", "ida", "--json"],
      environment: { HOME: root, REA_IDA_MCP_CONFIG: path },
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(
      constraint === undefined ? 0 : 1,
    );
    expect(result.json).toMatchObject({
      providerInspections: expect.arrayContaining([
        expect.objectContaining({
          id: "ida",
          available: constraint === undefined,
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "registration",
              ok: constraint === undefined,
              detail: expect.stringContaining(
                constraint ?? "no IDA process was launched",
              ),
            }),
          ]),
        }),
      ]),
    });
    expect(result.stdout).not.toContain("registration-secret");
  },
);
