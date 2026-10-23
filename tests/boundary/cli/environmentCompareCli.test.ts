import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
  timedCaptureEvidence,
} from "../../fixtures/analysisView.js";
import { environmentStateServeFixture } from "../../fixtures/environmentServe.js";
import {
  BOOK_NOT_FOUND,
  BOOK_ROWS,
  FIRST_BOOK,
  book,
} from "../../fixtures/environmentStateWrites.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/** The books environment and a probe of the application re-seeded under other ids, written as Evidence files. */
const writeCompareFiles = async (root: string) => {
  const fixture = environmentStateServeFixture(timedCaptureEvidence(BOOK_ROWS));
  const first = book(101, "First Book", "2026-10-20T09:00:00Z");
  const second = book(102, "Second Book", "2026-10-20T10:00:00Z");
  const probe = timedCaptureEvidence([
    ["GET", "/api/books", [first, second]],
    ["DELETE", "/api/books/102", "", 204],
    ["GET", "/api/books/102", BOOK_NOT_FOUND, 404],
  ]);
  const paths = {
    manifest: join(root, "manifest.json"),
    capture: join(root, "capture.json"),
    probe: join(root, "probe.json"),
  };
  await writeFile(paths.manifest, JSON.stringify(fixture.manifest));
  await writeFile(paths.capture, JSON.stringify(fixture.capture));
  await writeFile(paths.probe, JSON.stringify(probe));
  return paths;
};

/** The exact chronology and clock-format probes share one unchanged source capture. */
const writeExactClockFiles = async (
  root: string,
): Promise<Map<string, string>> => {
  const capture = timedCaptureEvidence([
    ["GET", "/api/books", [FIRST_BOOK]],
    ["GET", "/api/books/1", FIRST_BOOK],
    ["DELETE", "/api/books/1", "", 204],
    ["GET", "/api/books/1", BOOK_NOT_FOUND, 404],
  ]);
  const fixture = environmentStateServeFixture(capture);
  const ordered = analysisViewCaptureEvidence(
    environmentManifestCaptureFixture([
      {
        startedDateTime: "0001-01-01T00:00:00.0000000002Z",
        request: { method: "GET", url: "http://app.example/api/books/1" },
        response: {
          status: 404,
          content: {
            mimeType: "application/json",
            text: JSON.stringify(BOOK_NOT_FOUND),
          },
        },
      },
      {
        startedDateTime: "0001-01-01T01:00:00.0000000001+01:00",
        request: {
          method: "DELETE",
          url: "http://app.example/api/books/1",
        },
        response: {
          status: 204,
          content: { mimeType: "application/json", text: "" },
        },
      },
    ]),
  );
  const clocks = timedCaptureEvidence([
    [
      "GET",
      "/api/books/1",
      { ...FIRST_BOOK, created_at: "0001-01-01 00:00:00.000Z" },
    ],
  ]);
  const originals = new Map<string, string>();
  for (const [name, value] of [
    ["manifest.json", fixture.manifest],
    ["capture.json", capture],
    ["order.json", ordered],
    ["clocks.json", clocks],
  ] as const) {
    const path = join(root, name);
    const text = JSON.stringify(value);
    originals.set(path, text);
    await writeFile(path, text);
  }
  return originals;
};

describe("rea environment-compare", () => {
  cliTest(
    "preserves exact probe chronology and first-century clock-format differences",
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-environment-exact-clock-",
      );
      const originals = await writeExactClockFiles(root);
      const result = await cli.run({
        arguments: [
          "environment-compare",
          join(root, "manifest.json"),
          "--evidence",
          join(root, "capture.json"),
          "--probe",
          join(root, "order.json"),
          "--probe",
          join(root, "clocks.json"),
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.json).toMatchObject({
        status: "complete",
        environment: { state: "served" },
        summary: { probes: 2, steps: 3, equal: 2 },
        probes: [
          {
            label: "order.json",
            results: [
              {
                ordinal: 1,
                method: "DELETE",
                live_status: 204,
                env_status: 204,
                equal: true,
              },
              {
                ordinal: 0,
                method: "GET",
                live_status: 404,
                env_status: 404,
                equal: true,
              },
            ],
          },
          {
            label: "clocks.json",
            results: [
              {
                categories: ["clock-format"],
                differences: [
                  {
                    category: "clock-format",
                    pointer: "/created_at",
                    live: '"0001-01-01 00:00:00.000Z"',
                  },
                ],
              },
            ],
          },
        ],
      });
      for (const [path, text] of originals)
        expect(await readFile(path, "utf8")).toBe(text);
    },
  );

  cliTest(
    "compares the served environment with a probe of the re-seeded application and prints the report",
    async ({ cli }) => {
      const files = await writeCompareFiles(
        await createTestTempDirectory("rea-environment-compare-cli-"),
      );
      const result = await cli.run({
        arguments: [
          "environment-compare",
          files.manifest,
          "--evidence",
          files.capture,
          "--probe",
          files.probe,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        status: "complete",
        environment: { state: "served" },
        summary: { probes: 1, steps: 3, equal: 3, agreement: 1 },
        probes: [{ label: "probe.json", ids_mapped: 2 }],
      });
    },
  );

  cliTest(
    "refuses a probe that is not capture Evidence and names it",
    async ({ cli }) => {
      const files = await writeCompareFiles(
        await createTestTempDirectory("rea-environment-compare-refusal-cli-"),
      );
      const result = await cli.run({
        arguments: [
          "environment-compare",
          files.manifest,
          "--evidence",
          files.capture,
          "--probe",
          files.manifest,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "environment-compare",
          issues: [{ path: ["probe", 0] }],
        },
      });
    },
  );
});
