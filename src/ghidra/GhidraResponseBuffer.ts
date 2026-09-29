/** Callbacks for one newline-delimited Ghidra response stream. */
export interface GhidraResponseBufferOptions {
  readonly onLine: (line: string) => void;
}

/** Splits fragmented UTF-8 socket data into response lines. */
export class GhidraResponseBuffer {
  readonly #options: GhidraResponseBufferOptions;
  #buffer = "";

  constructor(options: GhidraResponseBufferOptions) {
    this.#options = options;
  }

  /** Consume one decoded socket chunk. */
  push(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const encodedLine = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const line = encodedLine.trim();
      if (line.length > 0) this.#options.onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  /** Drop any incomplete line when a session closes. */
  reset(): void {
    this.#buffer = "";
  }
}
