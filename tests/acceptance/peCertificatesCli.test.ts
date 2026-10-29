import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  peCertificateFixture,
  peWithoutCertificateTableFixture,
  pkcs7SignedDataFixture,
  pkcs7SignedDataIndefiniteEnvelopeFixture,
} from "../../src/native/pe/PeCertificates.fixture.js";
import { repeatedCertificateSignedData } from "../fixtures/peCertificateAllowance.js";
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
  "inspects SignedData with an indefinite constructed ContentInfo envelope",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-ber-cli-");
    const path = join(root, "ber-signed.exe");
    const payload = pkcs7SignedDataIndefiniteEnvelopeFixture();
    await writeFile(path, peCertificateFixture(false, payload));

    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    const entry = evidence.normalized_result.entries[0];
    expect(entry?.pkcs7?.certificates[0]).toMatchObject({
      serial_hex: "11223344",
    });
    expect(entry?.payload.bytes).toBe(payload.length);
    expect(entry?.pkcs7?.certificates[0]?.location.bytes).toBeGreaterThan(0);
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

cliTest(
  "reports TeletexString compatibility text with its decoding limitation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-teletex-");
    const path = join(root, "teletex.exe");
    const payload = pkcs7SignedDataFixture("é");
    const nameAt = payload.indexOf(Buffer.from([0x0c, 0x02, 0xc3, 0xa9]));
    expect(nameAt).toBeGreaterThanOrEqual(0);
    // Replace an equal-length UTF8String with T.61's acute accent plus 'e'.
    Buffer.from([0x14, 0x02, 0xc2, 0x65]).copy(payload, nameAt);
    await writeFile(path, peCertificateFixture(false, payload));
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.issuer
        .text,
    ).toBe("commonName=Âe, organizationName=REA Tests");
    expect(evidence.normalized_result.limitations).toContain(
      "TeletexString values use OpenSSL's ISO-8859-1 compatibility mapping; this is not a full T.61 decoder.",
    );
  },
);

cliTest(
  "rejects a non-minimal PKCS#7 content OID through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-oid-");
    const path = join(root, "nonminimal.exe");
    const payload = pkcs7SignedDataIndefiniteEnvelopeFixture();
    expect([...payload.subarray(0, 5)]).toEqual([0x30, 0x80, 0x06, 0x09, 0x2a]);
    const malformed = Buffer.concat([
      payload.subarray(0, 3),
      Buffer.from([0x0a, 0x80]),
      payload.subarray(4),
    ]);
    await writeFile(path, peCertificateFixture(false, malformed));
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_pe_certificates" },
    });
  },
);

cliTest(
  "rejects surrogate pairs in BMPString certificate names and accepts valid neighboring code units",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-bmp-");
    const path = join(root, "bmp.exe");
    const payload = pkcs7SignedDataFixture("ABCD");
    const nameAt = payload.indexOf(
      Buffer.from([0x0c, 0x04, 0x41, 0x42, 0x43, 0x44]),
    );
    expect(nameAt).toBeGreaterThanOrEqual(0);
    // Equal-size replacement keeps the DER lengths and all unrelated fields intact.
    Buffer.from([0x1e, 0x04, 0xd8, 0, 0xdc, 0]).copy(payload, nameAt);
    await writeFile(path, peCertificateFixture(false, payload));
    const invalid = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_pe_certificates" },
    });
    Buffer.from([0x1e, 0x04, 0xd7, 0xff, 0xe0, 0]).copy(payload, nameAt);
    await writeFile(path, peCertificateFixture(false, payload));
    const valid = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(valid.exitCode, valid.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      valid.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.issuer
        .text,
    ).toBe("commonName=\ud7ff\ue000, organizationName=REA Tests");
  },
);

cliTest(
  "inventories repeated certificates within both decoder allowances",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-repeated-");
    const path = join(root, "chain.exe");
    await writeFile(
      path,
      peCertificateFixture(false, repeatedCertificateSignedData(200)),
    );

    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates,
    ).toHaveLength(200);
  },
);

cliTest.for([
  // Each repeated certificate decodes to 43 ASN.1 values and about 200 bytes
  // of text, so 350 stay within the value allowance and exceed the text one.
  {
    allowance: "decoded certificate text",
    certificates: 350,
    limits: { max_decoded_text_bytes: 65_536 },
    message: "65536-byte decoded budget",
  },
  {
    allowance: "ASN.1 value count",
    certificates: 600,
    limits: { max_asn1_values: 16_384 },
    message: "16384-node budget",
  },
])(
  "reports the fixed $allowance allowance as a resource constraint",
  async ({ certificates, limits, message }, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-allowance-");
    const path = join(root, "large.exe");
    await writeFile(
      path,
      peCertificateFixture(false, repeatedCertificateSignedData(certificates)),
    );

    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        operation: "inspect_pe_certificates",
        reported_limits: limits,
      },
    });
    const { message: reason, remediation } = result.json as {
      message: string;
      remediation: { action: string };
    };
    expect(reason).toContain(message);
    expect(remediation.action).toContain(String(Object.values(limits)[0]));
    expect(remediation.action).toContain("no runtime override");
    expect(remediation.action).toContain(
      "Repeating the unchanged request fails the same way",
    );
  },
);
