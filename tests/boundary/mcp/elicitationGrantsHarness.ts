import { realpathSync } from "node:fs";
import { PermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import { createPermissionPolicy } from "../../../src/domain/permissionPolicy.js";
import type { ProcessCaptureElicitationState } from "../../../src/server/ProcessCaptureElicitation.js";

export const request = {
  capability: "process_capture" as const,
  roots: [realpathSync("/tmp")],
  executables: [process.execPath],
  environment_names: ["PATH"],
  network: "external" as const,
  mount: false,
  operation_identity: "capture:test",
};
export const now = Date.parse("2026-07-18T00:00:00.000Z");
export const ceilingOnlyAuthority = (
  origins?: readonly string[],
): PermissionAuthority =>
  new PermissionAuthority(
    createPermissionPolicy([
      {
        capability: "process_capture",
        roots: request.roots,
        executables: request.executables,
        environment_names: request.environment_names,
        ...(origins === undefined ? {} : { origins }),
        network: request.network,
        mount: request.mount,
      },
    ]),
  );
export const requestContext = (
  state?: ProcessCaptureElicitationState,
  response?: Record<string, unknown>,
) => ({
  mcpReq: {
    requestState: () => state,
    ...(response === undefined
      ? {}
      : { inputResponses: { process_capture_grant: response } }),
  },
});
export const verifiedState = (
  state: ProcessCaptureElicitationState | undefined,
): Promise<ProcessCaptureElicitationState> => {
  if (state === undefined) throw new Error("state was not minted");
  return Promise.resolve(state);
};
