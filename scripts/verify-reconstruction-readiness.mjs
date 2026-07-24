import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { CATALOG_IDENTITY } from "../dist/catalogIdentity.js";
import { RECONSTRUCTION_READINESS_EXAMPLE } from "../dist/contracts/reconstructionReadinessExample.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { createEvidenceBundle } from "../dist/domain/evidenceBundle.js";
import { reconstructionReadinessReportSchema } from "../dist/domain/reconstructionReadinessSchemas.js";
import { PACKAGE_METADATA } from "../dist/generatedPackageMetadata.js";

const execute = promisify(execFile);
const root = process.cwd();
const nativePath = resolve(root, "build/conformance/c");
const fixtureRoot = resolve(root, "tests/conformance/readiness");
const javascriptPath = join(fixtureRoot, "javascript-cli");
const electronPath = join(fixtureRoot, "electron");
const environment = {
  ...process.env,
  REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify([fixtureRoot]),
};
const temporaryRoot = await mkdtemp(join(tmpdir(), "rea-readiness-"));

await access(nativePath);
const nativeEvidence = await runCli(["inspect-artifact", nativePath, "--json"]);
const javascriptCliEvidence = await runCli([
  "analyze-javascript-application",
  javascriptPath,
  "--approved",
  "--json",
]);
const electronCliEvidence = await runCli([
  "analyze-javascript-application",
  electronPath,
  "--approved",
  "--json",
]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["scripts/rea.mjs", "mcp"],
  cwd: root,
  env: environment,
  stderr: "pipe",
});
const client = new Client({
  name: "rea-readiness-verifier",
  version: "1",
  capabilities: { elicitation: {} },
});

try {
  await client.connect(transport);
  const catalog = await client.listTools();
  const readinessTool = requireTool(
    catalog.tools,
    "evaluate_reconstruction_readiness",
  );
  const analysisTool = requireTool(
    catalog.tools,
    "analyze_javascript_application",
  );
  assertExactAstLimit(analysisTool);
  assert.equal(
    readinessTool.annotations?.readOnlyHint,
    false,
    "readiness Evidence retention side effect must stay visible",
  );

  const javascriptMcp = await analyzeMcp(client, javascriptPath);
  const electronMcp = await analyzeMcp(client, electronPath);
  assert.equal(
    javascriptMcp.evidence_id,
    javascriptCliEvidence.evidence_id,
    "CLI/MCP JavaScript analysis Evidence identity drifted",
  );
  assert.equal(
    electronMcp.evidence_id,
    electronCliEvidence.evidence_id,
    "CLI/MCP Electron analysis Evidence identity drifted",
  );

  const input = structuredClone(RECONSTRUCTION_READINESS_EXAMPLE);
  input.identity.cli_version = PACKAGE_METADATA.version;
  input.identity.server_version = PACKAGE_METADATA.version;
  input.identity.catalog_digest = CATALOG_IDENTITY.digests.combined_sha256;
  const records = [
    ...input.evidence_bundle.records,
    nativeEvidence,
    javascriptCliEvidence,
    electronCliEvidence,
  ].map(parseEvidence);
  input.evidence_bundle = createEvidenceBundle(records);
  setFixtureDigest(input, "native", nativeEvidence);
  setFixtureDigest(input, "javascript-cli", javascriptCliEvidence);
  setFixtureDigest(input, "electron", electronCliEvidence);
  linkCheck(input, "discover-classify", "artifact-inventory", nativeEvidence);
  linkCheck(input, "static-analysis", "native-routed", nativeEvidence);
  linkCheck(
    input,
    "static-analysis",
    "javascript-routed",
    javascriptCliEvidence,
  );
  linkCheck(
    input,
    "reactive-scenarios",
    "electron-correlated",
    electronCliEvidence,
  );

  const inputPath = join(temporaryRoot, "input.json");
  await writeFile(inputPath, JSON.stringify(input));
  const cliEvidence = await runCli([
    "evaluate-reconstruction-readiness",
    inputPath,
    "--json",
  ]);
  const cliReport = reconstructionReadinessReportSchema.parse(
    cliEvidence.normalized_result,
  );
  assert.equal(cliReport.status, "pass");
  if (process.env.REA_READINESS_REPORT_PATH !== undefined)
    await writeFile(
      resolve(root, process.env.REA_READINESS_REPORT_PATH),
      `${JSON.stringify(cliReport, null, 2)}\n`,
    );

  const mcpResult = await client.callTool({
    name: "evaluate_reconstruction_readiness",
    arguments: input,
  });
  assert.notEqual(mcpResult.isError, true);
  const projection = requireObject(mcpResult.structuredContent);
  const projectedReport = requireObject(projection.result);
  assert.equal(projectedReport.report_digest, cliReport.report_digest);
  assert.equal(projectedReport.status, "pass");
  const reportUri = projectedReport.report_resource_uri;
  assert.equal(typeof reportUri, "string");
  const resource = await client.readResource({ uri: reportUri });
  const resourceContent = resource.contents[0];
  if (resourceContent === undefined || !("text" in resourceContent))
    throw new TypeError("Readiness report resource is missing JSON text");
  const retained = JSON.parse(resourceContent.text);
  assert.equal(retained.report.report_digest, cliReport.report_digest);

  const tampered = structuredClone(input);
  tampered.replay.expected_source_digest = cliReport.source_digest;
  tampered.identity.server_version = "tampered";
  const tamperedPath = join(temporaryRoot, "tampered.json");
  await writeFile(tamperedPath, JSON.stringify(tampered));
  const tamperedEvidence = await runCli([
    "evaluate-reconstruction-readiness",
    tamperedPath,
    "--json",
  ]);
  const tamperedReport = reconstructionReadinessReportSchema.parse(
    tamperedEvidence.normalized_result,
  );
  assert.equal(tamperedReport.status, "fail");
  assert.ok(
    tamperedReport.findings.some(
      ({ code }) => code === "replay-source-digest-mismatch",
    ),
  );

  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      status: cliReport.status,
      report_id: cliReport.report_id,
      report_digest: cliReport.report_digest,
      stages: cliReport.summary.stages,
      findings: cliReport.summary.findings,
      native_evidence_id: nativeEvidence.evidence_id,
      javascript_evidence_id: javascriptCliEvidence.evidence_id,
      electron_evidence_id: electronCliEvidence.evidence_id,
      provider: "local-stdio",
    })}\n`,
  );
} finally {
  await client.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runCli(arguments_) {
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", ...arguments_],
    {
      cwd: root,
      env: environment,
      maxBuffer: 64 * 1_024 * 1_024,
    },
  );
  return parseEvidence(JSON.parse(stdout));
}

async function analyzeMcp(client_, inputPath) {
  const result = await client_.callTool({
    name: "analyze_javascript_application",
    arguments: { input_path: inputPath, approved: true },
  });
  assert.notEqual(result.isError, true);
  const projected = requireObject(result.structuredContent);
  assert.equal(typeof projected.evidence_id, "string");
  const evidence = await client_.readResource({
    uri: `rea://evidence/${projected.evidence_id}`,
  });
  const content = evidence.contents[0];
  if (content === undefined || !("text" in content))
    throw new TypeError("Analysis Evidence resource is missing JSON text");
  return parseEvidence(JSON.parse(content.text));
}

function requireTool(tools, name) {
  const tool = tools.find(({ name: toolName }) => toolName === name);
  if (tool === undefined) throw new Error(`Missing public MCP tool: ${name}`);
  return tool;
}

function assertExactAstLimit(tool) {
  const properties = requireObject(tool.inputSchema.properties);
  const limits = requireObject(properties.limits);
  const limitProperties = requireObject(limits.properties);
  const astLimit = requireObject(limitProperties.max_ast_nodes);
  assert.equal(astLimit.default, 2_000_000, "effective AST limit is hidden");
  assert.equal(astLimit.maximum, 20_000_000, "schema AST limit is hidden");
}

function requireObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Expected an object");
  return value;
}

function setFixtureDigest(input, kind, evidence) {
  const fixture = input.fixtures.find(
    ({ kind: fixtureKind }) => fixtureKind === kind,
  );
  if (fixture === undefined || evidence.subject === null)
    throw new TypeError(`Missing ${kind} fixture identity`);
  fixture.artifact_sha256 = evidence.subject.digest.sha256;
}

function linkCheck(input, stageId, checkId, evidence) {
  const stage = input.stages.find(({ stage_id: id }) => id === stageId);
  const check = stage?.checks.find(({ check_id: id }) => id === checkId);
  if (stage === undefined || check === undefined)
    throw new TypeError(`Missing readiness check ${stageId}/${checkId}`);
  stage.evidence_ids = [
    ...new Set([...stage.evidence_ids, evidence.evidence_id]),
  ].sort();
  check.evidence_ids = [evidence.evidence_id];
}
