import { expect, it } from "vitest";

import { serveCli as serve } from "./cliServeHarness.js";

it.each([
  ["inspect-adb-client"],
  ["list-adb-devices"],
  ["inspect-adb-device"],
  ["list-adb-packages"],
  ["pull-adb-package"],
  ["read-adb-logcat"],
  ["inspect-adb-package"],
  ["pull-adb-file"],
  ["push-adb-file"],
  ["capture-adb-screen"],
  ["list-adb-processes"],
  ["list-adb-directory"],
  ["list-adb-features"],
  ["list-adb-services"],
  ["inspect-adb-display"],
  ["inspect-adb-window"],
  ["read-adb-setting"],
  ["collect-adb-bugreport"],
  ["resolve-adb-packages"],
  ["install-adb-package"],
  ["uninstall-adb-package"],
  ["start-adb-app"],
  ["start-adb-activity"],
  ["stop-adb-app"],
])("%s advertises a schema through the public CLI", async (command) => {
  const result = await serve([command, "--schema", "--json"]);
  expect(result.exitCode, command).toBe(0);
  const schema = JSON.parse(result.stdout) as { args?: unknown };
  expect(schema).toBeTruthy();
});

it.each([
  ["inspect-adb-client", "/nonexistent/adb", "not found"],
  ["list-adb-devices", "relative/adb", "absolute path"],
])(
  "%s names the adb configuration requirement",
  async (command, binary, cause) => {
    const result = await serve([command, "--json"], {
      REA_ADB_PATH: binary,
    });
    const output = JSON.parse(result.stdout) as {
      code?: unknown;
      message?: unknown;
      remediation?: { action?: unknown };
    };
    expect(output.code).toBe("capability_unavailable");
    expect(output.message).toEqual(expect.stringContaining(cause));
    expect(output.message).toEqual(expect.stringContaining("REA_ADB_PATH"));
    expect(output.remediation?.action).toEqual(
      expect.stringContaining("REA_ADB_PATH"),
    );
  },
);

it("validates device serials before contacting any device", async () => {
  const result = await serve(["inspect-adb-device", "bad serial", "--json"]);
  expect(result.stdout).toContain("invalid_input");
});

it("requires the output directory option on pull", async () => {
  const result = await serve([
    "pull-adb-package",
    "emulator-5554",
    "com.example",
    "--json",
  ]);
  expect(result.exitCode).not.toBe(0);
});
