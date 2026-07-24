import type {
  BrowserScenario,
  BrowserScenarioAction,
} from "../domain/browserScenario.js";
import type {
  BrowserScenarioEvent,
  BrowserStepArtifacts,
} from "../domain/browserScenarioCapture.js";
import type { BrowserScenarioCaptureBudget } from "./PlaywrightScenarioArtifacts.js";

type SnapshotKind = BrowserScenario["capture"]["after_each_step"][number];

export interface BrowserScenarioSessionPort {
  readonly mode: "launch" | "connect";
  readonly processOwnership: "provider-owned" | "external";
  readonly product: string;
  readonly version: string;
  readonly initialUrl: string;
  currentUrl(): string;
  setStep(index: number): void;
  nextEventSequence(): number;
  lastEventSequence(): number;
  events(): {
    readonly retained: number;
    readonly dropped: number;
    readonly items: readonly BrowserScenarioEvent[];
  };
  eventTruncationSections(): readonly (
    | "events"
    | "frames"
    | "workers"
    | "popups"
    | "websockets"
  )[];
  perform(
    action: BrowserScenarioAction,
    maximumTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  capture(
    requested: ReadonlySet<SnapshotKind>,
    budget: BrowserScenarioCaptureBudget,
    maximumTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BrowserStepArtifacts>;
  close(): Promise<"terminated-owned-process" | "disconnected-external">;
  redactError(error: unknown): string;
}

export interface BrowserScenarioSessionFactory {
  open(
    scenario: BrowserScenario,
    options?: {
      readonly signal?: AbortSignal;
      readonly budget?: BrowserScenarioCaptureBudget;
      readonly deadlineAt?: number;
    },
  ): Promise<BrowserScenarioSessionPort>;
}
