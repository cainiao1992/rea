import { describe, expect, it } from "vitest";

import {
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
} from "./ClientConfigurationDocument.js";

const registration = { command: "rea", args: ["mcp"] };

describe("TOML configuration source capacity", () => {
  it("retains a large multiline foreign value inside an inline server table", () => {
    const note = `first\n${"x\n".repeat(500_000)}last`;
    const original = `mcp_servers = { other = {command="other",env={NOTE="""${note}"""}}}\n`;
    const parsed = parseClientConfiguration(original, "toml");
    const desired = withClientServers(parsed, {
      ...parsed.servers,
      rea: registration,
    });
    const configured = serializeClientConfiguration(desired, "toml", original);
    expect(configured).toContain(`NOTE="""${note}"""`);
    expect(parseClientConfiguration(configured, "toml").document).toEqual(
      desired,
    );
    const removed = serializeClientConfiguration(
      parsed.document,
      "toml",
      configured,
    );
    expect(removed).toContain(`NOTE="""${note}"""`);
    expect(parseClientConfiguration(removed, "toml").document).toEqual(
      parsed.document,
    );
  });

  it("removes only REA from a large multiline Grok disabled-server list", () => {
    const otherNames = '"other",\n'.repeat(500_000);
    const original =
      `disabled_mcp_servers = [\n"rea",\n${otherNames}]\n` +
      '[mcp_servers.other]\ncommand = "other"\n';
    const parsed = parseClientConfiguration(original, "grok");
    const desired = withClientServers(parsed, {
      ...parsed.servers,
      rea: registration,
    });
    const configured = serializeClientConfiguration(desired, "grok", original);
    const result = parseClientConfiguration(configured, "grok");
    expect(result.document.disabled_mcp_servers).toEqual(
      Array<string>(500_000).fill("other"),
    );
    expect(result.servers).toEqual({
      other: { command: "other" },
      rea: registration,
    });
  });
});
