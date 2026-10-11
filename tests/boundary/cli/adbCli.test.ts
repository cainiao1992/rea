import { expect, it } from "vitest";

import {
  expectConfigurationRefusal,
  serveCli as serve,
} from "./cliServeHarness.js";

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
  [
    ["inspect-adb-client", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "relative/adb",
    "REA_ADB_PATH must be an absolute path to the adb binary.",
  ],
])(
  "%j with REA_ADB_PATH=%s names the host requirement",
  async (argv, binary, reason) => {
    const result = await serve(argv, { REA_ADB_PATH: binary });
    expectConfigurationRefusal(result, reason);
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
