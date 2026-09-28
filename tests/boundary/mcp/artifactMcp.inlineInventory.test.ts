import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { createServer } from "../../../src/server/createServer.js";

it("returns every artifact occurrence in one MCP call", async () => {
  const directory = await createTestTempDirectory("rea-artifact-inline-");
  const archive = join(directory, "many.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const fileCount = 520;
  for (let index = 0; index < fileCount; index += 1) {
    await writer.add(
      `files/${String(index)}.txt`,
      new TextReader(`file-${String(index)}`),
    );
  }
  await writeFile(archive, await writer.close());

  const session = createTestBinarySession(new ArtifactProvider());
  const server = createServer(session, session);
  const client = new Client({ name: "artifact-inline-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: archive },
    });
    expect(opened.isError).not.toBe(true);
    const result = await client.callTool({
      name: "inventory_artifact",
      arguments: {},
    });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
      true,
    );
    const inventory = z
      .object({
        occurrences: z.object({
          items: z.array(z.object({ logical_path: z.string() })),
          total: z.number(),
        }),
      })
      .parse(
        z.object({ result: z.unknown() }).parse(result.structuredContent)
          .result,
      );
    expect(inventory.occurrences.items).toHaveLength(fileCount + 1);
    expect(inventory.occurrences.total).toBe(fileCount + 1);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});
