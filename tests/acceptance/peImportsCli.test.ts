import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  peImportImage,
  peImportFixtureOffset,
  peImportLeadingSectionImage,
  peImportManySectionsImage,
  peImportDirectoryAtRva,
  peImportDirectoryMappingStops,
  peWithoutImportTableFixture,
} from "../fixtures/binaryDiagnostics/peImports.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest("reports PE import names through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-imports-cli-");
  const path = join(root, "app.exe");
  await writeFile(path, peImportImage());
  const result = await cli.run({
    arguments: ["inspect-pe-imports", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_pe_imports").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.imports[0]?.name).toBe("KERNEL32.dll");
  expect(evidence.normalized_result.imphash.md5).toBe(
    "92cef6cc91a85825f3c8a0516517c66f",
  );
});

cliTest(
  "resolves a relative PE path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-imports-cli-rel-");
    await writeFile(join(root, "unsigned.exe"), peWithoutImportTableFixture());
    const result = await cli.run({
      arguments: ["inspect-pe-imports", "unsigned.exe", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_imports").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.import_directory).toBeNull();
    expect(evidence.subject?.local_path).toBe(join(root, "unsigned.exe"));
  },
);

cliTest("reports a truncated PE as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-imports-cli-bad-");
  const path = join(root, "broken.exe");
  await writeFile(path, Buffer.from("MZ"));
  const result = await cli.run({
    arguments: ["inspect-pe-imports", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_pe_imports" },
  });
});

cliTest(
  "preserves directory declarations and partial rows at RVA and mapping boundaries",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-pe-imports-cli-directory-rva-",
    );
    for (const [kind, rva, retained, mappingGap] of [
      ["standard", 0xffffffec, 1, false],
      ["standard", 0xfffffff0, 0, false],
      ["delay", 0xffffffe0, 1, false],
      ["delay", 0xfffffff0, 0, false],
      ["standard", 0x40000000, 0, true],
      ["standard", 0x40000000, 1, true],
      ["delay", 0x40000000, 0, true],
      ["delay", 0x40000000, 1, true],
    ] as const) {
      const path = join(root, `${kind}-${String(rva)}-${String(retained)}.exe`);
      await writeFile(
        path,
        mappingGap
          ? peImportDirectoryMappingStops(kind, retained)
          : peImportDirectoryAtRva(kind, rva),
      );
      const result = await cli.run({
        arguments: ["inspect-pe-imports", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const report = toolContract("inspect_pe_imports").outputSchema.parse(
        result.json,
      ).normalized_result;
      const directory =
        kind === "standard"
          ? report.import_directory
          : report.delay_import_directory;
      const rows = kind === "standard" ? report.imports : report.delay_imports;
      expect(directory).toMatchObject({ rva });
      expect(directory?.locations).toHaveLength(retained);
      expect(rows).toHaveLength(retained);
      expect(report.coverage.status).toBe("partial");
      expect(report.imphash.md5).toBe(
        kind === "delay" ? "92cef6cc91a85825f3c8a0516517c66f" : null,
      );
    }
  },
);

cliTest(
  "retains a partial inventory when an IAT RVA overflows",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-imports-cli-overflow-");
    for (const bits of [32, 64] as const) {
      const bytes = peImportImage({ bits });
      bytes.writeUInt32LE(
        0x100000000 - bits / 8,
        peImportFixtureOffset(0x1000) + 16,
      );
      const path = join(root, `app-${String(bits)}.exe`);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-pe-imports", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const report = toolContract("inspect_pe_imports").outputSchema.parse(
        result.json,
      ).normalized_result;
      expect(report.imports[0]?.functions.map((row) => row.name)).toEqual([
        "GetProcAddress",
      ]);
      expect(report.coverage.status).toBe("partial");
      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "malformed_entry",
            location: "0x100000000",
          }),
        ]),
      );
      expect(report.imphash.md5).toBeNull();
    }
  },
);

cliTest(
  "keeps complete facts when pefile cannot see the same import table",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-pe-imports-cli-compatibility-",
    );
    const functions = Array.from({ length: 140 }, (_, i) => ({
      name: `Function${String(i).padStart(3, "0")}`,
    }));
    const cases = [
      [
        "cross-section",
        peImportImage({
          sectionBytes: 0x4000,
          splitAt: 0x1000,
          dlls: [{ name: "KERNEL32.dll", functions }],
        }),
        140,
      ],
      ["section-cap", peImportManySectionsImage(2049, 2), 2],
      ["null-section", peImportLeadingSectionImage(false), 2],
    ] as const;
    for (const [name, bytes, count] of cases) {
      const path = join(root, `${name}.exe`);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-pe-imports", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const report = toolContract("inspect_pe_imports").outputSchema.parse(
        result.json,
      ).normalized_result;
      expect(report.imports[0]?.name).toBe("KERNEL32.dll");
      expect(report.imports[0]?.functions).toHaveLength(count);
      expect(report.coverage.status).toBe("complete");
      expect(report.imphash).toMatchObject({
        md5: null,
        reason: expect.stringMatching(/mapping|compatibility/u),
      });
      if (name === "cross-section")
        expect(report.imports[0]?.functions[128]?.name).toBe("Function128");
    }
  },
);
