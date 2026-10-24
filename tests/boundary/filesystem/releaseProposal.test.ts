import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { z } from "zod";

import {
  applyReleasePleasePatch,
  releaseProposalSearchDepth,
} from "../../../scripts/lib/release-proposal.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
let upstream: typeof import("release-please");
const baseline = "a".repeat(40);
const latest = "b".repeat(40);
const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
};

beforeAll(async () => {
  await applyReleasePleasePatch();
  upstream = await import("release-please");
});

function respond(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type CommitRecord = { sha: string; message: string; files: string[] };

function historyPage(
  commits: CommitRecord[],
  page: { num: number; cursor?: string | undefined },
  pullRequest: boolean,
) {
  const offset = Number(page.cursor ?? "0");
  const selected = commits.slice(offset, offset + page.num);
  return {
    data: {
      repository: {
        ref: {
          target: {
            history: {
              nodes: selected.map((commit) => ({
                sha: commit.sha,
                message: commit.message,
                associatedPullRequests: {
                  nodes:
                    pullRequest && commit.sha === latest
                      ? [
                          {
                            number: 42,
                            title: "Original title",
                            baseRefName: "main",
                            headRefName: "feature",
                            body: "BEGIN_COMMIT_OVERRIDE\nfix: attributed override (#42)\nEND_COMMIT_OVERRIDE",
                            mergeCommit: { oid: latest },
                            labels: { nodes: [{ name: "reviewed" }] },
                            files: {
                              nodes: [{ path: "src/feature.ts" }],
                              pageInfo: { hasNextPage: false },
                            },
                          },
                        ]
                      : [],
                },
              })),
              pageInfo: {
                hasNextPage: offset + selected.length < commits.length,
                endCursor: String(offset + selected.length),
              },
            },
          },
        },
      },
    },
  };
}

async function releaseFixture({
  config = {},
  commits = [
    { sha: latest, message: "fix: direct change", files: ["docs/changed.md"] },
    { sha: baseline, message: "chore: release 6.7.0", files: ["package.json"] },
  ],
  depth = 500,
  pullRequest = false,
}: {
  config?: Record<string, unknown>;
  commits?: CommitRecord[];
  depth?: number;
  pullRequest?: boolean;
} = {}) {
  const requests: { method: string; pathname: string }[] = [];
  const pages: { num: number; cursor?: string | undefined }[] = [];
  const configuration = {
    "release-type": "node",
    versioning: "always-bump-minor",
    "include-v-in-tag": false,
    packages: {
      ".": {
        "package-name": "rea-agents",
        "extra-files": [{ type: "generic", path: "version.txt" }],
      },
    },
    ...config,
  };
  const github = await upstream.GitHub.create({
    owner: "fixture",
    repo: "rea",
    defaultBranch: "main",
    logger: silent,
    fetch: async (
      input: string,
      options: { method?: string; body?: string },
    ) => {
      const url = new URL(input);
      requests.push({
        method: options.method ?? "GET",
        pathname: url.pathname,
      });
      if (url.pathname === "/repos/fixture/rea/tags") return respond([]);
      if (url.pathname === "/repos/fixture/rea/releases/generate-notes") {
        return respond({ body: "Generated release notes" });
      }
      if (url.pathname === "/graphql") {
        const query = z
          .object({
            query: z.string(),
            variables: z.object({
              num: z.number(),
              cursor: z.string().optional(),
            }),
          })
          .parse(JSON.parse(options.body ?? ""));
        if (query.query.includes("query releases(")) {
          return respond({
            data: {
              repository: {
                releases: {
                  nodes: [
                    {
                      name: "6.7.0",
                      tag: { name: "rea-agents-6.7.0" },
                      tagCommit: { oid: baseline },
                      description: "",
                      isDraft: false,
                      url: "https://github.com/fixture/rea/releases/tag/rea-agents-6.7.0",
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          });
        }
        if (!query.query.includes("query pullRequestsSince(")) {
          throw new Error(`Unexpected GraphQL operation: ${query.query}`);
        }
        pages.push(query.variables);
        return respond(historyPage(commits, query.variables, pullRequest));
      }
      const files: Record<string, unknown> = {
        "release-please-config.json": configuration,
        ".release-please-manifest.json": { ".": "6.7.0", pkg: "6.7.0" },
        "package.json": { name: "rea-agents", version: "6.7.0" },
        "pkg/package.json": { name: "rea-agents", version: "6.7.0" },
      };
      const entries = Object.entries(files).map(([path, value], index) => ({
        path,
        sha: (index + 1).toString(16).padStart(40, "0"),
        text: JSON.stringify(value),
      }));
      if (url.pathname === "/repos/fixture/rea/git/trees/main") {
        return respond({
          truncated: false,
          sha: baseline,
          tree: entries.map(({ path, sha, text }) => ({
            path,
            sha,
            type: "blob",
            mode: "100644",
            size: text.length,
          })),
        });
      }
      const blobPrefix = "/repos/fixture/rea/git/blobs/";
      if (url.pathname.startsWith(blobPrefix)) {
        const entry = entries.find(
          (item) => item.sha === url.pathname.slice(blobPrefix.length),
        );
        if (!entry) throw new Error("Unexpected blob read");
        return respond({
          content: Buffer.from(entry.text).toString("base64"),
          encoding: "base64",
          sha: entry.sha,
          size: entry.text.length,
        });
      }
      const commitPath = "/repos/fixture/rea/commits/";
      if (url.pathname.startsWith(commitPath)) {
        const commit = commits.find(
          (item) => item.sha === url.pathname.slice(commitPath.length),
        );
        if (!commit) throw new Error("Unexpected commit lookup");
        return respond({
          files: commit.files.map((filename) => ({ filename })),
        });
      }
      throw new Error(
        `Unexpected HTTP request: ${options.method} ${url.pathname}`,
      );
    },
  });
  const manifest = await upstream.Manifest.fromManifest(
    github,
    "main",
    undefined,
    undefined,
    {
      commitSearchDepth: depth,
      logger: silent,
    },
  );
  return { manifest, github, requests, pages };
}

it("builds the root Node proposal without commit-file lookups and retains extra-file updates", async () => {
  const fixture = await releaseFixture();
  const candidates = await fixture.manifest.buildPullRequests();
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.body.toString()).toContain("direct change");
  const version = candidates[0]?.updates.find(
    (update) => update.path === "version.txt",
  );
  expect(
    version?.updater.updateContent("6.7.0 // x-release-please-version"),
  ).toContain("6.8.0");
  expect(
    fixture.requests.filter((request) =>
      request.pathname.includes("/commits/"),
    ),
  ).toEqual([]);
  expect(fixture.pages.map((page) => page.num)).toEqual([10]);
  const commits = [];
  for await (const commit of fixture.github.mergeCommitIterator("main", {
    backfillFiles: false,
  }))
    commits.push(commit);
  expect(commits[0]?.files).toBeUndefined();
});

it("keeps real associated PR metadata, body overrides and attribution", async () => {
  const fixture = await releaseFixture({ pullRequest: true });
  const candidates = await fixture.manifest.buildPullRequests();
  const body = candidates[0]?.body.toString();
  expect(body).toContain("attributed override");
  expect(body).toContain("https://github.com/fixture/rea/issues/42");
  expect(body).not.toContain("direct change");
  const commits = [];
  for await (const commit of fixture.github.mergeCommitIterator("main", {
    backfillFiles: false,
  }))
    commits.push(commit);
  expect(commits[0]?.pullRequest).toMatchObject({
    number: 42,
    labels: ["reviewed"],
    mergeCommitOid: latest,
    body: expect.stringContaining("BEGIN_COMMIT_OVERRIDE"),
  });
});

it.each([
  {
    name: "inherited exclusion",
    config: { "exclude-paths": ["docs"] },
    excluded: true,
  },
  {
    name: "package exclusion",
    config: {
      packages: {
        ".": { "package-name": "rea-agents", "exclude-paths": ["docs"] },
      },
    },
    excluded: true,
  },
  {
    name: "explicit plugin",
    config: { plugins: ["sentence-case"] },
    excluded: false,
  },
  {
    name: "nondefault changelog",
    config: { "changelog-type": "github" },
    excluded: false,
  },
  {
    name: "other versioning strategy",
    config: { versioning: "always-bump-patch" },
    excluded: false,
  },
  {
    name: "subpackage",
    config: { packages: { pkg: { "package-name": "rea-agents" } } },
    excluded: true,
  },
])("retains file-backed semantics for $name", async ({ config, excluded }) => {
  const fixture = await releaseFixture({ config });
  const candidates = await fixture.manifest.buildPullRequests();
  expect(
    fixture.requests.filter((request) =>
      request.pathname.includes("/commits/"),
    ),
  ).toHaveLength(2);
  expect(candidates).toHaveLength(excluded ? 0 : 1);
});

it("collects beyond 500 commits and rejects an unobserved known release boundary", async () => {
  const commits = Array.from({ length: 501 }, (_, index) => ({
    sha: index.toString(16).padStart(40, "0"),
    message: `fix: unreleased change ${index}`,
    files: ["src/change.ts"],
  }));
  commits.push({
    sha: baseline,
    message: "chore: release 6.7.0",
    files: ["package.json"],
  });
  const complete = await releaseFixture({ commits, depth: commits.length });
  const candidates = await complete.manifest.buildPullRequests();
  expect(candidates[0]?.body.toString()).toContain("unreleased change 500");
  expect(complete.pages).toHaveLength(51);
  expect(
    complete.requests.filter((request) =>
      request.pathname.includes("/commits/"),
    ),
  ).toEqual([]);
  const truncated = await releaseFixture({ commits });
  await expect(truncated.manifest.createPullRequests()).rejects.toThrow(
    "Incomplete release history",
  );
  expect(
    truncated.requests.every(
      (request) => request.method === "GET" || request.pathname === "/graphql",
    ),
  ).toBe(true);
});

it("preserves a reached explicit last-release override", async () => {
  const fixture = await releaseFixture({
    config: { "last-release-sha": latest },
  });
  await expect(fixture.manifest.buildPullRequests()).resolves.toEqual([]);
});

it("preserves complete mixed bootstrap history with all known release boundaries", async () => {
  const fixture = await releaseFixture({
    config: {
      packages: {
        ".": { "package-name": "rea-agents" },
        pkg: { "package-name": "unreleased" },
      },
    },
  });
  await expect(fixture.manifest.buildPullRequests()).resolves.toHaveLength(1);
});

it("requires complete local history when sizing the upstream search", async () => {
  const directory = await createTestTempDirectory("rea-release-depth-");
  await execute("git", ["init", "--quiet", directory]);
  await execute("git", [
    "-C",
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const run = async (command: string, args: string[]) =>
    (await execute(command, args, { cwd: directory })).stdout;
  const head = (await run("git", ["rev-parse", "HEAD"])).trim();
  await expect(releaseProposalSearchDepth(run, head)).resolves.toBe(1);
  await writeFile(join(directory, ".git/shallow"), `${head}\n`);
  await expect(releaseProposalSearchDepth(run, head)).rejects.toThrow(
    "complete Git history",
  );
});

it("applies the exact dependency patch idempotently and rejects another version", async () => {
  await expect(applyReleasePleasePatch()).resolves.toBeUndefined();
  const directory = dirname(require.resolve("release-please/package.json"));
  const metadata = await readFile(join(directory, "package.json"), "utf8");
  expect(JSON.parse(metadata).version).toBe("17.3.0");
  const fixture = await createTestTempDirectory("rea-release-patch-");
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({ version: "17.4.0" }),
  );
  await expect(applyReleasePleasePatch(fixture)).rejects.toThrow(
    "requires release-please 17.3.0",
  );
});

it("rejects a partial or mismatched dependency patch", async () => {
  const directory = dirname(require.resolve("release-please/package.json"));
  const manifest = join(directory, "build/src/manifest.js");
  const original = await readFile(manifest, "utf8");
  try {
    await writeFile(
      manifest,
      original.replace(
        "const rootOnlyNode =",
        "const mismatchedRootOnlyNode =",
      ),
    );
    await expect(applyReleasePleasePatch()).rejects.toThrow(
      "does not match the installed source",
    );
  } finally {
    await writeFile(manifest, original);
  }
});
