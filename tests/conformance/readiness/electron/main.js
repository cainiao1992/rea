const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  utilityProcess,
} = require("electron");

const windows = new Set();
app.on("open-url", (_event, url) => {
  for (const window of windows) window.webContents.send("deep-link", url);
});
app.whenReady().then(() => {
  const window = new BrowserWindow({
    webPreferences: { preload: require.resolve("./preload.js") },
  });
  windows.add(window);
  window.loadFile("renderer.html");
  utilityProcess.fork(require.resolve("./utility.js"));
  ipcMain.handle("readiness:echo", (_event, value) => ({ value }));
  window.webContents.on("render-process-gone", () => window.reload());
  shell.openExternal("https://blocked.invalid").catch(() => undefined);
});
