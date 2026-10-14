/** Validate a live registration and its byte-identical pre-setup backup. */
export function assertClientConfig(
  cli: string,
  configPath: string,
  original: Uint8Array,
): Promise<void>;
