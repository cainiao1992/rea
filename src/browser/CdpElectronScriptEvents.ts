import type { CdpEvent } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  numberValue,
  recordValue,
  scriptMetadataValues,
  cdpStringValue,
} from "./CdpCaptureValues.js";

export interface ElectronScriptDraft {
  readonly scriptId: string;
  readonly rawUrl: string;
  readonly hash: string | null;
  readonly length: number | null;
  readonly isModule: boolean | null;
  readonly language: string | null;
  readonly frameId: string | null;
  readonly hasSourceUrl: boolean | null;
}

/** Frame identity is retained separately from the document generation's admission. */
export type ElectronScriptFrameScope =
  | { readonly state: "authorized"; readonly frameId: string }
  | { readonly state: "excluded" }
  | { readonly state: "unknown"; readonly frameId: string | null };

/** Retain script/frame metadata from passive Electron events. */
export const ingestElectronScriptEvent = (input: {
  readonly event: CdpEvent;
  readonly scripts: ElectronScriptDraft[];
  readonly executionContextFrames: Map<string, string>;
  readonly completeness: CdpCaptureCompleteness;
}): void => {
  if (input.event.method === "Runtime.executionContextsCleared") {
    input.executionContextFrames.clear();
    return;
  }
  if (input.event.method === "Runtime.executionContextDestroyed") {
    const parameters = recordValue(input.event.params);
    const key = executionContextKey(parameters?.executionContextId);
    if (key !== null) input.executionContextFrames.delete(key);
    return;
  }
  if (input.event.method === "Runtime.executionContextCreated") {
    retainExecutionContext(input.event, input.executionContextFrames);
    return;
  }
  if (input.event.method !== "Debugger.scriptParsed") return;
  const value = recordValue(input.event.params);
  const scriptId = cdpStringValue(value?.scriptId);
  const rawUrl = cdpStringValue(value?.url);
  if (scriptId === undefined) {
    input.completeness.exclude("scripts", "invalid_protocol_value");
    return;
  }
  if (rawUrl === undefined || rawUrl === "") {
    input.completeness.exclude("scripts", "unattributed_origin");
    return;
  }
  const contextKey = executionContextKey(value?.executionContextId);
  const contextFrame =
    contextKey === null
      ? undefined
      : input.executionContextFrames.get(contextKey);
  const auxiliary = recordValue(value?.executionContextAuxData);
  const reportedFrame = cdpStringValue(auxiliary?.frameId);
  const declaredFrame = reportedFrame === "" ? undefined : reportedFrame;
  const conflictingFrame =
    declaredFrame !== undefined &&
    contextFrame !== undefined &&
    declaredFrame !== contextFrame;
  if (
    conflictingFrame ||
    (value?.executionContextAuxData !== undefined && auxiliary === undefined) ||
    (auxiliary !== undefined &&
      Object.hasOwn(auxiliary, "frameId") &&
      declaredFrame === undefined) ||
    (value?.hasSourceURL !== undefined &&
      typeof value.hasSourceURL !== "boolean")
  )
    input.completeness.exclude("scripts", "invalid_protocol_value");
  input.scripts.push({
    scriptId,
    rawUrl,
    ...scriptMetadataValues(value),
    frameId: conflictingFrame ? null : (declaredFrame ?? contextFrame ?? null),
    hasSourceUrl:
      typeof value?.hasSourceURL === "boolean" ? value.hasSourceURL : null,
  });
};

const retainExecutionContext = (
  event: CdpEvent,
  frames: Map<string, string>,
): void => {
  const parameters = recordValue(event.params);
  const runtimeContext = recordValue(parameters?.context);
  const contextKey = executionContextKey(runtimeContext?.id);
  const frameId = cdpStringValue(recordValue(runtimeContext?.auxData)?.frameId);
  if (contextKey === null || frameId === undefined || frameId === "") return;
  frames.set(contextKey, frameId);
};

const executionContextKey = (value: unknown): string | null => {
  const identifier = numberValue(value);
  return identifier !== undefined && Number.isSafeInteger(identifier)
    ? String(identifier)
    : null;
};
