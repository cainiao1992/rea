import { err, ok, type Result } from "../../domain/result.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";
import type { TerminalRenderer } from "./TerminalRenderer.js";
import type {
  ProcessCaptureObservationBuffer,
  TerminalCaptureRetention,
} from "./ProcessCaptureLifecycle.js";
import type { RenderedTerminalFrame } from "../../domain/process/processCapture.js";

interface ProcessTerminalObservation {
  readonly retention: TerminalCaptureRetention;
  readonly renderedFrames: readonly RenderedTerminalFrame[];
}

const terminalFailure = (cause: unknown): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : new ProcessCaptureError(
        `Terminal observation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );

/** Finalize retained chunks once after sampling, for both completion and error cleanup. */
export const createProcessTerminalFinalizer = (
  renderer: Pick<TerminalRenderer, "frames">,
  retention: () => TerminalCaptureRetention,
  observations: ProcessCaptureObservationBuffer,
): (() => Promise<Result<ProcessTerminalObservation, AnalysisError>>) => {
  let completed:
    | Promise<Result<ProcessTerminalObservation, AnalysisError>>
    | undefined;
  return () =>
    (completed ??= observeTerminal(renderer, retention, observations));
};

const observeTerminal = async (
  renderer: Pick<TerminalRenderer, "frames">,
  readRetention: () => TerminalCaptureRetention,
  observations: ProcessCaptureObservationBuffer,
): Promise<Result<ProcessTerminalObservation, AnalysisError>> => {
  let retention: Result<TerminalCaptureRetention, AnalysisError>;
  try {
    retention = ok(readRetention());
  } catch (cause) {
    retention = err(terminalFailure(cause));
  }
  let rendered: Result<readonly RenderedTerminalFrame[], AnalysisError>;
  try {
    const frames = await renderer.frames();
    rendered = ok(frames);
    observations.rendered_frames = {
      state: "available",
      value: frames,
    };
  } catch (cause) {
    const failure = terminalFailure(cause);
    rendered = err(failure);
    observations.rendered_frames = {
      state: "unavailable",
      reason: `Rendered terminal frame collection failed: ${failure.message}`,
    };
  }
  if (!retention.ok) {
    if (!rendered.ok)
      retention.error.retainSecondaryFailure(rendered.error, {
        rendered_terminal_failure: projectAnalysisError(rendered.error),
      });
    return retention;
  }
  if (!rendered.ok) return rendered;
  return ok({ retention: retention.value, renderedFrames: rendered.value });
};
