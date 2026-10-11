import { describe, expect, it } from "vitest";

import { inspectWebNetworkCaptureInputSchema } from "./webNetworkCapture.js";
import { webModuleTraceInputSchema } from "./webModuleTrace.js";
import { exportWebScriptsInputSchema } from "./webScriptExport.js";
import { webSourceLocationInputSchema } from "./webSourceLocation.js";

const nul = "/tmp/selected\0filename";

/**
 * Every caller-selected local path these web tools accept must refuse NUL at
 * the contract boundary, matching the shared local-path schema used by the
 * other local-input tools. A NUL is not a valid filesystem byte on any
 * supported host, and a downstream `isAbsolute` check admits it.
 */
describe("web tool local path inputs", () => {
  it.each([
    [
      "export_web_scripts capture_path",
      () =>
        exportWebScriptsInputSchema.safeParse({
          capture_path: nul,
          output_directory: "/tmp/exported-scripts",
        }).success,
    ],
    [
      "export_web_scripts output_directory",
      () =>
        exportWebScriptsInputSchema.safeParse({
          capture_path: "/tmp/capture.json",
          output_directory: nul,
        }).success,
    ],
    [
      "inspect_web_network_capture capture_path",
      () =>
        inspectWebNetworkCaptureInputSchema.safeParse({
          capture_path: nul,
          format: "har",
        }).success,
    ],
    [
      "trace_web_source_location manifest_path",
      () =>
        webSourceLocationInputSchema.safeParse({
          manifest_path: nul,
          script_index: 0,
          source_map: { path: "/tmp/source.map", url: "http://127.0.0.1/a" },
          generated_position: { line: 1, column: 0 },
        }).success,
    ],
    [
      "trace_web_source_location source_map.path",
      () =>
        webSourceLocationInputSchema.safeParse({
          manifest_path: "/tmp/manifest.json",
          script_index: 0,
          source_map: { path: nul, url: "http://127.0.0.1/a" },
          generated_position: { line: 1, column: 0 },
        }).success,
    ],
    [
      "trace_web_module_imports manifest_path",
      () =>
        webModuleTraceInputSchema.safeParse({
          manifest_path: nul,
          script_index: 0,
        }).success,
    ],
    [
      "trace_web_module_imports import_map.path",
      () =>
        webModuleTraceInputSchema.safeParse({
          manifest_path: "/tmp/manifest.json",
          script_index: 0,
          import_map: { path: nul, base_url: "http://127.0.0.1/a" },
        }).success,
    ],
  ])("rejects NUL in %s", (_label, parse) => {
    expect(parse()).toBe(false);
  });

  it("still accepts ordinary absolute paths", () => {
    expect(
      exportWebScriptsInputSchema.safeParse({
        capture_path: "/tmp/capture.json",
        output_directory: "/tmp/exported-scripts",
      }).success,
    ).toBe(true);
    expect(
      inspectWebNetworkCaptureInputSchema.safeParse({
        capture_path: "/tmp/session.har",
        format: "har",
      }).success,
    ).toBe(true);
    expect(
      webModuleTraceInputSchema.safeParse({
        manifest_path: "/tmp/manifest.json",
        script_index: 0,
      }).success,
    ).toBe(true);
  });
});
