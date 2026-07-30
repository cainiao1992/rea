import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

describe("tool registration options", () => {
  it("reuses finalized advertised schemas", () => {
    const contract = TOOL_CONTRACTS[0];
    expect(contract).toBeDefined();
    if (contract === undefined) return;

    const first = toolRegistrationOptions(contract);
    const second = toolRegistrationOptions(contract);
    expect(first.inputSchema["~standard"].jsonSchema.input()).toBe(
      second.inputSchema["~standard"].jsonSchema.output(),
    );
    expect(first.outputSchema["~standard"].jsonSchema.input()).toBe(
      second.outputSchema["~standard"].jsonSchema.output(),
    );
  });

  it("gives fallback parameter guidance operational meaning", () => {
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "analyze_function",
    );
    expect(contract).toBeDefined();
    if (contract === undefined) return;

    const advertisedSchema =
      toolRegistrationOptions(contract).inputSchema[
        "~standard"
      ].jsonSchema.input();
    const properties = Object.fromEntries(
      Object.entries(advertisedSchema.properties ?? {}),
    );
    expect(properties.include_assembly).toMatchObject({
      description: "Whether to include assembly in the result.",
    });
    expect(properties.max_instructions).toMatchObject({
      description: "Maximum permitted instructions for this operation.",
    });
    expect(properties.pseudocode_offset).toMatchObject({
      description: "Zero-based index of the first pseudocode to return.",
    });
  });

  it("advertises validated contract examples on the MCP input schema", () => {
    for (const name of [
      "record_unknown",
      "run_replay_machine",
      "build_reconstruction_obligation_ledger",
    ]) {
      const contract = TOOL_CONTRACTS.find(
        (candidate) => candidate.name === name,
      );
      expect(contract).toBeDefined();
      if (contract === undefined) continue;

      const schema =
        toolRegistrationOptions(contract).inputSchema[
          "~standard"
        ].jsonSchema.input();
      expect(schema.examples).toEqual(
        contract.examples.map(({ input }) => input),
      );
    }
  });
});
