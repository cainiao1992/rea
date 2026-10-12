import { describe, expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const bundle = (entry: string) => `(() => {
 const modules = {
  2(module) { module.exports = require("electron"); },
  5(module,exports,load) {
   const electron=load(2);
   Object.defineProperty(exports,"__esModule",{value:true});
   exports.sender = function(channel) {return (...args)=>send(channel,...args)};
   function send(channel,...args) {electron.ipcRenderer.send(channel,...args)}
   exports.events = {addListener(channel,handler) {
    const guarded = (event,...args) => {if (allowed(event)) handler(event,...args)};
    return electron.ipcMain.addListener(channel,guarded);
   }};
  },
  9(module,exports,load) {const electron=load(2), helper=load(5); ${entry}}
 };
 function load(id) {const m={exports:{}};modules[id].call(m.exports,m,m.exports,load);return m.exports;}
 load(9);
})();`;

describe("wrapped Electron control-flow alternatives", () => {
  it.each(["flag ? copy : cut", "flag ? copy : unknownHandler", "choose()"])(
    "does not select one IPC handler from %s",
    (handler) => {
      const result = analyzeJavaScriptStaticSource(`
        const e = require("electron");
        const copy = event => event.sender.copy();
        const cut = event => event.sender.cut();
        function choose() { if (flag) return copy; }
        function register(channel, handler) { e.ipcMain.on(channel, handler); }
        register("test:copy", ${handler});
      `);
      expect(result.electron.ipc).toContainEqual(
        expect.objectContaining({
          channel: "test:copy",
          side: "main",
          handler_kind: "dynamic-expression",
          resolution_basis: "wrapper-substitution",
        }),
      );
      expect(result.electron.call_paths ?? []).toEqual([]);
      expect(result.parse_status).toBe("partial");
    },
  );
  it.each(["'ready'", "false", "0", "''", "({})", "(()=>{})"])(
    "short-circuits nullish fallback for %s in callbacks and seed calls",
    (left) => {
      for (const source of [
        `e.ipcMain.on("test:copy", event => { ${left} ?? event.sender.copy(); });`,
        `${left} ?? e.ipcMain.on("test:copy", event => event.sender.copy());`,
        `e.ipcMain.on("test:copy", event => { const selected = ${left} ?? (()=>event.sender.copy()); selected(); });`,
      ])
        expect(
          analyzeJavaScriptStaticSource(`const e=require("electron");${source}`)
            .electron.call_paths ?? [],
        ).toEqual([]);
    },
  );
  it.each(["null", "undefined", "void 0"])(
    "follows nullish fallback for %s",
    (left) => {
      const result = analyzeJavaScriptStaticSource(`const e=require("electron");
        ${left} ?? e.ipcMain.on("test:copy", event => { ${left} ?? event.sender.copy(); });`);
      expect(result.electron.call_paths).toContainEqual(
        expect.objectContaining({
          terminal: "ipc-event.sender.copy",
          conditions: [],
        }),
      );
    },
  );
  it("retains a nullish guard for unknown fallback rather than a falsy guard", () => {
    for (const source of [
      `e.ipcMain.on("test:copy", event => { value ?? event.sender.copy(); });`,
      `value ?? e.ipcMain.on("test:copy", event => event.sender.copy());`,
    ]) {
      const result = analyzeJavaScriptStaticSource(
        `const e=require("electron");${source}`,
      );
      expect(result.electron.call_paths).toContainEqual(
        expect.objectContaining({
          terminal: "ipc-event.sender.copy",
          conditions: [
            expect.objectContaining({
              expression: "(value) === null || (value) === undefined",
            }),
          ],
        }),
      );
    }
  });
  it.each([
    "if (flag) return copy; else return cut; return dead;",
    "if (flag) { return copy; } return cut;",
    "if (flag) { if (other) return copy; else return cut; } else return cut; return dead;",
  ])("retains every possible factory return: %s", (body) => {
    const result = analyzeJavaScriptStaticSource(`const e=require("electron");
      const copy=()=>e.ipcRenderer.send("test:copy"), cut=()=>e.ipcRenderer.send("test:cut"), dead=()=>e.ipcRenderer.send("test:dead");
      function choose(){${body}}
      e.contextBridge.exposeInMainWorld("desktop", {copy:choose()});`);
    expect(
      [
        ...new Set(result.electron.call_paths?.map((path) => path.channel)),
      ].sort(),
    ).toEqual(["test:copy", "test:cut"]);
  });
});

describe("wrapped Electron call paths", () => {
  it("connects exposed closures to IPC sends and text clipboard calls", () => {
    const result = analyzeJavaScriptStaticSource(
      bundle(`
   const text = value => navigator.clipboard.writeText(value);
   const api={copy:helper.sender("example:copy"),copyText:text};
   electron.contextBridge.exposeInMainWorld("desktop",api);
  `),
    );
    expect(result.electron.context_bridge_apis).toMatchObject([
      { api_key: "desktop", members: ["copy", "copyText"] },
    ]);
    expect(result.electron.ipc).toContainEqual(
      expect.objectContaining({
        side: "renderer",
        channel: "example:copy",
        operation: "send",
      }),
    );
    expect(result.electron.call_paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entry: "desktop.copy",
          channel: "example:copy",
          terminal: "electron.ipcRenderer.send",
        }),
        expect.objectContaining({
          entry: "desktop.copyText",
          terminal: "navigator.clipboard.writeText",
        }),
      ]),
    );
  });
  it("substitutes guarded listener callbacks and preserves guard evidence", () => {
    const result = analyzeJavaScriptStaticSource(
      bundle(
        `helper.events.addListener("example:copy",event=>event.sender.copy());`,
      ),
    );
    expect(result.electron.ipc).toContainEqual(
      expect.objectContaining({
        side: "main",
        channel: "example:copy",
        operation: "on",
      }),
    );
    expect(result.electron.call_paths).toContainEqual(
      expect.objectContaining({
        entry_kind: "ipc-handler",
        channel: "example:copy",
        terminal: "ipc-event.sender.copy",
        conditions: [expect.objectContaining({ expression: "allowed(event)" })],
      }),
    );
  });
  it("does not identify overwritten Electron namespaces or shadowed require", () => {
    for (const source of [
      `const e=require("electron");e.ipcMain={on(){}};e.ipcMain.on("bad",event=>event.sender.copy());`,
      `function require(){return {ipcMain:{on(){}}}};const e=require("electron");e.ipcMain.on("bad",event=>event.sender.copy());`,
    ])
      expect(
        analyzeJavaScriptStaticSource(source).electron.call_paths ?? [],
      ).toEqual([]);
  });
  it("does not follow a statically false callback branch", () => {
    const result = analyzeJavaScriptStaticSource(
      bundle(
        `helper.events.addListener("example:copy",event=>{if(false)event.sender.copy()});`,
      ),
    );
    expect(result.electron.call_paths ?? []).toEqual([]);
  });
  it("retains early rejection guards and excludes calls after definite returns", () => {
    const guarded = analyzeJavaScriptStaticSource(
      `const e=require("electron");e.ipcMain.on("guard",event=>{if(!allowed(event))return;event.sender.copy()});`,
    );
    expect(guarded.electron.call_paths).toContainEqual(
      expect.objectContaining({
        conditions: [
          expect.objectContaining({ expression: "!(!allowed(event))" }),
        ],
      }),
    );
    for (const body of [
      "return;event.sender.copy()",
      "if(true)return;event.sender.copy()",
      "if(false)event.sender.copy()",
    ])
      expect(
        analyzeJavaScriptStaticSource(
          `const e=require("electron");e.ipcMain.on("dead",event=>{${body}});`,
        ).electron.call_paths ?? [],
      ).toEqual([]);
    expect(
      analyzeJavaScriptStaticSource(
        `const e=require("electron");if(false)e.ipcMain.on("dead",event=>event.sender.copy());`,
      ).electron.call_paths ?? [],
    ).toEqual([]);
  });
  it("rejects dynamic channels, computed overwrites, unknown spreads and reassigned callback parameters", () => {
    for (const entry of [
      `helper.events.addListener(runtimeChannel,event=>event.sender.copy());`,
      `electron[runtimeKey]={};electron.ipcMain.on("bad",event=>event.sender.copy());`,
      `const api={copy:helper.sender("bad"),...unknownApi};electron.contextBridge.exposeInMainWorld("desktop",api);`,
      `helper.events.addListener("bad",event=>{event=other;event.sender.copy()});`,
    ])
      expect(
        analyzeJavaScriptStaticSource(bundle(entry)).electron.call_paths ?? [],
      ).toEqual([]);
  });
  it("resolves renamed default and namespace import helpers from their syntax", () => {
    const result = analyzeJavaScriptStaticSource(
      bundle(`
   const defaultImport=x=>x&&x.__esModule?x:{default:x};
   function namespaceImport(x){if(x&&x.__esModule)return x;return unknownWrap(x)}
   const E=defaultImport(load(2)),H=namespaceImport(load(5));
   E.default.contextBridge.exposeInMainWorld("renamed",{copy:(0,H.sender)("test:renamed")});
  `),
    );
    expect(result.electron.call_paths).toContainEqual(
      expect.objectContaining({
        entry: "renamed.copy",
        channel: "test:renamed",
        terminal: "electron.ipcRenderer.send",
      }),
    );
    expect(
      result.electron.call_paths
        ?.flatMap((p) => p.steps)
        .every((step) => step.label.length > 0),
    ).toBe(true);
  });
  it("does not trust helper names or follow returns after a definite throw", () => {
    for (const helper of [
      `function __toESM() {return {ipcRenderer:{send(){}}}}`,
      `function __toESM(value) {throw Error("inert");return value;}`,
      `function __toESM(value) {if(true){throw Error("inert")}return value;}`,
    ]) {
      const result = analyzeJavaScriptStaticSource(`
        const electron = require("electron");
        ${helper}
        const wrapped = __toESM(electron);
        electron.contextBridge.exposeInMainWorld("desktop",{
          copy:()=>wrapped.ipcRenderer.send("test:copy")
        });
      `);
      expect(result.electron.call_paths ?? []).toEqual([]);
    }
  });
});
