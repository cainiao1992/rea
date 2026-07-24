import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/errors.js";

const OPERATION = "capture_browser_scenario" as const;

export const withPlaywrightExecutionBoundary = <Value>(
  work: () => Promise<Value>,
  maximumTimeoutMs: number,
  signal?: AbortSignal,
): Promise<Value> => {
  if (maximumTimeoutMs <= 0)
    return Promise.reject(
      new AnalysisTimeoutError(OPERATION, maximumTimeoutMs),
    );
  if (signal?.aborted === true)
    return Promise.reject(new AnalysisCancelledError(OPERATION));

  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (value: Value): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      fail(new AnalysisCancelledError(OPERATION));
    };
    timer = setTimeout(
      () => fail(new AnalysisTimeoutError(OPERATION, maximumTimeoutMs)),
      maximumTimeoutMs,
    );
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    void work().then(succeed, fail);
  });
};
