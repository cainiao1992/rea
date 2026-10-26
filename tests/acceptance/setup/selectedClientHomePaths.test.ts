import {
  access,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect } from "vitest";

import { parseClientConfiguration } from "../../../src/application/ClientConfigurationDocument.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32")(
  "configures Codex in the filesystem-selected CODEX_HOME and shared skills in HOME with backups and repeat setup",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-selected-client-home-");
    const selected = join(root, "selected");
    await mkdir(join(selected, "deep"), { recursive: true });
    await symlink(join(selected, "deep"), join(root, "link"));
    const home = join(root, "home");
    await mkdir(home);
    const codexHome = `${root}/link/..`;
    const config = join(selected, "config.toml");
    const lexicalConfig = join(root, "config.toml");
    const original =
      'model = "selected-model"\n[mcp_servers.other]\ncommand = "other-server"\n';
    const sentinel = 'model = "unselected-model"\n';
    await mkdir(dirname(config), { recursive: true });
    await mkdir(dirname(lexicalConfig), { recursive: true });
    await writeFile(config, original);
    await writeFile(lexicalConfig, sentinel);
    const manifest = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const lexicalManifest = join(
      root,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    await mkdir(dirname(manifest), { recursive: true });
    await mkdir(dirname(lexicalManifest), { recursive: true });
    const originalSkill = "previous selected instructions\n";
    const sentinelSkill = "unselected instructions\n";
    await writeFile(manifest, originalSkill);
    await writeFile(lexicalManifest, sentinelSkill);
    const run = () =>
      cli.run({
        arguments: [
          "setup",
          "--client",
          "codex",
          "--skill-client",
          "codex",
          "--yes",
          "--json",
        ],
        cwd: root,
        environment: {
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexHome,
          HOPPER_LAUNCHER_PATH: join(root, "missing-hopper"),
          GHIDRA_INSTALL_DIR: join(root, "missing-ghidra"),
          JAVA_HOME: join(root, "missing-java"),
        },
      });
    const configured = await run();
    expect(configured.exitCode, configured.stdout + configured.stderr).toBe(0);
    const registered = parseClientConfiguration(
      await readFile(config, "utf8"),
      "toml",
    );
    expect(registered.document.model).toBe("selected-model");
    expect(registered.servers.other).toMatchObject({ command: "other-server" });
    expect(registered.servers.rea).toBeDefined();
    const installed = await readFile(manifest, "utf8");
    expect(installed).toContain("name: reverse-engineer-anything");
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    expect(await readFile(`${manifest}.rea.backup`, "utf8")).toBe(
      originalSkill,
    );
    expect(await readFile(lexicalConfig, "utf8")).toBe(sentinel);
    expect(await readFile(lexicalManifest, "utf8")).toBe(sentinelSkill);
    await expect(access(`${lexicalConfig}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(`${lexicalManifest}.rea.backup`)).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    const before = await readFile(config);
    const repeated = await run();
    expect(repeated.exitCode, repeated.stdout + repeated.stderr).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });
    expect((await readFile(config)).equals(before)).toBe(true);
    expect(await readFile(manifest, "utf8")).toBe(installed);
    expect(await readFile(lexicalConfig, "utf8")).toBe(sentinel);
    expect(await readFile(lexicalManifest, "utf8")).toBe(sentinelSkill);
    expect(
      (await readdir(dirname(manifest))).filter((name) =>
        name.startsWith(".rea-skill-"),
      ),
    ).toEqual([]);
  },
);
