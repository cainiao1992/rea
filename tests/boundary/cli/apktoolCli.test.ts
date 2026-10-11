import { expect, it } from "vitest";

import {
  expectConfigurationRefusal,
  serveCli as serve,
} from "./cliServeHarness.js";

it.each(["inspect-apktool-client", "decode-android-resources"])(
  "%s advertises a schema through the public CLI",
  async (command) => {
    const result = await serve([command, "--schema", "--json"]);
    expect(result.exitCode, command).toBe(0);
    const schema = JSON.parse(result.stdout) as { args?: unknown };
    expect(schema).toBeTruthy();
  },
);

it.each([
  [
    ["inspect-apktool-client", "--json"],
    "/nonexistent/apktool",
    "The selected apktool launcher was not found: /nonexistent/apktool. Set REA_APKTOOL_COMMAND",
  ],
  [
    ["decode-android-resources", "/targets/app.apk", "--json"],
    "/nonexistent/apktool",
    "The selected apktool launcher was not found: /nonexistent/apktool. Set REA_APKTOOL_COMMAND",
  ],
  [
    ["decode-android-resources", "/targets/app.apk", "--json"],
    "relative/apktool",
    "REA_APKTOOL_COMMAND must be an absolute path to the apktool launcher.",
  ],
])(
  "%j with REA_APKTOOL_COMMAND=%s names the host requirement",
  async (argv, command, reason) => {
    const result = await serve(argv, { REA_APKTOOL_COMMAND: command });
    expectConfigurationRefusal(result, reason);
  },
);

it("validates the locale option before launching apktool", async () => {
  const result = await serve([
    "decode-android-resources",
    "/targets/app.apk",
    "--locale",
    "not a locale",
    "--json",
  ]);
  expect(result.stdout).toContain("invalid");
});
