import { openRegularFile } from "../filesystem/RegularFile.js";

/** Admit a regular file without waiting for a pipe, then read its verified handle. */
export const readRegularFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const handle = await openRegularFile(path, { symlinks: "follow", signal });
  try {
    const bytes = await handle.readFile({ signal });
    signal?.throwIfAborted();
    return bytes;
  } finally {
    await handle.close();
  }
};
