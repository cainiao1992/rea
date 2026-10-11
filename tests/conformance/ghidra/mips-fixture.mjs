import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Build a source-owned freestanding ELF; never execute its target code. */
export async function buildMipsFixture(
  directory,
  byteOrder,
  floatAbi = "hard",
) {
  if (byteOrder !== "little" && byteOrder !== "big")
    throw new Error("MIPS fixture byte order must be little or big");
  if (floatAbi !== "hard" && floatAbi !== "soft")
    throw new Error("MIPS fixture float ABI must be hard or soft");
  const soft = floatAbi === "soft";
  const compiler = process.env.REA_MIPS_CLANG ?? "clang";
  const target = byteOrder === "little" ? "mipsel-linux-gnu" : "mips-linux-gnu";
  const source = fileURLToPath(new URL("../c/mips.c", import.meta.url));
  const softSource = fileURLToPath(
    new URL("../c/mips-soft-float.c", import.meta.url),
  );
  const probe = fileURLToPath(new URL("./mips-probe.S", import.meta.url));
  const path = join(directory, `${target}${soft ? "-soft-float" : ""}.elf`);
  const args = [
    `--target=${target}`,
    "-march=mips32r2",
    "-mabi=32",
    ...(soft ? ["-msoft-float"] : []),
    "-mno-abicalls",
    "-fno-pic",
    "-fuse-ld=lld",
    "-nostdlib",
    "-static",
    "-O0",
    "-g",
    "-Wl,-e,rea_mips_entry",
    "-Wl,--build-id=none",
    source,
    ...(soft ? [softSource] : []),
    probe,
    "-o",
    path,
  ];
  const version = await execute(compiler, ["--version"], { timeout: 10000 });
  await execute(compiler, args, { timeout: 60000 });
  const bytes = await readFile(path);
  const read16 =
    byteOrder === "little"
      ? bytes.readUInt16LE.bind(bytes)
      : bytes.readUInt16BE.bind(bytes);
  const read32 =
    byteOrder === "little"
      ? bytes.readUInt32LE.bind(bytes)
      : bytes.readUInt32BE.bind(bytes);
  if (
    bytes.length < 52 ||
    bytes.toString("hex", 0, 4) !== "7f454c46" ||
    bytes[4] !== 1 ||
    bytes[5] !== (byteOrder === "little" ? 1 : 2) ||
    read16(16) !== 2 ||
    read16(18) !== 8 ||
    read32(36) !== 0x70001001
  )
    throw new Error(
      "Compiler did not produce the declared ELF32/o32/MIPS32r2 fixture",
    );
  return {
    path,
    byte_order: byteOrder,
    float_abi: floatAbi,
    flags: read32(36),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source_sha256: createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
    ...(soft
      ? {
          soft_source_sha256: createHash("sha256")
            .update(await readFile(softSource))
            .digest("hex"),
        }
      : {}),
    probe_sha256: createHash("sha256")
      .update(await readFile(probe))
      .digest("hex"),
    compiler: version.stdout.trim(),
    arguments: args,
  };
}
