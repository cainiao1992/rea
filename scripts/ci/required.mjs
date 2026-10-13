import { CI_FLAGS } from "./scopes.mjs";
import { recordQualification } from "./qualification.mjs";

const jobs = JSON.parse(process.env.CI_JOBS);
const outputs = jobs.changes.outputs;
const reused = outputs.tier === "reused";
if (
  reused &&
  (process.env.GITHUB_EVENT_NAME !== "schedule" ||
    !/^[1-9]\d*$/.test(outputs.qualification_run_id ?? "") ||
    !Number.isSafeInteger(Number(outputs.qualification_run_id)) ||
    CI_FLAGS.some((flag) => outputs[flag] !== "false"))
)
  throw new Error(
    "Reused qualification requires a scheduled admission receipt and no selected lanes",
  );
if (
  outputs.tier === "full" &&
  CI_FLAGS.some((flag) => outputs[flag] !== "true")
)
  throw new Error("Full qualification requires every canonical CI scope");
const required = reused ? ["changes"] : ["changes", "static", "test"];
const lanes = {
  code: ["build", "test-shard"],
  runtime: ["windows-native-build", "package-e2e"],
  package: ["windows-curated"],
  sqlite: ["sqlite-runtime"],
  apple: ["apple-artifacts"],
  fixtures: ["conformance-fixtures"],
  readiness: ["reconstruction-readiness"],
  docs: ["docs"],
  workflows: ["static"],
};
for (const [scope, value] of Object.entries(outputs)) {
  if (value === "true") required.push(...(lanes[scope] ?? [scope]));
}
const failed = [...new Set(required)].filter(
  (name) => jobs[name]?.result !== "success",
);
for (const [name, job] of Object.entries(jobs)) {
  if (["failure", "cancelled"].includes(job.result) && !failed.includes(name))
    failed.push(name);
}
if (failed.length)
  throw new Error(`CI lanes did not pass: ${failed.join(", ")}`);
console.log("Every selected CI lane passed");
if (reused)
  console.log(
    `Qualification reused from run ${outputs.qualification_run_id}; no fresh provider observation`,
  );
if (outputs.tier === "full" && process.env.CI_QUALIFICATION_DIRECTORY)
  recordQualification(process.env.CI_QUALIFICATION_DIRECTORY);
