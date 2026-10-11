import { describe, expect, it } from "vitest";

import { adbHostFileName } from "./AdbHostFileName.js";

describe("adbHostFileName", () => {
  it.each([
    ["/data/local/tmp/notes.txt", "notes.txt"],
    ["/data/data/com.example/databases/app.db", "app.db"],
    ["/sdcard/My Notes.txt", "My Notes.txt"],
    ["/system/etc/hosts", "hosts"],
    [
      "/data/local/tmp/split_config.arm64_v8a.apk",
      "split_config.arm64_v8a.apk",
    ],
    ["/data/local/tmp/résumé.xml", "résumé.xml"],
    ["/data/local/tmp/a-b_c.d", "a-b_c.d"],
    ["/data/local/tmp/", "tmp"],
  ])("accepts the portable device path %s", (devicePath, fileName) => {
    expect(adbHostFileName(devicePath)).toEqual({ ok: true, fileName });
  });

  it.each([
    ["/", "empty_file_name"],
    ["/data/local/tmp/..", "dot_segment"],
    ["/data/local/tmp/.", "dot_segment"],
    ["/data/local/tmp/a\\b", "path_separator"],
    ["/data/local/tmp/re\u007fport", "control_character"],
    ["/data/local/tmp/ta\tb", "control_character"],
    ["/data/local/tmp/CON", "reserved_name"],
    ["/data/local/tmp/nul.txt", "reserved_name"],
    ["/data/local/tmp/com1", "reserved_name"],
    ["/data/local/tmp/LPT9", "reserved_name"],
    ["/data/local/tmp/report:2024", "alternate_data_stream"],
    ["/data/local/tmp/report.", "trailing_dot_or_space"],
    ["/data/local/tmp/report ", "trailing_dot_or_space"],
    ["/data/local/tmp/a*b.txt", "unsupported_character"],
    ["/data/local/tmp/a?b.txt", "unsupported_character"],
  ] as const)("refuses %s as %s", (devicePath, reason) => {
    expect(adbHostFileName(devicePath)).toEqual({ ok: false, reason });
  });
});
