import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { requireMcpResult } from "./lib/mcp-verifier-results.mjs";
import { snapshotHopperRuntime } from "./lib/real-hopper-cleanup.mjs";
import { HOPPER_TARGET_LEASE_DIRECTORY } from "../dist/hopper/HopperTargetLease.js";
import { parseConfig } from "../dist/config.js";

const run = promisify(execFile);
const verifyFat64 = process.argv[2] === "--fat64";
assert.deepEqual(process.argv.slice(2), verifyFat64 ? ["--fat64"] : []);
if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
  throw new Error(
    "Hopper FAT verification requires macOS arm64 or x64 and its installed clang/lipo toolchain",
  );
const config = parseConfig(process.env);
if (!config.ok) throw config.error;
await access(config.value.hopperLauncherPath, constants.X_OK).catch((cause) => {
  throw new Error(
    `Hopper FAT verification requires the configured executable: ${config.value.hopperLauncherPath}`,
    { cause },
  );
});
const toolPaths = {};
for (const command of ["clang", "lipo"])
  toolPaths[command] = (
    await run("xcrun", ["--find", command]).catch((cause) => {
      throw new Error(`Hopper FAT verification requires ${command}`, { cause });
    })
  ).stdout.trim();
const sdk = (
  await run("xcrun", ["--sdk", "macosx", "--show-sdk-path"]).catch((cause) => {
    throw new Error(
      "Hopper FAT verification requires the installed macOS SDK",
      { cause },
    );
  })
).stdout.trim();

const directory = await realpath(await mkdtemp(join(tmpdir(), "hopper-fat-")));
const source = fileURLToPath(
  new URL("../tests/conformance/c/fixture.c", import.meta.url),
);
const arm = join(directory, "c-arm64");
const intel = join(directory, "c-x86_64");
const fat = join(directory, "c-fat");
const fat64 = join(directory, "c-fat64");
const singleFat = join(directory, "c-single-fat");
const owned = new Set();
const before = await snapshotHopperRuntime(
  "/tmp",
  HOPPER_TARGET_LEASE_DIRECTORY,
);
const client = new Client({ name: "hopper-fat-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/main.js"],
  env: {
    ...process.env,
    REA_ANALYSIS_PROVIDER: "hopper",
    HOPPER_LOADER_ARGS_JSON: "[]",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const observations = [];
try {
  await run(toolPaths.clang, [
    "-isysroot",
    sdk,
    "-arch",
    "arm64",
    "-O0",
    "-fno-inline",
    source,
    "-o",
    arm,
  ]);
  await run(toolPaths.clang, [
    "-isysroot",
    sdk,
    "-arch",
    "x86_64",
    "-O0",
    "-fno-inline",
    source,
    "-o",
    intel,
  ]);
  await run(toolPaths.lipo, ["-create", arm, intel, "-output", fat]);
  if (verifyFat64)
    await run(toolPaths.lipo, [
      "-create",
      arm,
      intel,
      "-fat64",
      "-output",
      fat64,
    ]);
  await run(toolPaths.lipo, [
    "-create",
    process.arch === "arm64" ? arm : intel,
    "-output",
    singleFat,
  ]);
  await client.connect(transport);
  assert.ok(transport.pid !== null);
  owned.add(transport.pid);
  const catalog = await client.listTools();
  const call = async (name, args = {}) => {
    const reply = await client.callTool(
      { name, arguments: args },
      { timeout: 180_000 },
    );
    const result = requireMcpResult(reply, name);
    const schema = catalog.tools.find(
      (tool) => tool.name === name,
    )?.outputSchema;
    assert.ok(schema, `${name} omitted its output schema`);
    assert.equal(
      ajv.validate(schema, reply.structuredContent),
      true,
      JSON.stringify(ajv.errors),
    );
    return result;
  };
  let fatExpected;
  let fatAddress;
  for (const path of [
    arm,
    intel,
    fat,
    singleFat,
    ...(verifyFat64 ? [fat64] : []),
  ]) {
    console.error(`Verifying Hopper source-file mappings for ${path}`);
    await call("open_binary", { path });
    const file = await readFile(path);
    const procedures = await call("list_procedures");
    const entry = procedures.find((item) => item.value.endsWith("rea_entry"));
    assert.ok(entry, "compiler fixture omitted rea_entry");
    for (const address of [
      entry.address,
      `0x${(BigInt(entry.address) + 1n).toString(16)}`,
    ]) {
      const mapping = await call("address_to_file_offset", { address });
      const bytes = await call("read_bytes", { address, length: 16 });
      assert.equal(
        mapping.file_offset,
        mapping.image_base_file_offset + mapping.provider_file_offset,
      );
      assert.equal(mapping.source_path, path);
      assert.equal(bytes.complete, true);
      assert.equal(
        file
          .subarray(mapping.file_offset, mapping.file_offset + 16)
          .toString("hex"),
        bytes.bytes_hex,
      );
      if (path === fat || path === singleFat || path === fat64) {
        assert.ok(
          mapping.image_base_file_offset > 0,
          "FAT mapping omitted its physical slice offset",
        );
        assert.notEqual(
          file
            .subarray(
              mapping.provider_file_offset,
              mapping.provider_file_offset + 16,
            )
            .toString("hex"),
          bytes.bytes_hex,
          "fixture did not distinguish image-relative and original-file coordinates",
        );
      } else assert.equal(mapping.image_base_file_offset, 0);
      if (path === fat) {
        fatExpected = mapping;
        fatAddress = address;
      }
      observations.push({ path, address, ...mapping, matched_bytes: 16 });
    }
    await call("close_binary");
  }
  const pending = run(
    process.execPath,
    [
      "scripts/rea.mjs",
      "address-to-file-offset",
      fat,
      fatAddress,
      "--provider",
      "hopper",
      "--format",
      "json",
    ],
    {
      timeout: 180_000,
      env: { ...process.env, HOPPER_LOADER_ARGS_JSON: "[]" },
    },
  );
  assert.ok(pending.child.pid !== undefined);
  owned.add(pending.child.pid);
  const cli = JSON.parse((await pending).stdout);
  assert.deepEqual(cli.normalized_result, fatExpected);
} finally {
  await client.close();
  await transport.close();
  await rm(directory, { recursive: true, force: true });
}
const retained = [
  ...(await snapshotHopperRuntime(
    "/tmp",
    HOPPER_TARGET_LEASE_DIRECTORY,
    owned,
  )),
].filter((path) => !before.has(path));
assert.deepEqual(
  retained,
  [],
  "FAT verification retained owned Hopper sessions or leases",
);
console.log(
  JSON.stringify(
    {
      observations,
      cliMcpParity: true,
      fat64: verifyFat64 ? "verified" : "not_run",
      cleanShutdown: true,
    },
    null,
    2,
  ),
);
