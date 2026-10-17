#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";

const bootstrap = readFileSync(
  process.argv[process.argv.indexOf("-Y") + 1],
  "utf8",
);
const value = (name) => {
  const line = bootstrap
    .split("\n")
    .find((line) => line.startsWith(`${name} = `));
  if (line === undefined)
    throw new Error(`Missing fixture bootstrap field ${name}`);
  return JSON.parse(line.slice(name.length + 3));
};
const token = value("REA_TOKEN"),
  runId = value("REA_RUN_ID");
const server = createServer((socket) => {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const request = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (request.token !== token)
        throw new Error("Fixture authentication failed");
      appendFileSync(process.env.REA_TEST_HOPPER_TRACE, `${request.method}\n`);
      let reply;
      if (request.method === "health")
        reply = {
          result: {
            name: "REA Hopper bridge",
            version: "1.0.0",
            run_id: runId,
            process_id: process.pid,
          },
        };
      else if (request.method === "shutdown_document") {
        reply = {
          result: {
            shutdown: true,
            analysis_stopped: true,
            document_closed: true,
          },
        };
        socket.once("close", () => server.close());
      } else if (
        request.method === "list_strings" ||
        request.method === "list_procedures"
      ) {
        reply =
          process.env.REA_TEST_HOPPER_REGEX_MODE === "valid"
            ? { result: [{ address: "0x1000", value: "fixture" }] }
            : {
                error: {
                  code: -32000,
                  message: "fixture inventory unavailable",
                  type: process.env.REA_TEST_HOPPER_REGEX_MODE,
                },
              };
      } else if (request.method === "current_document")
        reply = { result: "fixture" };
      else throw new Error(`Unexpected fixture operation ${request.method}`);
      socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
    }
  });
});
server.listen(value("REA_SOCKET"));
