/** Real APK task through public MCP, with complete retained Evidence and an independent XML oracle. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { createVerifierCommands } from "../../scripts/lib/verify-commands.mjs";

const { values } = parseArgs({
  options: {
    repository: { type: "string" },
    target: { type: "string" },
    output: { type: "string" },
    mode: { type: "string" },
    "java-home": { type: "string" },
    jar: { type: "string" },
    action: {
      type: "string",
      default: "android.provider.Telephony.SMS_RECEIVED",
    },
  },
});
for (const name of [
  "repository",
  "target",
  "output",
  "mode",
  "java-home",
  "jar",
])
  assert.ok(values[name], `Missing --${name}`);
assert.ok(["before", "after"].includes(values.mode));
const repo = resolve(values.repository),
  target = resolve(values.target),
  output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const digest = createHash("sha256");
for await (const chunk of createReadStream(target)) digest.update(chunk);
const sha256 = digest.digest("hex");
const require = createRequire(join(repo, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio"))
);
const commands = await createVerifierCommands();
const env = {
  PATH: process.env.PATH,
  JAVA_HOME: resolve(values["java-home"]),
  REA_JADX_MCP_JAR: resolve(values.jar),
  REA_JADX_HEAP_MIB: "1024",
  REA_JADX_ACTIVE_PROCESSOR_COUNT: "2",
  NODE_OPTIONS: "--max-old-space-size=3072",
  UV_THREADPOOL_SIZE: "2",
  REA_LOG_LEVEL: "silent",
  REA_MCP_TOOL_FAMILIES: "android,application,session",
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "scripts/rea.mjs"), "mcp"],
  cwd: repo,
  env,
  stderr: "pipe",
  maxBufferSize: 16 * 1024 * 1024,
});
const diagnostics = [];
let diagnosticBytes = 0;
let omittedDiagnosticBytes = 0;
transport.stderr?.on("data", (chunk) => {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const retained = bytes.subarray(0, Math.max(0, 65536 - diagnosticBytes));
  if (retained.length > 0) diagnostics.push(retained);
  diagnosticBytes += retained.length;
  omittedDiagnosticBytes += bytes.length - retained.length;
});
const client = new Client({
  name: "rea-real-android-components",
  version: "1",
});
let catalog;
const calls = [],
  runs = [];
const invoke = async (name, arguments_) => {
  const definitions = catalog.tools.filter((tool) => tool.name === name);
  assert.equal(definitions.length, 1);
  const start = performance.now();
  const result = await client.callTool(
    { name, arguments: arguments_ },
    { toolDefinition: definitions[0], timeout: 120000 },
  );
  calls.push({
    name,
    arguments: arguments_,
    result,
    elapsed_ms: performance.now() - start,
  });
  assert.notEqual(
    result.isError,
    true,
    `${name}: ${JSON.stringify(result.content)}`,
  );
  return result.structuredContent;
};
const selectedFields = [
  "kind",
  "declared_name",
  "name",
  "exported",
  "exported_default",
  "permission",
  "permission_source",
  "enabled",
  "enabled_declaration",
  "process",
  "intent_filters",
  "meta_data",
  "location",
];
const stripLocations = (row) => {
  const { location: _location, ...fields } = row;
  return {
    ...fields,
    intent_filters: row.intent_filters?.map(
      ({
        location: _filterLocation,
        source_index: _filterIndex,
        coverage: _coverage,
        ...filter
      }) => ({
        ...filter,
        data: filter.data.map(({ location: _dataLocation, ...data }) => data),
      }),
    ),
    meta_data: row.meta_data?.map(
      ({ location: _metadataLocation, ...metadata }) => metadata,
    ),
  };
};
const assertOracleFacts = (row, expected, source) => {
  assert.equal(row.declaration_coverage, "complete");
  const cleaned = stripLocations(row);
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(
      cleaned[key],
      value,
      `Independent oracle: ${expected.source_index}.${key}`,
    );
  assert.equal(
    source.slice(
      row.location.offset,
      row.location.offset + row.kind.length + 1,
    ),
    "<" + row.kind,
  );
};
try {
  await client.connect(transport);
  catalog = await client.listTools();
  await writeFile(join(output, "catalog.json"), JSON.stringify(catalog));
  for (const temperature of ["first-capture", "warm-session"]) {
    const firstCall = calls.length;
    const start = performance.now();
    const result = await invoke(
      "inspect_android_package",
      values.mode === "before"
        ? { path: target }
        : {
            path: target,
            detail: "summary",
            view: {
              kind: "android",
              facet: "components",
              actions: [values.action],
              fields: selectedFields,
              limit: 64,
            },
          },
    );
    const rpcMs = performance.now() - start;
    const normalized = result.normalized_result;
    const parentId =
      values.mode === "before"
        ? result.evidence_id
        : normalized.parent_evidence_id;
    const path = join(output, temperature + "-evidence.json");
    await invoke("export_evidence_bundle", { path });
    const bundle = JSON.parse(await readFile(path, "utf8"));
    const parent = bundle.records.find(
      (record) => record.evidence_id === parentId,
    );
    assert.ok(parent);
    assert.equal(parent.subject.digest.sha256, sha256);
    const oraclePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/android-components/manifest-oracle.py",
    );
    const oracle = JSON.parse(
      (
        await commands.exec(
          "python3",
          [oraclePath, path, parentId, values.action],
          { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.ok(
      oracle.components.length > 0,
      "The completed task must exercise a real positive action match",
    );
    const complete = parent.normalized_result;
    assert.equal(complete.components.items.length, oracle.inventory.length);
    assert.equal(oracle.inventory.length, oracle.source_components);
    for (const [index, expected] of oracle.inventory.entries()) {
      const row = complete.components.items[index];
      if (values.mode === "after")
        assertOracleFacts(
          { ...row, source_index: index },
          expected,
          complete.manifest.text,
        );
      else {
        for (const key of ["kind", "declared_name", "name", "permission"])
          assert.deepEqual(
            row[key],
            expected[key],
            `Legacy inventory: ${index}.${key}`,
          );
      }
    }
    if (values.mode === "after") {
      assert.equal(normalized.facet, "components");
      assert.equal(normalized.source_status, "complete");
      assert.equal(normalized.source_components, oracle.source_components);
      assert.equal(normalized.coverage.exhausted, true);
      assert.equal(normalized.coverage.total, oracle.components.length);
      assert.equal(normalized.items.length, oracle.components.length);
      for (let i = 0; i < oracle.components.length; i++) {
        const row = normalized.items[i],
          expected = oracle.components[i];
        assertOracleFacts(row, expected, complete.manifest.text);
      }
    } else {
      for (const expected of oracle.components) {
        const row = normalized.components.items[expected.source_index];
        assert.equal(row.name, expected.name);
        assert.ok(row.actions.includes(values.action));
      }
    }
    runs.push({
      temperature,
      rpc_ms: rpcMs,
      calls: calls.length - firstCall,
      matched_components: oracle.components.length,
      source_components: oracle.source_components,
      parent_evidence_id: parentId,
      answer_verified: true,
      inventory_verified: oracle.inventory.length,
      inventory_scope:
        values.mode === "after"
          ? "declared-structured-facets"
          : "legacy-identity-permission",
    });
  }
} finally {
  // exec drains already adopted owners; adopt the live MCP client only at its final cleanup boundary.
  commands.adopt(client, "real Android component MCP client");
  await commands.close();
  await writeFile(join(output, "stderr.log"), Buffer.concat(diagnostics));
  await writeFile(join(output, "calls.json"), JSON.stringify(calls), {
    mode: 0o600,
  });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        mode: values.mode,
        target,
        sha256,
        runs,
        tool_count: catalog?.tools.length,
        omitted_diagnostic_bytes: omittedDiagnosticBytes,
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ mode: values.mode, runs, verified: true }));
