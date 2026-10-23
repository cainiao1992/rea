import { expect, it } from "vitest";

import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";

type MutableArtifactFile = {
  -readonly [Key in keyof JavaScriptArtifactFile]: JavaScriptArtifactFile[Key];
};

const mutableFile = (): MutableArtifactFile => ({
  path: "package.json",
  container_sha256: "container-a",
  sha256: "file-a",
  bytes: 13,
  inventory_artifact_id: "inventory-a",
  kind: "package-json",
  unpacked: false,
  text: { included: true, value: '{"main":"a.cjs"}' },
});

it("reparses changed text and availability on a reused file object", () => {
  const documents = new JavaScriptJsonDocuments();
  const file = mutableFile();
  const original = documents.read(file);
  expect(original).toMatchObject({
    status: "included",
    packageFields: { main: "a.cjs" },
  });

  file.text = { included: true, value: "{" };
  const invalid = documents.read(file);
  expect(invalid.status).toBe("invalid");

  file.text = { included: false, reason: "invalid-utf8" };
  const unavailable = documents.read(file);
  expect(unavailable).toMatchObject({
    status: "unavailable",
    reason: "invalid-utf8",
  });

  file.text = { included: true, value: '{"main":"b.cjs"}' };
  const updated = documents.read(file);
  expect(updated).toMatchObject({
    status: "included",
    packageFields: { main: "b.cjs" },
  });
  expect(original).toMatchObject({
    status: "included",
    source: { path: "package.json" },
    packageFields: { main: "a.cjs" },
  });
  expect(invalid.status).toBe("invalid");
  expect(unavailable.status).toBe("unavailable");
});

it("rebuilds source provenance when path and content digests change", () => {
  const documents = new JavaScriptJsonDocuments();
  const file = mutableFile();
  const original = documents.read(file);

  file.path = "nested/package.json";
  const moved = documents.read(file);
  expect(moved.source.path).toBe("nested/package.json");

  file.container_sha256 = "container-b";
  const recontained = documents.read(file);
  expect(recontained.source).toMatchObject({
    path: "nested/package.json",
    container_sha256: "container-b",
    sha256: "file-a",
  });

  file.sha256 = "file-b";
  const rehashed = documents.read(file);
  expect(rehashed.source).toMatchObject({
    path: "nested/package.json",
    container_sha256: "container-b",
    sha256: "file-b",
  });
  expect(original.source).toEqual({
    path: "package.json",
    container_sha256: "container-a",
    sha256: "file-a",
  });
  expect(original).toMatchObject({
    status: "included",
    packageFields: { main: "a.cjs" },
  });
});

it("retains only syntax and keys for ordinary JSON, with package fields scoped to its format", () => {
  const documents = new JavaScriptJsonDocuments();
  const file = mutableFile();
  file.kind = "json";
  file.text = {
    included: true,
    value: '{"exports":{"nested":["large config"]},"main":"entry.cjs"}',
  };
  const ordinary = documents.read(file);
  expect(ordinary).toMatchObject({
    status: "included",
    topLevelKeys: ["exports", "main"],
    packageFields: null,
  });
  file.kind = "package-json";
  expect(documents.read(file)).toMatchObject({
    status: "included",
    packageFields: { main: "entry.cjs", exports: { nested: ["large config"] } },
  });
  expect(ordinary.packageFields).toBeNull();
});
