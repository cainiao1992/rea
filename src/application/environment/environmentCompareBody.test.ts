import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import {
  environmentServeSource,
  environmentStateServeFixture,
} from "../../../tests/fixtures/environmentServe.js";
import { compareEnvironment } from "./environmentCompare.js";

const responseCapture = (
  text: string,
  base64?: string,
  mimeType = "application/octet-stream",
): ReturnType<typeof analysisViewCaptureEvidence> => {
  const capture = environmentManifestCaptureFixture([
    {
      startedDateTime: "2026-10-17T18:00:00.000Z",
      request: { method: "GET", url: "http://app.example/api/blob" },
      response: {
        status: 200,
        content: {
          mimeType,
          text,
          ...(base64 === undefined ? {} : { encoding: "base64" }),
        },
      },
    },
  ]);
  if (base64 !== undefined) {
    const bytes = Buffer.from(base64, "base64");
    capture.records[0]!.binary_fields = [
      {
        pointer: "/response/content/text",
        representation: "har-base64-content",
        state: "retained",
        content_base64: base64,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ];
  }
  return analysisViewCaptureEvidence(capture);
};

const compare = (
  recorded: ReturnType<typeof analysisViewCaptureEvidence>,
  probe: ReturnType<typeof analysisViewCaptureEvidence>,
) => {
  const fixture = environmentStateServeFixture(recorded);
  const report = compareEnvironment({
    source: environmentServeSource(fixture),
    captureValue: recorded,
    probes: [{ label: "probe", value: probe }],
    operation: "environment-compare",
  });
  if (!report.ok) throw report.error;
  return report.value;
};

describe("environment comparison response representation", () => {
  it("distinguishes binary byte ff from its base64 spelling as literal text", () => {
    const binary = responseCapture("/w==", "/w==");
    const literal = responseCapture("/w==");
    const result = compare(binary, literal);
    expect(result.probes[0]?.results[0]?.equal).toBe(false);
    expect(result.probes[0]?.results[0]?.categories).toEqual(["value"]);
  });

  it("compares equal retained binary bytes and valid UTF-8 base64 as text", () => {
    expect(
      compare(responseCapture("/w==", "/w=="), responseCapture("/w==", "/w=="))
        .probes[0]?.results[0]?.equal,
    ).toBe(true);
    expect(
      compare(responseCapture("aGVsbG8=", "aGVsbG8="), responseCapture("hello"))
        .probes[0]?.results[0]?.equal,
    ).toBe(true);
  });

  it("does not conflate a JSON string value with identical plain text", () => {
    const json = responseCapture('"hello"', undefined, "application/json");
    const text = responseCapture("hello");
    expect(compare(json, text).probes[0]?.results[0]?.equal).toBe(false);
  });
});
