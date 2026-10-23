import { expect, it } from "vitest";

import { analyzeJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";

const packageObservation = (text: string) =>
  analyzeJavaScriptArtifactFiles({
    files: [
      {
        path: "app/package.json",
        container_sha256: "a".repeat(64),
        sha256: "b".repeat(64),
        bytes: Buffer.byteLength(text),
        inventory_artifact_id: "package-main-fixture",
        kind: "package-json",
        unpacked: false,
        text: { included: true, value: text },
      },
    ],
    unavailable_relevant_files: [],
    containers: [],
    text_bytes_read: Buffer.byteLength(text),
    invalid_utf8_files: 0,
  }).packages[0];

it.each([null, false, 123, {}, []].map((main) => ({ main })))(
  "retains non-string main $main evidence separately from Node index fallback",
  ({ main }) => {
    expect(packageObservation(JSON.stringify({ main }))).toMatchObject({
      status: "included",
      main: null,
      main_status: "invalid",
      main_entrypoint: "",
    });
  },
);

it("keeps valid JSON numeric overflow invalid as a package main", () => {
  expect(packageObservation('{"main":1e400}')).toMatchObject({
    status: "included",
    main: null,
    main_status: "invalid",
    main_entrypoint: "",
  });
});

it("treats a valid numeric JSON root as a package metadata shape failure", () => {
  expect(packageObservation("1e400")).toMatchObject({
    status: "invalid",
    main: null,
    main_status: "unavailable",
    main_entrypoint: null,
  });
});

it("retains valid numeric overflow as an ordinary JSON module", () => {
  const text = "1e400";
  const analysis = analyzeJavaScriptArtifactFiles({
    files: [
      {
        path: "settings.json",
        container_sha256: "a".repeat(64),
        sha256: "b".repeat(64),
        bytes: Buffer.byteLength(text),
        inventory_artifact_id: "numeric-json-fixture",
        kind: "json",
        unpacked: false,
        text: { included: true, value: text },
      },
    ],
    unavailable_relevant_files: [],
    containers: [],
    text_bytes_read: Buffer.byteLength(text),
    invalid_utf8_files: 0,
  });

  expect(analysis.json_modules).toMatchObject([
    { status: "included", top_level_keys: [] },
  ]);
});

it.each([
  ["{}", "default", ""],
  ['{"main":""}', "default", ""],
  ['{"main":"main.cjs"}', "declared", "main.cjs"],
  ['{"main":"sub\\\\main.cjs"}', "declared", "sub\\main.cjs"],
  ['{"main":"C:main.cjs"}', "declared", "C:main.cjs"],
] as const)(
  "preserves package launch declarations from %s",
  (text, status, entry) => {
    expect(packageObservation(text)).toMatchObject({
      status: "included",
      main_status: status,
      main_entrypoint: entry,
    });
  },
);

it.each(["{", "null", "[]", "[{}]", "123", '"root"', "false"])(
  "keeps malformed package metadata %s out of known launch fallback",
  (text) => {
    expect(packageObservation(text)).toMatchObject({
      status: "invalid",
      main: null,
      main_status: "unavailable",
      main_entrypoint: null,
    });
  },
);
