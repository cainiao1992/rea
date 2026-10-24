#!/usr/bin/env node
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../dist/process/OwnedCommand.js";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { execNpm } from "./lib/verify-package-core.mjs";
import { WABT_WORKFLOW_TIMEOUT_MS } from "./lib/wabt-verifier-timeouts.mjs";
import { verifyPackagePack } from "./verify-package-pack.mjs";

/** Preserve the actual dependent process/root owner across failed cleanup. */
class PackagedWasmCleanupFailure extends Error {
  constructor(cause, cleanupOwner, runtimeRoot) {
    super(
      `Packaged WASM verifier cleanup incomplete; retained ${runtimeRoot.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PackagedWasmCleanupFailure";
    this.cleanupOwner = cleanupOwner;
    this.runtimeRoot = runtimeRoot;
  }
}

const root = await PrivateRuntimeRoot.create({
  prefix: "rea-wabt-package-verifier-",
});
let commandCleanupOwner;
let closing;
const cleanupOwner = {
  close() {
    if (closing !== undefined) return closing;
    let attempt;
    attempt = (async () => {
      if (commandCleanupOwner !== undefined) {
        const stopped = await commandCleanupOwner.stop();
        if (stopped.status === "incomplete")
          throw new Error(stopped.reason, { cause: stopped });
        commandCleanupOwner = undefined;
      }
      await root.close();
    })().catch((cause) => {
      if (closing === attempt) closing = undefined;
      throw new PackagedWasmCleanupFailure(cause, cleanupOwner, root);
    });
    closing = attempt;
    return attempt;
  },
};
const verifiedOutput = await withVerifierCleanup(async () => {
  const { tarball } = await verifyPackagePack({
    root: process.cwd(),
    workspace: root.path,
  });
  const prefix = join(root.path, "prefix");
  const home = join(root.path, "home");
  await mkdir(home);
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
  await execNpm(
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--omit=dev",
      "--install-strategy=nested",
      "--prefix",
      prefix,
      tarball,
    ],
    { env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const entrypoint = join(
    prefix,
    ...(process.platform === "win32"
      ? ["node_modules"]
      : ["lib", "node_modules"]),
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  let verified;
  try {
    verified = await runOwnedCommand(
      {
        command: process.execPath,
        arguments: [
          fileURLToPath(new URL("./verify-wasm-artifact.mjs", import.meta.url)),
          entrypoint,
          "--require-tools",
        ],
        cwd: process.cwd(),
        hostEnvironment: environment,
        expectedCommand: process.execPath,
        runId: `rea-packaged-wabt-${randomUUID()}`,
        sweepTokenOwnedProcesses: true,
      },
      {
        timeoutMs: WABT_WORKFLOW_TIMEOUT_MS,
        diagnosticBytes: 4 * 1024 * 1024,
      },
    );
  } catch (cause) {
    if (cause instanceof OwnedCommandFailure)
      commandCleanupOwner = cause.cleanupOwner;
    throw cause;
  }
  return verified.stdout.text;
}, [() => cleanupOwner.close()]);
process.stdout.write(verifiedOutput);
