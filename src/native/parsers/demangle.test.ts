import { describe, expect, it } from "vitest";

import { parseDemangledSymbols } from "./demangle.js";
import { swiftSymbolsSchema } from "../../contracts/native/nativeToolContracts.js";

describe("parseDemangledSymbols", () => {
  it("returns an empty array when given an empty input list", () => {
    expect(swiftSymbolsSchema.safeParse([]).success).toBe(true);
    expect(parseDemangledSymbols([], "")).toEqual([]);
    expect(parseDemangledSymbols([], "\n")).toEqual([]);
  });

  it("rejects demangler output when the input batch is empty", () => {
    expect(() => parseDemangledSymbols([], "unexpected\n")).toThrow(
      "swift-demangle emitted output for an empty input",
    );
  });

  it("parses demangled symbols successfully", () => {
    const inputs = ["$s4main4testyyF"];
    const output = "main.test() -> ()\n";
    expect(parseDemangledSymbols(inputs, output)).toEqual([
      {
        input: "$s4main4testyyF",
        output: "main.test() -> ()",
        status: "demangled",
      },
    ]);
  });

  it("identifies unchanged non-Swift symbols", () => {
    const inputs = ["_printf"];
    const output = "_printf\n";
    expect(parseDemangledSymbols(inputs, output)).toEqual([
      {
        input: "_printf",
        output: "_printf",
        status: "unchanged",
      },
    ]);
  });

  it("identifies invalid Swift symbols that fail demangling", () => {
    const inputs = ["$sInvalidMangle", "_$sAlsoInvalid"];
    const output = "$sInvalidMangle\n_$sAlsoInvalid\n";
    expect(parseDemangledSymbols(inputs, output)).toEqual([
      {
        input: "$sInvalidMangle",
        output: "$sInvalidMangle",
        status: "invalid",
      },
      {
        input: "_$sAlsoInvalid",
        output: "_$sAlsoInvalid",
        status: "invalid",
      },
    ]);
  });

  it("parses mixed batches preserving ordering", () => {
    const inputs = ["$s4main4testyyF", "_printf", "$sInvalidMangle"];
    const output = "main.test() -> ()\n_printf\n$sInvalidMangle\n";
    expect(parseDemangledSymbols(inputs, output)).toEqual([
      {
        input: "$s4main4testyyF",
        output: "main.test() -> ()",
        status: "demangled",
      },
      {
        input: "_printf",
        output: "_printf",
        status: "unchanged",
      },
      {
        input: "$sInvalidMangle",
        output: "$sInvalidMangle",
        status: "invalid",
      },
    ]);
  });

  it("throws TypeError when output count does not match input count", () => {
    expect(() =>
      parseDemangledSymbols(["sym1", "sym2"], "demangled1\n"),
    ).toThrow(TypeError);
    expect(() =>
      parseDemangledSymbols(["sym1"], "demangled1\ndemangled2\n"),
    ).toThrow("swift-demangle output count does not match input");
  });
});
