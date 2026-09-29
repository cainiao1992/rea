import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { createJavaScriptRuntimeObservationEvidence } from "../../../src/application/JavaScriptRuntimeObservationEvidence.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../../../src/application/JavaScriptRuntimeObservationService.js";
import { createPermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import { reconcileJavaScriptRuntimeEvidence } from "../../../src/application/JavaScriptRuntimeReconciliationService.js";
import { V8_INSPECTOR_PROVIDER_IDENTITY } from "../../../src/browser/V8InspectorProvider.js";
import { V8InspectorProvider } from "../../../src/browser/V8InspectorProvider.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../../src/contracts/javascriptRuntimeReconciliationExample.js";
import type {
  JavaScriptRuntimeObservation,
  ObserveJavaScriptRuntimeInput,
} from "../../../src/domain/javascriptRuntimeObservation.js";
import { observeJavaScriptRuntimeToolInputSchema } from "../../../src/domain/javascriptRuntimeObservation.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascriptRuntimeReconciliationSchemas.js";
import type {
  PermissionCeiling,
  PermissionGrant,
} from "../../../src/domain/permissionPolicy.js";
import { startFakeV8Inspector } from "../../fixtures/fakeV8Inspector.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("passive V8 Inspector provider", () => {
  test("keeps collection budgets out of the caller schema", () => {
    expect(
      observeJavaScriptRuntimeToolInputSchema.safeParse({
        inspector_endpoint: "http://127.0.0.1:9229",
        allowed_file_roots: ["/tmp/app"],
        allowed_origins: [],
        target_id: "target-1",
        limits: {},
      }).success,
    ).toBe(false);
  });

  test("returns every approved Inspector target inline", async () => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      additionalTargetCount: 205,
    });
    try {
      const listed = await new V8InspectorProvider().listTargets({
        inspector_endpoint: fake.endpoint,
        allowed_file_roots: [fixture.root],
        allowed_origins: [],
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.targets).toHaveLength(206);
      expect(listed.value.targets[0]?.target_id).toBe(fake.targetId);
    } finally {
      await fake.close();
    }
  });

  test("filters target locations and never retains the excluded path", async () => {
    const fixture = await runtimeFixture();
    const outside = await temporaryFile("outside.js");
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      additionalTargetUrl: pathToFileURL(outside).href,
    });
    try {
      const result = await new V8InspectorProvider().listTargets({
        inspector_endpoint: fake.endpoint,
        allowed_file_roots: [fixture.root],
        allowed_origins: [],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.targets).toHaveLength(1);
      expect(result.value.excluded.outside_file_roots).toBe(1);
      expect(JSON.stringify(result.value)).not.toContain(outside);
    } finally {
      await fake.close();
    }
  });

  test("captures complete metadata with two enable commands", async () => {
    const fixture = await runtimeFixture();
    const outside = await temporaryFile("secret.js");
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      scriptUrls: [
        pathToFileURL(fixture.entry).href,
        "node:fs",
        pathToFileURL(outside).href,
      ],
    });
    try {
      const result = await new V8InspectorProvider().observe(
        observeInput(fake.endpoint, fake.targetId, fixture.root, "node"),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.scripts.items).toHaveLength(2);
      expect(result.value.scripts.excluded.outside_file_roots).toBe(1);
      expect(result.value.execution_contexts).toEqual([
        {
          context_key: "1",
          state: "created",
          name: null,
          origin: null,
        },
      ]);
      expect(fake.commands.map(({ method }) => method)).toEqual([
        "Runtime.enable",
        "Debugger.enable",
      ]);
      expect(JSON.stringify(result.value)).not.toContain(outside);
      expect(result.value.unavailable_without_instrumentation).toContain(
        "Electron IPC messages and handlers",
      );
    } finally {
      await fake.close();
    }
  });

  test("excludes an Electron main target that reports only bare file://", async () => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: "file://",
      scriptUrls: [pathToFileURL(fixture.entry).href],
    });
    try {
      const provider = new V8InspectorProvider();
      const listed = await provider.listTargets({
        inspector_endpoint: fake.endpoint,
        allowed_file_roots: [fixture.root],
        allowed_origins: [],
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.targets).toEqual([]);

      const observed = await provider.observe(
        observeInput(
          fake.endpoint,
          fake.targetId,
          fixture.root,
          "electron-main",
        ),
      );
      expect(observed.ok).toBe(false);
      if (observed.ok) return;
      expect(observed.error.message).toMatch(/outside_file_roots|target/u);
    } finally {
      await fake.close();
    }
  });

  test.each([
    ["node", "node"],
    ["electron-main", "node"],
    ["electron-preload", "page"],
    ["electron-renderer", "page"],
  ] as const)(
    "admits declared %s only on its protocol target family",
    async (runtimeKind, targetType) => {
      const fixture = await runtimeFixture();
      const fake = await startFakeV8Inspector({
        targetUrl: pathToFileURL(fixture.entry).href,
        targetType,
      });
      try {
        const result = await new V8InspectorProvider().observe(
          observeInput(fake.endpoint, fake.targetId, fixture.root, runtimeKind),
        );
        expect(result.ok).toBe(true);
      } finally {
        await fake.close();
      }
    },
  );
});

describe("complete Inspector script hashes", () => {
  test("keeps more than one hundred long script hashes distinct", async () => {
    const fixture = await runtimeFixture();
    const url = pathToFileURL(fixture.entry).href;
    const prefix = "h".repeat(512);
    const scriptHashes = Array.from(
      { length: 101 },
      (_, index) => `${prefix}${String(index)}`,
    );
    const fake = await startFakeV8Inspector({
      targetUrl: url,
      scriptUrls: scriptHashes.map(() => url),
      scriptHashes,
    });
    try {
      const result = await new V8InspectorProvider().observe(
        observeInput(fake.endpoint, fake.targetId, fixture.root, "node"),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.scripts.items).toHaveLength(scriptHashes.length);
      expect(
        new Set(result.value.scripts.items.map(({ cdp_hash }) => cdp_hash)),
      ).toEqual(new Set(scriptHashes));
    } finally {
      await fake.close();
    }
  });
});

describe("undeclared V8 runtime role", () => {
  test("observes a target without inventing a runtime role", async () => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      targetType: "page",
    });
    try {
      const input = observeInput(
        fake.endpoint,
        fake.targetId,
        fixture.root,
        "node",
      );
      delete input.runtime_kind;
      const result = await new V8InspectorProvider().observe(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.target).toMatchObject({
        protocol_type: "page",
        runtime_kind: "unknown",
        runtime_kind_authority: "not-declared",
      });
    } finally {
      await fake.close();
    }
  });
});

describe("passive V8 Inspector evidence", () => {
  test("retains authorized script locations longer than the former byte ceiling", async () => {
    const fixture = await runtimeFixture();
    const longUrl = `https://example.test/${"a".repeat(20_000)}`;
    const fake = await startFakeV8Inspector({
      targetUrl: longUrl,
      scriptUrls: [longUrl],
    });
    try {
      const input = {
        ...observeInput(fake.endpoint, fake.targetId, fixture.root, "node"),
        allowed_origins: ["https://example.test"],
      };
      const result = await new V8InspectorProvider().observe(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.scripts.items).toHaveLength(1);
      expect(result.value.scripts.items[0]?.location).toMatchObject({
        kind: "url",
        origin: "https://example.test",
        sanitized_url: longUrl,
      });
    } finally {
      await fake.close();
    }
  });

  test("returns every authorized script beyond the former collection ceiling", async () => {
    const fixture = await runtimeFixture();
    const scriptUrls = [
      pathToFileURL(fixture.entry).href,
      ...Array.from({ length: 2_004 }, () => pathToFileURL(fixture.entry).href),
    ];
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
      scriptUrls,
    });
    try {
      const input = observeInput(
        fake.endpoint,
        fake.targetId,
        fixture.root,
        "node",
      );
      const result = await new V8InspectorProvider().observe(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.capture.truncated).toBe(false);
      expect(result.value.capture.truncation_reasons).toEqual([]);
      expect(result.value.capture.events_dropped).toBe(0);
      expect(result.value.scripts.items).toHaveLength(scriptUrls.length);
    } finally {
      await fake.close();
    }
  });

  test("produces deterministic Evidence through the authorized service", async () => {
    const fixture = await runtimeFixture();
    const fake = await startFakeV8Inspector({
      targetUrl: pathToFileURL(fixture.entry).href,
    });
    try {
      const input = observeInput(
        fake.endpoint,
        fake.targetId,
        fixture.root,
        "node",
      );
      const authority = await authorityFor(fake.endpoint, fixture.root);
      const first = await observeJavaScriptRuntime(
        new V8InspectorProvider(),
        authority,
        input,
      );
      const second = await observeJavaScriptRuntime(
        new V8InspectorProvider(),
        authority,
        input,
      );
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.value.evidence_id).toBe(first.value.evidence_id);

      const listed = await listJavaScriptRuntimeTargets(
        new V8InspectorProvider(),
        authority,
        {
          inspector_endpoint: fake.endpoint,
          allowed_file_roots: [fixture.root],
          allowed_origins: [],
        },
      );
      expect(listed.ok).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test("reconciles V8 script presence with static Application Graph Evidence", () => {
    const root = "/Applications/Example.app/Contents/Resources/app";
    const observation = runtimeObservation(
      `${root}/index.html`,
      `${root}/renderer.js`,
    );
    const runtimeEvidence = createJavaScriptRuntimeObservationEvidence(
      "observe_javascript_runtime",
      {
        inspector_endpoint: "http://127.0.0.1:9229",
        allowed_file_roots: [root],
        allowed_origins: [],
        target_id: "example-v8-target",
        runtime_kind: "electron-main",
        observation_ms: 100,
      },
      observation,
      V8_INSPECTOR_PROVIDER_IDENTITY,
    );
    const reconciled = reconcileJavaScriptRuntimeEvidence({
      static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
      runtime_observations: [runtimeEvidence],
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      reconciled.value.normalized_result,
    );
    expect(result.runtime_captures[0]?.kind).toBe("v8-inspector");
    expect(result.summary.runtime_scripts).toBe(1);
    expect(result.summary.matched).toBeGreaterThan(0);
  });
});

const runtimeFixture = async () => {
  const root = await createTestTempDirectory("rea-v8-runtime-");
  const entry = join(root, "entry.js");
  await writeFile(entry, "export const value = 1;\n");
  return { root, entry };
};

const temporaryFile = async (name: string): Promise<string> => {
  const root = await createTestTempDirectory("rea-v8-outside-");
  const path = join(root, name);
  await writeFile(path, "export {};\n");
  return path;
};

const observeInput = (
  endpoint: string,
  targetId: string,
  root: string,
  runtimeKind: ObserveJavaScriptRuntimeInput["runtime_kind"],
): ObserveJavaScriptRuntimeInput => ({
  inspector_endpoint: endpoint,
  allowed_file_roots: [root],
  allowed_origins: [],
  target_id: targetId,
  runtime_kind: runtimeKind,
  observation_ms: 10,
});

const authorityFor = async (endpoint: string, root: string) => {
  const scope: PermissionCeiling = {
    capability: "v8_inspector_observe",
    roots: [root],
    executables: [],
    environment_names: [],
    origins: [endpoint],
    network: "loopback",
    mount: false,
  };
  const grant: PermissionGrant = {
    ...scope,
    grant_id: "test:v8-inspector",
    lifetime: "administrator",
    operation_identity: null,
    expires_at: null,
  };
  const authority = await createPermissionAuthority([scope], [grant]);
  if (!authority.ok) throw authority.error;
  return authority.value;
};

const runtimeObservation = (
  targetPath: string,
  scriptPath: string,
): JavaScriptRuntimeObservation => ({
  runtime: {
    product: "node.js/v24.4.1",
    protocol_version: "1.3",
    v8_version: "13.6",
  },
  target: {
    target_id: "example-v8-target",
    protocol_type: "node",
    attached: false,
    location: { kind: "file", file_path: targetPath },
    runtime_kind: "electron-main",
    runtime_kind_authority: "caller-declared-unverified",
  },
  capture: {
    observation_ms: 100,
    events_observed: 1,
    events_retained: 1,
    events_dropped: 0,
    metadata_bytes_retained: 100,
    truncated: false,
    truncation_reasons: [],
  },
  scripts: {
    items: [
      {
        script_key: `v8_script_${"4".repeat(64)}`,
        location: { kind: "file", file_path: scriptPath },
        execution_context_key: "1",
        cdp_hash: "v8-hash",
        length: 29,
        is_module: true,
        status: "observed-loaded",
      },
    ],
    observed_total: 1,
    excluded: {
      outside_file_roots: 0,
      outside_origins: 0,
      unsupported_location: 0,
      invalid_protocol_value: 0,
    },
  },
  execution_contexts: [],
  directly_observed: ["Debugger.scriptParsed established script presence."],
  unavailable_without_instrumentation: [
    "require/import caller-to-callee edges",
  ],
  unknowns: ["Capture is bounded."],
  limitations: ["Passive Inspector metadata only."],
});
