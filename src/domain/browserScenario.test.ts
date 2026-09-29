import { expect, it } from "vitest";

import { browserScenarioSchema } from "./browserScenario.js";

it("accepts scenarios beyond former action, secret, storage, and replay-route counts", () => {
  const actions = Array.from({ length: 129 }, (_, index) => ({
    step_id: `fill_${index}`,
    action: "fill",
    locator: { kind: "css", selector: "#field" },
    value: { source: "secret", secret_id: `secret_${index}` },
  }));
  const secrets = Array.from({ length: actions.length }, (_, index) => ({
    secret_id: `secret_${index}`,
    environment_variable: `SECRET_${index}`,
    purpose: "input",
    redaction: "replace-with-secret-reference",
  }));
  const cookies = Array.from({ length: 129 }, (_, index) => ({
    name: `cookie_${index}`,
    value: { source: "literal", value: "value", classification: "public" },
    destination: { url: "https://app.example.test/" },
    http_only: false,
    secure: true,
    same_site: "Lax",
  }));
  const storageEntries = Array.from({ length: 129 }, (_, index) => ({
    name: `entry_${index}`,
    value: { source: "literal", value: "value", classification: "public" },
  }));
  const routes = Array.from({ length: 257 }, (_, index) => ({
    route_id: `route_${index}`,
    method: "GET",
    request: { url: `https://app.example.test/${index}` },
    response: { kind: "response", status: 200 },
  }));

  const result = browserScenarioSchema.parse({
    browser: {
      mode: "launch",
      executable_path: "/opt/chromium",
      headless: true,
      user_data: "temporary-owned",
      cleanup: "close-and-delete-profile",
    },
    start_url: { url: "https://app.example.test/" },
    allowed_origins: ["https://app.example.test"],
    actions,
    secrets,
    storage: {
      cookies,
      local_storage: [
        { origin: "https://app.example.test", entries: storageEntries },
      ],
      session_storage: [
        { origin: "https://app.example.test", entries: storageEntries },
      ],
    },
    request_replay: {
      mode: "exact",
      unmatched: "abort",
      routes,
    },
  });

  expect(result.actions).toHaveLength(129);
  expect(result.secrets).toHaveLength(129);
  expect(result.storage.cookies).toHaveLength(129);
  expect(result.storage.local_storage[0]?.entries).toHaveLength(129);
  expect(result.storage.session_storage[0]?.entries).toHaveLength(129);
  expect(
    result.request_replay.mode === "exact" && result.request_replay.routes,
  ).toHaveLength(257);
});
