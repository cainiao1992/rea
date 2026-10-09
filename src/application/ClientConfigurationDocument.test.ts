import { describe, expect, it } from "vitest";

import { parse as parseToml } from "smol-toml";

import {
  clientConfigurationServersKey,
  parseClientConfiguration,
  serializeClientConfiguration,
} from "./ClientConfigurationDocument.js";

describe("JSON client configuration BOM handling", () => {
  const format = "json" as const;
  const serversKey = clientConfigurationServersKey(format);

  it("reports malformed BOM-prefixed JSON at the original offset", () => {
    const text = `\uFEFF{\r\n  "${serversKey}": {"rea": @}\r\n}`;

    expect(() => parseClientConfiguration(text, format)).toThrow(
      new SyntaxError(
        `Invalid JSON/JSONC at offset ${text.indexOf("@")}: InvalidSymbol`,
      ),
    );
  });

  it.each([
    ["\uFEFF\uFEFF{}", 1],
    [" \uFEFF{}", 1],
    ['{"setting":\uFEFFtrue}', 11],
    ['\uFEFF{"setting":\uFEFFtrue}', 12],
  ] as const)("rejects a nonleading BOM in %j", (text, offset) => {
    expect(() => parseClientConfiguration(text, format)).toThrow(
      new SyntaxError(`Invalid JSON/JSONC at offset ${offset}: InvalidSymbol`),
    );
  });
});

describe("TOML client configuration BOM handling", () => {
  it.each(["", "\uFEFF"])("parses a document with prefix %j", (bom) => {
    const text = '[mcp_servers.rea]\ncommand = "rea"\n';

    expect(parseClientConfiguration(`${bom}${text}`, "toml").servers).toEqual({
      rea: { command: "rea" },
    });
  });
});

describe("Codex TOML serialization", () => {
  const unrelated = [
    "# Keep this explanation.",
    'notify = ["a", "b"]',
    "literal = 'C:\\demo\\path'",
    "",
  ].join("\n");
  const rea = { command: "npx", args: ["-y", "rea-agents@6.1.0", "mcp"] };
  const registered = `${unrelated}\n[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@6.1.0", "mcp"]\n`;
  const documentOf = (text: string): Record<string, unknown> =>
    parseClientConfiguration(text, "toml").document;
  const serialize = (document: Record<string, unknown>, original: string) =>
    serializeClientConfiguration(document, "toml", original, [
      ["mcp_servers", "rea"],
    ]);

  it("adds REA's table without rewriting comments or unrelated values", () => {
    const document = { ...documentOf(unrelated), mcp_servers: { rea } };
    const written = serialize(document, unrelated);

    expect(written.startsWith(unrelated)).toBe(true);
    expect(parseToml(written)).toEqual(document);
  });

  it("removes REA's table and leaves the rest of the file byte for byte", () => {
    const document = { ...documentOf(registered), mcp_servers: {} };

    expect(serialize(document, registered)).toBe(unrelated);
  });

  it("leaves a root disabled_mcp_servers list, which Codex does not read", () => {
    const original = `# Codex ignores this list.\ndisabled_mcp_servers = ["rea"]\n`;
    const document = { ...documentOf(original), mcp_servers: { rea } };
    const written = serialize(document, original);

    expect(written.startsWith(original)).toBe(true);
    expect(parseToml(written)).toEqual(document);
  });

  it("rewrites the document when an edit would not hold the requested values", () => {
    const document = {
      ...documentOf(unrelated),
      notify: ["changed"],
      mcp_servers: { rea },
    };
    const written = serialize(document, unrelated);

    expect(written).not.toContain("# Keep this explanation.");
    expect(parseToml(written)).toEqual(document);
  });
});
