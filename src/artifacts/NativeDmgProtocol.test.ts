import { build } from "plist";
import { expect, it } from "vitest";
import {
  NativeDmgArtifactReader,
  type NativeDmgHost,
} from "./NativeDmgArtifactReader.js";
import { translateArtifactFailure } from "./ArtifactOperationFailure.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

it("retains malformed successful hdiutil inventory output as a typed producer parse failure before attach", async () => {
  const calls: string[] = [];
  const host: NativeDmgHost = {
    run: async (args) => {
      calls.push(args[0] ?? "");
      if (args[0] === "verify") return { stdout: "", exitCode: 0 };
      if (args[0] === "info")
        return { stdout: build({ images: "not an array" }), exitCode: 0 };
      throw new Error("Unexpected command");
    },
  };
  const reader = new NativeDmgArtifactReader("/fixture/image.dmg", {}, host);
  let failure: unknown;
  try {
    for await (const _entry of reader.entries()) {
      /* consume */
    }
  } catch (cause: unknown) {
    failure = cause;
  } finally {
    await reader.close();
  }
  expect(calls).toEqual(["verify", "info"]);
  expect(failure).toMatchObject({
    reason: "format",
    message: "hdiutil info -plist returned malformed image inventory",
    cause: { name: "ZodError" },
  });
  expect(
    projectAnalysisError(translateArtifactFailure("inspect_artifact", failure)),
  ).toMatchObject({
    details: {
      reason: "format",
      detail: "hdiutil info -plist returned malformed image inventory",
    },
  });
});
