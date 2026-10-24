import { readFile } from "node:fs/promises";

import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import {
  agentEvaluationPassed,
  summarizeFactualCorrectness,
} from "./AgentEvaluationReport.js";

const routingSuccess = {
  exitCode: 0,
  naturalUse: true,
  correctFirstTool: true,
  repeatedCallCount: 0,
  inputValidationFailureCount: 0,
  requiredToolSubsequenceMet: true,
  inputTokens: 100,
  answerHeuristicsMet: true,
  epistemicCuePresent: true,
};

describe("agent evaluation release gate", () => {
  it("rejects incorrect fixture claims even when every text heuristic passes", async () => {
    const predicate = await runnerFailurePredicate();
    expect(predicate({ ...routingSuccess, factualCorrectness: "passed" })).toBe(
      false,
    );
    expect(
      predicate({
        exitCode: 0,
        naturalUse: true,
        correctFirstTool: true,
        repeatedCallCount: 0,
        inputValidationFailureCount: 0,
        requiredToolSubsequenceMet: true,
        inputTokens: 100,
        answerHeuristicsMet: true,
        epistemicCuePresent: true,
        factualCorrectness: "failed",
      }),
    ).toBe(true);
  });

  it("selects the results gate inside cleanup without using an unrelated filter", async () => {
    const predicate = await runnerFailurePredicate(`
      const failed = unrelated.filter(() => true);
      await withVerifierCleanup(async () => {
        const failed = results.filter(item => !agentEvaluationPassed(item));
      });
    `);
    expect(predicate({ ...routingSuccess, factualCorrectness: "passed" })).toBe(
      false,
    );
    expect(predicate({ ...routingSuccess, factualCorrectness: "failed" })).toBe(
      true,
    );
  });

  it("rejects a missing results failure gate", async () => {
    await expect(
      runnerFailurePredicate("const failed = unrelated.filter(() => false);"),
    ).rejects.toThrow("Expected one runner failure gate, found 0");
  });

  it("rejects ambiguous results failure gates", async () => {
    await expect(
      runnerFailurePredicate(`
        function first() { const failed = results.filter(item => !agentEvaluationPassed(item)); }
        function second() { const failed = results.filter(() => true); }
      `),
    ).rejects.toThrow("Expected one runner failure gate, found 2");
  });
});

async function runnerFailurePredicate(
  providedSource?: string,
): Promise<(item: unknown) => unknown> {
  const source =
    providedSource ??
    (await readFile("scripts/verify-agent-experience.mjs", "utf8"));
  const program = parse(source, { sourceType: "module" }).program;
  const predicates: { readonly start: number; readonly end: number }[] = [];
  t.traverseFast(program, (node) => {
    if (
      !t.isVariableDeclarator(node) ||
      !t.isIdentifier(node.id, { name: "failed" })
    )
      return;
    const initializer = node.init;
    if (
      !t.isCallExpression(initializer) ||
      !t.isMemberExpression(initializer.callee) ||
      initializer.callee.computed ||
      !t.isIdentifier(initializer.callee.object, { name: "results" }) ||
      !t.isIdentifier(initializer.callee.property, { name: "filter" })
    )
      return;
    const argument = initializer.arguments[0];
    if (
      t.isArrowFunctionExpression(argument) &&
      typeof argument.start === "number" &&
      typeof argument.end === "number"
    )
      predicates.push({ start: argument.start, end: argument.end });
  });
  const [predicate] = predicates;
  if (predicates.length !== 1 || predicate === undefined)
    throw new Error(
      `Expected one runner failure gate, found ${predicates.length}`,
    );
  const factory = new Function(
    "agentEvaluationPassed",
    `return (${source.slice(predicate.start, predicate.end)});`,
  );
  const result: unknown = factory(agentEvaluationPassed);
  if (typeof result !== "function")
    throw new Error("Runner gate is not callable");
  return (item) => result(item);
}

describe("scoped factual report", () => {
  it("requires a validated target clarification and zero REA calls for the negative route", () => {
    const clarification = {
      ...routingSuccess,
      expectedFirstTool: null,
      naturalUse: false,
      factualCorrectness: "not_assessed" as const,
      answerHeuristicsMet: false,
      epistemicCuePresent: false,
      targetClarificationPassed: true,
    };
    expect(agentEvaluationPassed(clarification)).toBe(true);
    for (const change of [
      { naturalUse: true },
      { correctFirstTool: false },
      { targetClarificationPassed: false },
      { exitCode: 1 },
      { inputTokens: 0 },
    ])
      expect(agentEvaluationPassed({ ...clarification, ...change })).toBe(
        false,
      );
  });

  it("accepts correct structured facts without superficial prose cues", () => {
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        answerHeuristicsMet: false,
        epistemicCuePresent: false,
        factualCorrectness: "passed",
      }),
    ).toBe(true);
  });

  it("retains workflow and execution checks for factually correct answers", () => {
    for (const change of [
      { exitCode: 1 },
      { naturalUse: false },
      { correctFirstTool: false },
      { repeatedCallCount: 1 },
      { inputValidationFailureCount: 1 },
      { requiredToolSubsequenceMet: false },
      { inputTokens: 0 },
    ])
      expect(
        agentEvaluationPassed({
          ...routingSuccess,
          factualCorrectness: "passed",
          ...change,
        }),
      ).toBe(false);
  });

  it("retains heuristic checks only for unassessed scenarios", () => {
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
      }),
    ).toBe(true);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
        answerHeuristicsMet: false,
      }),
    ).toBe(false);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
        epistemicCuePresent: false,
      }),
    ).toBe(false);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "failed",
      }),
    ).toBe(false);
  });

  it("reports assessed failures separately from unassessed scenarios", () => {
    expect(
      summarizeFactualCorrectness([
        { factualCorrectness: "passed" },
        { factualCorrectness: "failed" },
        { factualCorrectness: "not_assessed" },
      ]),
    ).toEqual({
      status: "failed",
      scope: "configured_fixture_claims",
      counts: { assessed: 2, passed: 1, failed: 1, notAssessed: 1 },
    });
    expect(
      summarizeFactualCorrectness([
        { factualCorrectness: "passed" },
        { factualCorrectness: "not_assessed" },
      ]).status,
    ).toBe("passed");
    expect(
      summarizeFactualCorrectness([{ factualCorrectness: "not_assessed" }])
        .status,
    ).toBe("not_assessed");
    expect(summarizeFactualCorrectness([]).status).toBe("not_assessed");
  });
});
