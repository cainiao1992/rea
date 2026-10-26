import {
  chmod,
  mkdir,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { PacketCaptureService } from "../../../src/application/captures/PacketCaptureService.js";
import { SignalRecordingService } from "../../../src/application/signals/SignalRecordingService.js";
import { TsharkCaptureProvider } from "../../../src/captures/TsharkCaptureProvider.js";
import { SigrokRecordingProvider } from "../../../src/signals/SigrokRecordingProvider.js";
import { readStableArtifact } from "../../../src/artifacts/readStableArtifact.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import type { LinuxResourceLimits } from "../../../src/process/LinuxResourceLimits.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Real children and filesystem, with simulated Linux admission/limits. These
// scripts do not establish native TShark, sigrok or prlimit behavior.
it.skipIf(process.platform === "win32").each(["tshark", "sigrok"] as const)(
  "executes selected %s and limiter wrappers, retaining identity failure output after success",
  async (kind) => {
    const directory = await createTestTempDirectory("rea-selected-producer-");
    const bin = join(directory, "bin"),
      libexec = join(directory, "libexec");
    await mkdir(bin);
    await mkdir(libexec);
    const command = join(bin, kind),
      limiter = join(bin, "prlimit");
    const commandSource = join(libexec, "producer"),
      limiterSource = join(libexec, "limiter");
    const replacement = join(libexec, "replacement");
    const script =
      '#!/bin/sh\nselected="${0%/*}/${0##*/}"\nIFS= read -r role < "$selected.role" || exit 19\nif [ "$role" = limiter ]; then\n  if [ -f "$selected.retarget" ]; then\n    IFS= read -r target < "$selected.retarget"\n    /bin/ln -sf "$target" "$0"\n  fi\n  while [ "$1" != -- ]; do shift; done\n  shift\n  exec "$@"\nfi\nif [ "$1" = --version ]; then\n  if [ "$role" = tshark ]; then printf "TShark (Wireshark) 4.6.9\\n"; else printf "sigrok-cli 0.7.2\\nlibsigrokdecode 0.5.3\\n"; fi\nelse\n  if [ "$role" = tshark ]; then printf "P\\tInternet Protocol\\tip\\n"; else printf "Supported protocol decoders:\\n  uart  UART\\n"; fi\nfi\n';
    for (const path of [commandSource, limiterSource, replacement]) {
      await writeFile(path, script);
      await chmod(path, 0o755);
    }
    await symlink(commandSource, command);
    await symlink(limiterSource, limiter);
    await writeFile(`${command}.role`, `${kind}\n`);
    await writeFile(`${limiter}.role`, "limiter\n");
    const environment = {
      ...process.env,
      ...(kind === "tshark"
        ? { REA_TSHARK_COMMAND: command, REA_TSHARK_PRLIMIT_COMMAND: limiter }
        : { REA_SIGROK_COMMAND: command, REA_SIGROK_PRLIMIT_COMMAND: limiter }),
    };
    const runtime = () =>
      PrivateRuntimeRoot.create({ parent: directory, prefix: "workspace-" });
    const limits = async (configured: LinuxResourceLimits) => configured;
    const provider =
      kind === "tshark"
        ? new TsharkCaptureProvider(
            environment,
            undefined,
            runtime,
            "linux",
            readStableArtifact,
            limits,
          )
        : new SigrokRecordingProvider(
            environment,
            undefined,
            runtime,
            "linux",
            readStableArtifact,
            limits,
          );
    onTestFinished(() => provider.close());
    const inspect =
      provider instanceof TsharkCaptureProvider
        ? () => new PacketCaptureService(provider).inspectFields({})
        : () => new SignalRecordingService(provider).inspectDecoders({});
    const first = await inspect();
    if (!first.ok) throw first.error;
    expect(first.value.normalized_result).toMatchObject({
      tool: { configured_path: command, path: await realpath(commandSource) },
      resource_limiter: {
        configured_path: limiter,
        path: await realpath(limiterSource),
        arguments: expect.arrayContaining([command]),
      },
    });
    // Identical bytes at another physical path must not pass the current
    // invocation's identity verification, even though the producer succeeds.
    await writeFile(`${limiter}.retarget`, `${replacement}\n`);
    const changed = await inspect();
    if (changed.ok) throw new Error("Retargeted limiter was accepted");
    expect(changed.error).toMatchObject({
      _tag: "AnalysisArtifactChangedError",
      path: limiter,
      capturedOutput: {
        stdout:
          kind === "tshark"
            ? "TShark (Wireshark) 4.6.9\n"
            : "sigrok-cli 0.7.2\nlibsigrokdecode 0.5.3\n",
      },
    });
    await unlink(`${limiter}.retarget`);
    const fresh = await inspect();
    if (!fresh.ok) throw fresh.error;
    expect(fresh.value.normalized_result).toMatchObject({
      resource_limiter: { path: await realpath(replacement) },
    });
    expect(first.value.normalized_result).toMatchObject({
      resource_limiter: { path: await realpath(limiterSource) },
    });
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith("workspace-"),
      ),
    ).toEqual([]);
  },
);
