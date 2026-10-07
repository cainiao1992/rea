import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../domain/javascriptApplicationAnalysis.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

const analyzeSource = async (
  source: string,
  extraFiles: Readonly<Record<string, string>> = {},
) => {
  const inputPath = await createTestTempDirectory("rea-js-empty-literal-");
  await writeFile(join(inputPath, "app.js"), `${source}\n`);
  for (const [path, text] of Object.entries(extraFiles))
    await writeFile(join(inputPath, path), text);
  const result = await analyzeJavaScriptApplication({
    input_path: inputPath,
    format: "directory",
  });
  if (!result.ok)
    throw new Error(`Expected analysis success: ${result.error.message}`);
  return javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
};

it.each([
  "fetch('');",
  "new WebSocket('');",
  "navigator.serviceWorker.register('');",
  "new Worker('');",
  "const x = require('');",
  "import y from ''; y();",
  "import('');",
  "localStorage.getItem('');",
  "localStorage.setItem('', 1);",
  "indexedDB.open('');",
  "win.loadFile('');",
  "win.loadURL('');",
  "app.get('', handler);",
  "process.on('', () => 1);",
  "const { EventEmitter } = require('events'); new EventEmitter().on('', () => 1);",
  "const { spawn } = require('child_process'); spawn('/bin/x').on('', () => 1);",
  "const { ipcMain } = require('electron'); ipcMain.handle('', () => 1);",
  "const { ipcRenderer } = require('electron'); ipcRenderer.invoke('');",
  "const { contextBridge } = require('electron'); contextBridge.exposeInMainWorld('', {});",
])("analyzes the legal empty string literal in %s", async (source) => {
  await expect(analyzeSource(source)).resolves.toBeDefined();
});

it("displays empty literals as nonempty text while retaining exact values", async () => {
  const output = await analyzeSource(
    "fetch(''); fetch('/api'); process.on('', () => 1);",
  );
  const endpoints = output.graph.nodes
    .filter(({ kind }) => kind === "endpoint")
    .map(({ identity, observations }) => ({
      key: identity.strategy === "artifact-local-key" ? identity.key : null,
      labels: observations.map(({ label }) => label),
      values: observations.map(({ properties }) => properties.value),
    }));
  expect(endpoints).toEqual(
    expect.arrayContaining([
      { key: '""', labels: ['""'], values: [""] },
      { key: "/api", labels: ["/api"], values: ["/api"] },
    ]),
  );
  expect(
    output.semantic_graph?.nodes
      .filter(({ kind }) => kind === "event")
      .map(({ label, properties }) => ({
        label,
        eventName: properties.event_name,
      })),
  ).toEqual([{ label: '""', eventName: "" }]);
});

it.each([
  { version: 3, sources: [""], names: [], mappings: "AAAA" },
  {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: { version: 3, sources: [""], names: [], mappings: "AAAA" },
      },
    ],
  },
])("projects an empty source-map source name: %j", async (map) => {
  const output = await analyzeSource("//# sourceMappingURL=app.js.map", {
    "app.js.map": JSON.stringify(map),
  });
  const originals = output.graph.nodes
    .filter(({ kind }) => kind === "source-module")
    .map(({ identity, observations }) => ({
      originalSource:
        identity.strategy === "source-map-original"
          ? identity.original_source
          : null,
      sources: observations.map(({ properties }) => properties.source),
    }));
  expect(originals).toEqual([{ originalSource: '""', sources: [""] }]);
});
