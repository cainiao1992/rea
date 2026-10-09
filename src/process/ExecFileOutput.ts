import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

type ExecFileOutputOptions = Omit<
  ExecFileOptionsWithStringEncoding,
  "encoding" | "maxBuffer"
> & {
  readonly maxBuffer?: number;
  /**
   * Signal that stops the process on abort or timeout. The promise then
   * settles only after the process exits, so the caller can remove files it
   * writes; a process still running after a grace period is killed. Without
   * it, Node's execFile sends SIGTERM on abort and rejects before the
   * process exits.
   */
  readonly stopSignal?: NodeJS.Signals;
};

/** How long a stopped process may take to exit before it is killed. */
const STOP_GRACE_MS = 5_000;

const abortError = (signal: AbortSignal): Error => {
  const error = new Error("The operation was aborted", {
    cause: signal.reason,
  });
  error.name = "AbortError";
  Reflect.set(error, "code", "ABORT_ERR");
  return error;
};

/** Captured subprocess output read from an execFileOutput rejection. */
export interface ExecFileOutputFailure {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: string | number | null;
  readonly signal: string | null;
  readonly killed: boolean;
  readonly outputTruncated: boolean;
}

/** Read captured output metadata from a failed execFileOutput invocation. */
export const execFileOutputFailure = (
  cause: unknown,
): ExecFileOutputFailure | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const stdout = Reflect.get(cause, "stdout");
  const stderr = Reflect.get(cause, "stderr");
  const code = Reflect.get(cause, "code");
  const signal = Reflect.get(cause, "signal");
  const killed = Reflect.get(cause, "killed");
  if (typeof stdout !== "string" || typeof stderr !== "string")
    return undefined;
  return {
    stdout,
    stderr,
    code: typeof code === "string" || typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? signal : null,
    killed: killed === true,
    outputTruncated: code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  };
};

/** Run a shell-free command while capturing its complete UTF-8 output. */
export const execFileOutput = (
  command: string,
  arguments_: readonly string[],
  options: ExecFileOutputOptions = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const { stopSignal, signal, ...execOptions } = options;
    const stopped =
      stopSignal === undefined || signal === undefined
        ? undefined
        : { signal, stopSignal };
    if (stopped?.signal.aborted === true) {
      reject(abortError(stopped.signal));
      return;
    }
    let aborted = false;
    let grace: NodeJS.Timeout | undefined;
    const child = execFile(
      command,
      [...arguments_],
      {
        ...execOptions,
        ...(stopped === undefined
          ? signal === undefined
            ? {}
            : { signal }
          : { killSignal: stopped.stopSignal }),
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? Number.POSITIVE_INFINITY,
      },
      (error, stdout, stderr) => {
        stopped?.signal.removeEventListener("abort", onAbort);
        clearTimeout(grace);
        const failure =
          aborted && stopped !== undefined ? abortError(stopped.signal) : error;
        if (failure !== null) {
          Reflect.set(failure, "stdout", stdout);
          Reflect.set(failure, "stderr", stderr);
          reject(failure);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    const onAbort = (): void => {
      if (stopped === undefined) return;
      aborted = true;
      child.kill(stopped.stopSignal);
      grace = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    };
    stopped?.signal.addEventListener("abort", onAbort, { once: true });
  });
