import { describe, expect, it } from "vitest";

import {
  getNavigationContext,
  inspectAddressContext,
} from "../src/application/AnalysisContextQueries.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../src/application/AnalysisProvider.js";
import { AnalysisProtocolError } from "../src/domain/errors.js";
import { err, ok } from "../src/domain/result.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

describe("analysis context queries", () => {
  it("aggregates volatile navigation and treats a missing procedure as null", async () => {
    const calls: {
      operation: string;
      parameters: Readonly<Record<string, unknown>>;
    }[] = [];
    const analysis: AnalysisOperationPort = {
      execute: (operation, parameters) => {
        calls.push({ operation, parameters });
        if (operation === "current_document")
          return Promise.resolve(
            ok(createAnalysisExecution("fixture", provider)),
          );
        if (operation === "current_address")
          return Promise.resolve(
            ok(createAnalysisExecution("0x401000", provider)),
          );
        if (operation === "current_procedure")
          return Promise.resolve(
            err(new AnalysisProtocolError("cursor is not in a procedure")),
          );
        return Promise.resolve(
          err(new AnalysisProtocolError(`unexpected ${operation}`)),
        );
      },
    };

    await expect(getNavigationContext(analysis, {})).resolves.toEqual(
      ok({
        document: "fixture",
        address: "0x401000",
        procedure: null,
      }),
    );
    expect(calls).toContainEqual({
      operation: "current_document",
      parameters: {},
    });
  });

  it("uses an explicit document without passing it to current_document and preserves procedure failures", async () => {
    const calls: string[] = [];
    const failure = new AnalysisProtocolError("provider response malformed");
    const analysis: AnalysisOperationPort = {
      execute: (operation) => {
        calls.push(operation);
        if (operation === "current_address")
          return Promise.resolve(
            ok(createAnalysisExecution("0x401000", provider)),
          );
        return Promise.resolve(err(failure));
      },
    };

    await expect(
      getNavigationContext(analysis, { document: "fixture" }),
    ).resolves.toEqual(err(failure));
    expect(calls).toEqual(["current_address", "current_procedure"]);
  });

  it("keeps unsupported address facets local and filters bookmarks", async () => {
    const bookmarkInputs: Readonly<Record<string, unknown>>[] = [];
    const analysis: AnalysisOperationPort = {
      execute: (operation, input) => {
        if (operation === "comment")
          return Promise.resolve(
            err(new AnalysisProtocolError("comments unavailable")),
          );
        switch (operation) {
          case "address_name":
            return Promise.resolve(
              ok(createAnalysisExecution("entry", provider)),
            );
          case "resolve_containing_procedure":
            return Promise.resolve(
              ok(
                createAnalysisExecution(
                  { address: "0x401000", name: "main" },
                  provider,
                ),
              ),
            );
          case "inline_comment":
            return Promise.resolve(ok(createAnalysisExecution(null, provider)));
          case "list_bookmarks":
            bookmarkInputs.push(input);
            return Promise.resolve(
              ok(
                createAnalysisExecution(
                  [
                    { address: "0x401000", value: "review" },
                    { address: "0x402000", value: "other" },
                  ],
                  provider,
                ),
              ),
            );
          default:
            return Promise.resolve(
              err(new AnalysisProtocolError(`unexpected ${operation}`)),
            );
        }
      },
    };

    const result = await inspectAddressContext(analysis, {
      address: "0x401000",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        name: { state: "available", value: "entry" },
        comment: {
          state: "unavailable",
          reason: "comments unavailable",
        },
        bookmarks: {
          state: "available",
          value: [{ address: "0x401000", value: "review" }],
        },
      },
    });
    expect(bookmarkInputs).toEqual([{}]);
  });
});
