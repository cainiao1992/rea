import { describe, expect, it } from "vitest";

import { electronPageInspectionOptions } from "./cliObservationOptions.js";

describe("Electron CLI observation duration", () => {
  it("accepts caller-selected windows longer than ten seconds", () => {
    expect(
      electronPageInspectionOptions.parse({ observationMs: 60_000 })
        .observationMs,
    ).toBe(60_000);
  });
});
