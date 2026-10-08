import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

type ExecFileOutputOptions = Omit<
  ExecFileOptionsWithStringEncoding,
  "encoding" | "maxBuffer"
> & { readonly maxBuffer?: number };

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
    execFile(
      command,
      [...arguments_],
      {
        ...options,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? Number.POSITIVE_INFINITY,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          Reflect.set(error, "stdout", stdout);
          Reflect.set(error, "stderr", stderr);
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
