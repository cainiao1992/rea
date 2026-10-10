import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, root] = process.argv.slice(2);
if (modulePath === undefined || root === undefined)
  throw new Error("Reference reader FIFO probe requires module and root paths");

const { readStableFile } = await import(pathToFileURL(modulePath));
const absolute = join(root, "source.txt");
await writeFile(absolute, "observed regular file\n");
const expected = await lstat(absolute, { bigint: true });
await unlink(absolute);
execFileSync("mkfifo", [absolute]);

// Capture the directory after replacement to reach the file-open boundary.
// The owning test bounds this child if an O_RDONLY FIFO open blocks again.
const rootIdentity = await lstat(root, { bigint: true });
const result = await readStableFile({
  root,
  rootIdentity,
  absolute,
  path: "source.txt",
  expected,
});
assert.equal(result.status, "failed");
assert.equal(result.kind, "file");
assert.equal(result.code, "changed");
process.stdout.write("changed\n");
