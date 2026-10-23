import { expect, it, vi } from "vitest";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { parseProcessScenario } from "../../domain/process/processScenario.js";
import {
  createProcessCaptureObservationBuffer,
  resolveProcessResult,
} from "./ProcessCaptureLifecycle.js";
import { createProcessTerminalFinalizer } from "./ProcessTerminalObservation.js";

it("retains completed terminal facts and the typed capacity failure through finalization", async () => {
  const failure = new AnalysisResourceConstraintError(
    "capture_process",
    "capacity",
    "Sampled PID projection exceeded output_bytes",
    { maximum_output_bytes: 4 },
  );
  const readRetention = vi.fn(() => {
    throw failure;
  });
  const frames = [{ sequence: 0, at_ms: 17, data: "20" }];
  const observations = createProcessCaptureObservationBuffer({
    frames,
    samples: [],
    interactions: [],
    eventJournal: [],
    before: undefined,
  });
  const rendered = [
    {
      sequence: 0,
      at_ms: 17,
      columns: 10,
      rows: 1,
      cursor_x: 0,
      cursor_y: 0,
      active_buffer: "normal" as const,
      lines: [""],
      serialized_state: "",
    },
  ];
  const renderer = { frames: vi.fn(async () => rendered) };
  const finalize = createProcessTerminalFinalizer(
    renderer,
    readRetention,
    observations,
  );
  const result = await finalize();
  expect(await finalize()).toBe(result);
  expect(readRetention).toHaveBeenCalledOnce();
  expect(renderer.frames).toHaveBeenCalledOnce();
  if (result.ok) throw new Error("Expected terminal capacity refusal");
  expect(result.error).toBe(failure);
  expect(observations.rendered_frames).toEqual({
    state: "available",
    value: rendered,
  });
  const scenario = parseProcessScenario({
    executable: "unused",
    limits: { output_bytes: 4 },
  });
  const cleanup = { state: "not_required" as const, reason: null };
  expect(() =>
    resolveProcessResult(
      undefined,
      result.error,
      {
        report: {
          owned_process_group: cleanup,
          terminal_renderer: cleanup,
          temporary_root: cleanup,
        },
        cleanupLease: undefined,
      },
      observations,
      { scenario, rootPid: 100 },
    ),
  ).toThrow(failure);
  expect(projectAnalysisError(failure)).toMatchObject({
    code: "resource_constraint",
    details: {
      partial_observation: {
        observations: {
          frames: { state: "available", value: frames },
          rendered_frames: { state: "available", value: rendered },
        },
      },
    },
  });
});
