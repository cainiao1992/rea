import type {
  ConsoleMessage,
  Download,
  Frame,
  Page,
  Request,
  Response,
  WebSocket,
  Worker,
} from "playwright-core";

import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import {
  browserScenarioEventSchema,
  type BrowserScenarioEvent,
} from "../domain/browserScenarioCapture.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import type { BrowserScenarioCaptureBudget } from "./PlaywrightScenarioArtifacts.js";
import type { BrowserScenario } from "../domain/browserScenario.js";

type EventName =
  | "console"
  | "page-errors"
  | "network"
  | "websockets"
  | "frames"
  | "workers"
  | "popups"
  | "downloads";

type UnindexedEvent = BrowserScenarioEvent extends infer Event
  ? Event extends BrowserScenarioEvent
    ? Omit<Event, "sequence" | "step_index">
    : never
  : never;

type LimitedSection = "frames" | "workers" | "popups" | "websockets";
type TruncatedSection = "events" | LimitedSection;

interface EventCaptureOptions {
  readonly page: Page;
  readonly enabled: ReadonlySet<EventName>;
  readonly limits: Pick<
    BrowserScenario["limits"],
    | "max_events"
    | "max_frames"
    | "max_workers"
    | "max_popups"
    | "max_websockets"
  >;
  readonly secrets: BrowserScenarioSecrets;
  readonly budget: BrowserScenarioCaptureBudget;
}

/** Bounded, arrival-ordered Playwright event capture with current-step attribution. */
export class PlaywrightScenarioEvents {
  private readonly items: BrowserScenarioEvent[] = [];
  private readonly truncated = new Set<TruncatedSection>();
  private readonly admitted = {
    frames: new WeakSet<object>(),
    workers: new WeakSet<object>(),
    popups: new WeakSet<object>(),
    websockets: new WeakSet<object>(),
  };
  private readonly rejected = {
    frames: new WeakSet<object>(),
    workers: new WeakSet<object>(),
    popups: new WeakSet<object>(),
    websockets: new WeakSet<object>(),
  };
  private readonly counts: Record<LimitedSection, number> = {
    frames: 0,
    workers: 0,
    popups: 0,
    websockets: 0,
  };
  private dropped = 0;
  private stepIndex = 0;
  private sequence = 0;
  private readonly enabled: ReadonlySet<EventName>;
  private readonly limits: EventCaptureOptions["limits"];
  private readonly secrets: BrowserScenarioSecrets;
  private readonly budget: BrowserScenarioCaptureBudget;

  constructor(options: EventCaptureOptions) {
    this.enabled = options.enabled;
    this.limits = options.limits;
    this.secrets = options.secrets;
    this.budget = options.budget;
    this.observePage(options.page);
  }

  setStep(index: number): void {
    this.stepIndex = index;
  }

  nextSequence(): number {
    return this.sequence + 1;
  }

  lastSequence(): number {
    return this.sequence;
  }

  result(): {
    readonly retained: number;
    readonly dropped: number;
    readonly items: readonly BrowserScenarioEvent[];
  } {
    return {
      retained: this.items.length,
      dropped: this.dropped,
      items: this.items,
    };
  }

  truncationSections(): readonly TruncatedSection[] {
    return [...this.truncated].sort();
  }

  private push(event: UnindexedEvent): void {
    this.sequence += 1;
    if (this.items.length >= this.limits.max_events) {
      this.dropped += 1;
      this.truncated.add("events");
      return;
    }
    const parsed = browserScenarioEventSchema.parse({
      ...event,
      sequence: this.sequence,
      step_index: this.stepIndex,
    });
    if (!this.budget.claimMetadata(Buffer.byteLength(JSON.stringify(parsed)))) {
      this.dropped += 1;
      this.truncated.add("events");
      return;
    }
    this.items.push(parsed);
  }

  private admit(
    section: LimitedSection,
    value: object,
    maximum: number,
  ): boolean {
    if (this.admitted[section].has(value)) return true;
    if (this.rejected[section].has(value)) return false;
    if (this.counts[section] >= maximum) {
      this.rejected[section].add(value);
      this.sequence += 1;
      this.dropped += 1;
      this.truncated.add("events");
      this.truncated.add(section);
      return false;
    }
    this.admitted[section].add(value);
    this.counts[section] += 1;
    return true;
  }

  private observePage(page: Page): void {
    if (this.enabled.has("console"))
      page.on("console", (message) => this.console(message));
    if (this.enabled.has("page-errors"))
      page.on("pageerror", (error) =>
        this.push({
          kind: "page-error",
          message: this.secrets.redact(error.message).slice(0, 65_536),
          stack:
            error.stack === undefined
              ? null
              : this.secrets.redact(error.stack).slice(0, 262_144),
        }),
      );
    if (this.enabled.has("network")) {
      page.on("request", (request) => this.request("request", request));
      page.on("response", (response) => this.response(response));
      page.on("requestfailed", (request) =>
        this.request("request-failed", request),
      );
    }
    if (this.enabled.has("websockets"))
      page.on("websocket", (socket) => this.webSocket(socket));
    if (this.enabled.has("frames")) {
      page.on("frameattached", (frame) => this.frame("frame-attached", frame));
      page.on("framedetached", (frame) => this.frame("frame-detached", frame));
      page.on("framenavigated", (frame) =>
        this.frame("frame-navigated", frame),
      );
    }
    if (this.enabled.has("workers"))
      page.on("worker", (worker) => this.worker(worker));
    if (this.enabled.has("popups"))
      page.on("popup", (popup) => this.popup(popup));
    if (this.enabled.has("downloads"))
      page.on("download", (download) => this.download(download));
  }

  private console(message: ConsoleMessage): void {
    const location = message.location();
    this.push({
      kind: "console",
      level: message.type(),
      text: this.secrets.redact(message.text()).slice(0, 65_536),
      url: location.url === "" ? null : sanitizeBrowserUrl(location.url),
    });
  }

  private request(kind: "request" | "request-failed", request: Request): void {
    this.push({
      kind,
      method: request.method(),
      url: sanitizeBrowserUrl(request.url()),
      resource_type: request.resourceType(),
      status: null,
      header_names: Object.keys(request.headers()).sort().slice(0, 256),
      failure:
        kind === "request-failed"
          ? (request.failure()?.errorText ?? "unknown")
          : null,
    });
  }

  private response(response: Response): void {
    const request = response.request();
    this.push({
      kind: "response",
      method: request.method(),
      url: sanitizeBrowserUrl(response.url()),
      resource_type: request.resourceType(),
      status: response.status(),
      header_names: Object.keys(response.headers()).sort().slice(0, 256),
      failure: null,
    });
  }

  private webSocket(socket: WebSocket): void {
    if (!this.admit("websockets", socket, this.limits.max_websockets)) return;
    const url = sanitizeBrowserUrl(socket.url());
    this.push({ kind: "websocket-opened", url });
    socket.on("framesent", ({ payload }) =>
      this.webSocketFrame("websocket-frame-sent", url, payload),
    );
    socket.on("framereceived", ({ payload }) =>
      this.webSocketFrame("websocket-frame-received", url, payload),
    );
    socket.on("close", () => this.push({ kind: "websocket-closed", url }));
  }

  private webSocketFrame(
    kind: "websocket-frame-sent" | "websocket-frame-received",
    url: ReturnType<typeof sanitizeBrowserUrl>,
    payload: string | Buffer,
  ): void {
    const bytes = Buffer.byteLength(payload);
    const isText = typeof payload === "string";
    const text = isText ? this.secrets.redact(payload).slice(0, 65_536) : null;
    this.push({
      kind,
      url,
      payload_type: isText ? "text" : "binary",
      payload_bytes: bytes,
      payload_text: text,
      truncated: isText && text !== null && text.length < payload.length,
    });
  }

  private frame(
    kind: "frame-attached" | "frame-detached" | "frame-navigated",
    frame: Frame,
  ): void {
    if (!this.admit("frames", frame, this.limits.max_frames)) return;
    this.push({
      kind,
      url: frame.url() === "" ? null : sanitizeBrowserUrl(frame.url()),
      name: frame.name() || null,
    });
  }

  private worker(worker: Worker): void {
    if (!this.admit("workers", worker, this.limits.max_workers)) return;
    const details = {
      url: sanitizeBrowserUrl(worker.url()),
      name: null,
    };
    this.push({ kind: "worker-created", ...details });
    worker.on("close", () => this.push({ kind: "worker-closed", ...details }));
  }

  private popup(page: Page): void {
    if (!this.admit("popups", page, this.limits.max_popups)) return;
    const opened = {
      url: page.url() === "" ? null : sanitizeBrowserUrl(page.url()),
      name: null,
    };
    this.push({ kind: "popup-opened", ...opened });
    page.on("close", () =>
      this.push({
        kind: "popup-closed",
        url: page.url() === "" ? null : sanitizeBrowserUrl(page.url()),
        name: null,
      }),
    );
    this.observePage(page);
  }

  private download(download: Download): void {
    this.push({
      kind: "download-cancelled",
      suggested_filename: download.suggestedFilename().slice(0, 1_024),
      url: sanitizeBrowserUrl(download.url()),
    });
    void download.cancel().catch(() => undefined);
  }
}
