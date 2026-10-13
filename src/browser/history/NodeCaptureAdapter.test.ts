import { expect, it, vi } from "vitest";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { NodeCaptureAdapter } from "./NodeCaptureAdapter.js";

vi.mock("./CaptureRelease.js", async (original) => ({
  ...(await original<typeof import("./CaptureRelease.js")>()),
  NODE_CAPTURE_HEAP_ENFORCED: false,
  NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES: null,
}));

it("refuses a SAZ worker when the runtime has no enforceable memory bound", async () => {
  await expect(
    new NodeCaptureAdapter("saz").command("/owned/request.json"),
  ).rejects.toBeInstanceOf(AnalysisCapabilityUnavailableError);
});
