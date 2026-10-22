import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  peCertificateFixture,
  peWithoutCertificateTableFixture,
} from "../../src/native/pe/PeCertificates.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "reports PKCS#7 signer identity through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-");
    const path = join(root, "signed.exe");
    await writeFile(path, peCertificateFixture());
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.serial_hex,
    ).toBe("11223344");
  },
);

cliTest(
  "resolves a relative PE path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-rel-");
    await writeFile(
      join(root, "unsigned.exe"),
      peWithoutCertificateTableFixture(),
    );
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", "unsigned.exe", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.table).toBeNull();
    expect(evidence.subject?.local_path).toBe(join(root, "unsigned.exe"));
  },
);

cliTest("reports a truncated PE as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-cert-cli-bad-");
  const path = join(root, "broken.exe");
  await writeFile(path, Buffer.from("MZ"));
  const result = await cli.run({
    arguments: ["inspect-pe-certificates", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_pe_certificates" },
  });
});
