import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("JavaScript static analysis findings", () => {
  it("retains every static reference and Electron property in large literals", () => {
    const names = Array.from({ length: 300 }, (_, index) => `key${index}`);
    const source = [
      ...names.map(
        (name, index) => `import value${index} from "./${name}.js";`,
      ),
      `new BrowserWindow({ webPreferences: { ${names.map((name) => `${name}: true`).join(", ")} } });`,
      `contextBridge.exposeInMainWorld("api", { ${names.map((name) => `${name}: () => true`).join(", ")} });`,
      `const { ${names.join(", ")} } = require("./addon.node");`,
    ].join("\n");
    const analysis = analyzeJavaScriptStaticSource(source, {
      maxAstNodes: 100_000,
      deadline: Number.POSITIVE_INFINITY,
      now: () => 0,
    });

    expect(analysis.parse_status).toBe("complete");
    expect(analysis.references).toHaveLength(301);
    expect(analysis.electron.browser_windows[0]?.web_preferences).toHaveLength(
      300,
    );
    expect(analysis.electron.context_bridge_apis[0]?.members).toHaveLength(300);
    expect(analysis.electron.native_addon_bindings[0]?.members).toHaveLength(
      300,
    );
  });
});
