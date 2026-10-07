import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildBinary } from "plist";
import { describe, expect, it } from "vitest";

import { analyzeInterfaceBuilderBundle } from "../../../src/application/InterfaceBuilderAnalysis.js";
import { encodeNibArchiveFixture } from "../../../src/artifacts/NibArchive.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const compile = promisify(execFile);

describe("compiled Interface Builder bundle reader", () => {
  it("reads nib plist archives and reports provenance", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const nib = join(
      bundle,
      "Contents",
      "Resources",
      "Main.storyboardc",
      "Main.nib",
    );
    await mkdir(nib, { recursive: true });
    await writeFile(
      join(nib, "objects.nib"),
      buildBinary({
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: [
          "$null",
          { $class: { UID: 2 }, title: "Build" },
          {
            $classname: "UIButton",
            $classes: ["UIButton", "UIControl", "UIView", "NSObject"],
          },
        ],
        $top: { root: { UID: 1 } },
      }),
    );
    await writeFile(
      join(bundle, "Contents", "Resources", "Main.storyboardc", "Info.plist"),
      '<?xml version="1.0"?><plist><dict><key>notAnArchive</key><string>scene-index</string></dict></plist>',
    );
    await mkdir(join(bundle, "Contents", "Resources", "outside.nib"), {
      recursive: true,
    });
    await writeFile(
      join(bundle, "Contents", "Resources", "outside.nib", "not-nib.txt"),
      "ignored",
    );

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "b".repeat(64),
    });
    expect(analysis.documents).toMatchObject([
      {
        relative_path:
          "Contents/Resources/Main.storyboardc/Main.nib/objects.nib",
        document_kind: "storyboard_scene",
        object_count: 1,
      },
    ]);
    expect(analysis.documents).toHaveLength(1);
    expect(analysis.graph.target_sha256).toBe("b".repeat(64));
    expect(analysis.graph.nodes.some(({ name }) => name === "Build")).toBe(
      true,
    );
  });

  it("projects compiled AppKit actions from the control to their target", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    // NSNibControlConnector archives the sending control as NSSource and its
    // target as NSDestination; a nil target is the first responder.
    await writeFile(
      join(resources, "Panel.nib"),
      encodeNibArchiveFixture({
        classes: [
          "NSNibExternalObjectPlaceholder",
          "NSButton",
          "NSNibControlConnector",
          "NSString",
          "NSMenuItem",
        ],
        objects: [
          { classIndex: 0, values: {} },
          { classIndex: 1, values: {} },
          {
            classIndex: 2,
            values: {
              NSSource: { ref: 1 },
              NSDestination: { ref: 0 },
              NSLabel: { ref: 3 },
            },
          },
          { classIndex: 3, values: { "NS.bytes": "doOK:" } },
          { classIndex: 4, values: {} },
          {
            classIndex: 2,
            values: {
              NSSource: { ref: 4 },
              NSDestination: null,
              NSLabel: { ref: 6 },
            },
          },
          { classIndex: 3, values: { "NS.bytes": "arrangeInFront:" } },
        ],
      }),
    );

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "e".repeat(64),
    });
    const byId = new Map(analysis.graph.nodes.map((node) => [node.id, node]));
    const routes = analysis.graph.nodes
      .filter(({ kind }) => kind === "action")
      .map((action) => ({
        action: action.name,
        from: analysis.graph.edges
          .filter(
            ({ relation, to }) =>
              relation === "target_action" && to === action.id,
          )
          .map(({ from }) => byId.get(from)?.name),
        to: analysis.graph.edges
          .filter(
            ({ relation, from, to }) =>
              relation === "target_action" &&
              from === action.id &&
              (to === null || byId.get(to)?.kind !== "objc_selector"),
          )
          .map(({ to }) => (to === null ? null : byId.get(to)?.name)),
      }))
      .sort((left, right) => left.action.localeCompare(right.action));
    expect(routes).toEqual([
      { action: "arrangeInFront:", from: ["NSMenuItem"], to: [null] },
      {
        action: "doOK:",
        from: ["NSButton"],
        to: ["NSNibExternalObjectPlaceholder"],
      },
    ]);
  });

  it("honors cancellation during directory traversal", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeInterfaceBuilderBundle({
        bundlePath: root,
        targetSha256: "c".repeat(64),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });
});

describe("bounded Interface Builder archive decoding", () => {
  it("counts malformed archives against the document limit", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "BadOne.nib"), Buffer.from("bplist00bad"));
    await writeFile(join(resources, "BadTwo.nib"), Buffer.from("bplist00bad"));

    const result = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "e".repeat(64),
      limits: { max_documents: 1 },
    });

    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "archive_decode",
        status: "partial",
        examined: 1,
        omitted: 1,
      }),
    );
    expect(result.graph.truncated).toBe(true);
  });

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/ibtool"))(
    "decodes an Xcode-compiled storyboard NIB and recovers its UI routes",
    async () => {
      const root = await createTestTempDirectory("rea-ib-compiled-test-");
      const bundle = join(root, "Example.app");
      const resources = join(bundle, "Contents", "Resources");
      const source = join(
        process.cwd(),
        "tests",
        "fixtures",
        "interface-builder",
        "MacFixture.storyboard",
      );
      await mkdir(resources, { recursive: true });
      await compile("/usr/bin/ibtool", [
        "--compile",
        join(resources, "MacFixture.storyboardc"),
        source,
      ]);

      const analysis = await analyzeInterfaceBuilderBundle({
        bundlePath: bundle,
        targetSha256: "d".repeat(64),
      });
      const names = analysis.graph.nodes.map(({ name }) => name);
      expect(names).toContain("BuildViewController");
      expect(names).toContain("Button");
      expect(names).toContain("buildTapped:");
      expect(
        analysis.graph.edges.some(
          ({ relation }) => relation === "target_action",
        ),
      ).toBe(true);
      const action = analysis.graph.nodes.find(
        ({ kind, name }) => kind === "action" && name === "buildTapped:",
      );
      expect(action).toBeDefined();
      const actionSource = analysis.graph.edges.find(
        ({ from, relation, to }) =>
          relation === "target_action" &&
          to === action?.id &&
          analysis.graph.nodes.find(({ id }) => id === from)?.kind ===
            "control",
      );
      const describeNode = (id: string | null) => {
        const node = analysis.graph.nodes.find((item) => item.id === id);
        return node === undefined ? String(id) : `${node.kind}:${node.name}`;
      };
      const actionRoutes = analysis.graph.edges
        .filter(
          ({ relation, from, to }) =>
            relation === "target_action" &&
            (from === action?.id || to === action?.id),
        )
        .map(({ from, to }) => `${describeNode(from)} -> ${describeNode(to)}`);
      // Temporary diagnostic: the compiled connector records.
      const { decodeNibArchive } =
        await import("../../../src/artifacts/NibArchive.js");
      const { readdir, readFile } = await import("node:fs/promises");
      const compiled = join(resources, "MacFixture.storyboardc");
      const records: string[] = [];
      for (const entry of await readdir(compiled, { recursive: true })) {
        if (!String(entry).endsWith(".nib")) continue;
        let bytes: Buffer;
        try {
          bytes = await readFile(join(compiled, String(entry)));
        } catch {
          continue;
        }
        if (bytes.subarray(0, 10).toString("ascii") !== "NIBArchive") {
          records.push(
            `${String(entry)}: ${bytes.subarray(0, 8).toString("ascii")}`,
          );
          continue;
        }
        const archive = decodeNibArchive(bytes);
        const byId = new Map(archive.objects.map((item) => [item.id, item]));
        const named = (value: unknown) => {
          const ref =
            typeof value === "object" &&
            value !== null &&
            "$nib_object_ref" in value
              ? Number(value.$nib_object_ref)
              : undefined;
          return ref === undefined
            ? JSON.stringify(value)
            : `${byId.get(ref)?.class_name.replace(/\0+$/u, "") ?? "?"}#${String(ref)}`;
        };
        for (const item of archive.objects) {
          const name = item.class_name.replace(/\0+$/u, "");
          if (!/Connector|Placeholder/u.test(name)) continue;
          records.push(
            `${String(entry)}#${String(item.id)} ${name} {${Object.entries(
              item.values,
            )
              .map(([key, value]) => `${key}=${named(value)}`)
              .join(", ")}}`,
          );
        }
      }
      expect(
        actionSource,
        `${actionRoutes.join("; ")} | ${records.join(" | ")}`,
      ).toBeDefined();
      expect(
        analysis.graph.edges.some(
          ({ from, relation, to }) =>
            from === action?.id &&
            relation === "target_action" &&
            to !== null &&
            analysis.graph.nodes.find(({ id }) => id === to)?.kind ===
              "placeholder",
        ),
      ).toBe(true);
      expect(
        analysis.graph.edges.some(({ relation }) => relation === "contains"),
      ).toBe(true);
      expect(analysis.graph.coverage).toContainEqual(
        expect.objectContaining({
          facet: "archive_decode",
          status: "complete",
        }),
      );
    },
  );
});
