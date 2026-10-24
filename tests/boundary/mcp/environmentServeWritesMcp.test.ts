import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../fixtures/analysisView.js";
import {
  environmentStateServeFixture,
  writeEnvironmentServeFiles,
} from "../../fixtures/environmentServe.js";
import {
  BOOK_NOT_FOUND,
  BOOK_ROWS,
  book,
  bookClock,
} from "../../fixtures/environmentStateWrites.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { startListeningProcess } from "../../support/mcp/streamableHttpProcess.js";
import { processTest } from "../../support/process/processFixture.js";

const HTTP_BOUNDARY_TIMEOUT_MS = 90_000;

/** The book the first served create of "Boundary Book" makes: one second past the served clock's start. */
const BOUNDARY_BOOK = book(3, "Boundary Book", bookClock(13));

describe("rea environment-serve write tools", () => {
  processTest(
    "applies a served create to the state the next read answers from, until data/reset",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea-environment-writes-mcp-");
      const files = await writeEnvironmentServeFiles(
        root,
        environmentStateServeFixture(timedCaptureEvidence(BOOK_ROWS)),
      );
      const serve = [files.manifestPath, "--evidence", files.capturePath];
      const started = await startListeningProcess(processes, [
        "environment-serve",
        ...serve,
        "--port",
        "0",
      ]);
      const client = new Client({ name: "environment-writes", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(started.url));
      try {
        const { tools } = await client.listTools();
        const names = tools.map(({ name }) => name);
        expect(names).toEqual(
          expect.arrayContaining(["post_books", "patch_books_by_id"]),
        );
        // The capture's export write targets no state type, so only confirmed writes are listed.
        expect(names).not.toContain("post_exports");
        expect(
          tools.find(({ name }) => name === "post_books")?.annotations,
        ).toMatchObject({
          readOnlyHint: false,
        });
        const created = await client.callTool({
          name: "post_books",
          arguments: { body: { name: "Boundary Book" } },
        });
        expect(created.isError).toBeFalsy();
        expect(created.structuredContent).toMatchObject({
          status: 201,
          body: BOUNDARY_BOOK,
          state: { source: "state", view: "create", id: "3" },
        });
        const read = () =>
          client.callTool({ name: "get_books_by_id", arguments: { id: "3" } });
        expect((await read()).structuredContent).toMatchObject({
          status: 200,
          body: BOUNDARY_BOOK,
          state: { source: "state", view: "item", id: "3" },
        });
        const reset = await fetch(new URL("/agentenv", started.url.origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "reset",
            method: "data/reset",
          }),
        });
        await expect(reset.json()).resolves.toMatchObject({ result: {} });
        // The initial state holds no third book, so the read answers the recorded absence.
        expect((await read()).structuredContent).toMatchObject({
          status: 404,
          body: BOOK_NOT_FOUND,
          state: { source: "state", view: "missing", id: "3" },
        });
      } finally {
        await client.close();
      }
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );

  processTest(
    "rebuilds ids beside unpaired surrogates while preserving raw UTF-16 through creates and reads",
    async ({ processes }) => {
      const captured = (id: number, name: string) => ({
        ...book(id, name, bookClock(id)),
        low: `A\uDC00${String(id)}`,
        high: `A\uD800${String(id)}`,
        right: `${String(id)}\uDC00A`,
        word: "𐐀3𐐁",
        emoji: `😀${String(id)}😀`,
      });
      const first = captured(1, "First Book");
      const second = captured(2, "Second Book");
      const recorded = captured(3, "Third Book");
      const rows: readonly TimedCaptureRow[] = [
        ["GET", "/api/books", [first, second]],
        ["GET", "/api/books/1", first],
        ["GET", "/api/books/2", second],
        ["POST", "/api/books", recorded, 201, { name: "Third Book" }],
        ["GET", "/api/books/3", recorded],
      ];
      const root = await createTestTempDirectory("rea-raw-utf16-writes-mcp-");
      const files = await writeEnvironmentServeFiles(
        root,
        environmentStateServeFixture(timedCaptureEvidence(rows)),
      );
      const started = await startListeningProcess(processes, [
        "environment-serve",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        "--port",
        "0",
      ]);
      const client = new Client({ name: "raw-utf16-writes", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(started.url));
      try {
        for (const id of [3, 4]) {
          const name = `Created Book ${String(id)}`;
          const expected = {
            id,
            name,
            low: `A\uDC00${String(id)}`,
            high: `A\uD800${String(id)}`,
            right: `${String(id)}\uDC00A`,
            word: "𐐀3𐐁",
            emoji: `😀${String(id)}😀`,
          };
          const created = await client.callTool({
            name: "post_books",
            arguments: { body: { name } },
          });
          expect(created.isError).toBeFalsy();
          expect(created.structuredContent).toMatchObject({
            status: 201,
            body: expected,
            state: { source: "state", view: "create", id: String(id) },
          });
          const read = await client.callTool({
            name: "get_books_by_id",
            arguments: { id: String(id) },
          });
          expect(read.isError).toBeFalsy();
          expect(read.structuredContent).toMatchObject({
            status: 200,
            body: expected,
            state: { source: "state", view: "item", id: String(id) },
          });
        }
      } finally {
        await client.close();
      }
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );
});
