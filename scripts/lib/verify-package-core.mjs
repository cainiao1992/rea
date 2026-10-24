import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";

/**
 * `mcp-verifier-results.mjs` reaches into `dist/` at module load, so eager
 * importing it propagates that build dependency to every consumer in this
 * file. `verifyCompleteToolCatalog` is the only consumer, so we lazy-load
 * the module there and keep the remaining helpers (`exec`, `json`,
 * `pathExists`) usable from `test:fast` callers that only need `dist/`-free
 * utilities — see docs/testing.md § test scripts, which promises `test:fast`
 * runs "without build".
 */
const loadMcpVerifierResults = () => import("./mcp-verifier-results.mjs");

/** Native-client commands expose the live child handle for caller-owned stdin. */
export const exec = promisify(execFile);

/** Parse JSON from a command output string. */
export const json = (text) => JSON.parse(text);

/** Verify schema validity and that the MCP catalog matches session metadata. */
export const verifyCompleteToolCatalog = async (client, options) => {
  const { requireMcpLifecycleResult, sortVerifierNames } =
    await loadMcpVerifierResults();
  const listed = await client.listTools(undefined, options);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const tool of listed.tools) {
    for (const kind of ["inputSchema", "outputSchema"]) {
      const schema = tool[kind];
      if (schema !== undefined && !ajv.validateSchema(schema))
        throw new Error(
          `packaged MCP has invalid ${tool.name}.${kind}: ${ajv.errorsText(ajv.errors)}`,
        );
    }
  }
  const status = await client.callTool(
    { name: "binary_session", arguments: {} },
    options,
  );
  const expanded = requireMcpLifecycleResult(status, "binary_session");
  const availability = expanded.tool_availability;
  const expected = sortVerifierNames(availability.map(({ name }) => name));
  const observed = sortVerifierNames(listed.tools.map(({ name }) => name));
  if (JSON.stringify(observed) !== JSON.stringify(expected))
    throw new Error(
      "packaged MCP tool inventory diverged from session metadata",
    );
  return observed;
};

/** Check whether a path exists on disk. */
export const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
};
