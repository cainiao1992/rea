import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest(
  "preserves renderer endpoint certainty through CLI graph delivery",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-renderer-endpoints-");
    await writeFixtureFiles(root, {
      "main.cjs": `
      const { BrowserWindow } = require("electron");
      const replaced = new BrowserWindow();
      replaced.loadURL = () => {};
      replaced.loadURL("https://replaced.test");
      const local = { loadURL(value) { return value; } };
      local.loadURL("https://local.test");
      const intact = new BrowserWindow();
      intact.loadURL("https://intact.test");
      new BrowserWindow().loadURL(runtimeUrl);
      new BrowserWindow().loadFile("page.html");
    `,
      "page.html": "<p>Local renderer</p>",
    });
    const result = await analyzeJavaScriptDirectory("CLI", cli, root);
    const endpoints = result.graph.nodes.filter(
      ({ kind }) => kind === "endpoint",
    );
    expect(endpoints).toHaveLength(4);
    for (const value of ["https://replaced.test", "https://local.test"]) {
      const endpoint = endpoints.find(({ observations }) =>
        observations.some(({ properties }) => properties.value === value),
      );
      expect(endpoint?.observations[0]).toMatchObject({
        properties: { value, interpretation: "candidate" },
        evidence: { state: "inferred", confidence: "low" },
      });
      expect(endpoint?.observations[0]?.evidence.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("receiver does not establish a network call"),
        ]),
      );
      expect(
        result.graph.edges.find(
          ({ target_node_id }) => target_node_id === endpoint?.node_id,
        ),
      ).toMatchObject({
        relation: "calls",
        properties: { interpretation: "candidate" },
        evidence: { state: "inferred", confidence: "low" },
      });
    }
    const intact = endpoints.find(({ observations }) =>
      observations.some(
        ({ properties }) => properties.value === "https://intact.test",
      ),
    );
    expect(intact?.observations[0]).toMatchObject({
      properties: { value: "https://intact.test" },
      evidence: { state: "observed", confidence: "exact" },
    });
    expect(intact?.observations[0]?.properties).not.toHaveProperty(
      "interpretation",
    );
    const dynamic = endpoints.find(({ observations }) =>
      observations.some(({ properties }) => properties.value === "runtimeUrl"),
    );
    expect(dynamic?.observations[0]).toMatchObject({
      properties: { value: "runtimeUrl", resolution: "partial" },
      evidence: { state: "observed" },
    });
  },
);
