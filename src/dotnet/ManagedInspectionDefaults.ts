/** Internal parser and artifact-admission safeguards for managed PE inspection. */
export const MANAGED_INSPECTION_DEFAULTS = Object.freeze({
  maxFileBytes: 268_435_456,
  maxMetadataBytes: 67_108_864,
  maxTableRows: 100_000,
  maxHeapItemBytes: 1_048_576,
  maxMethodBodyBytes: 1_048_576,
  maxMethodInstructions: 10_000,
});
