import { describe, expect, it } from "vitest";

import {
  BOOKMARK_ROWS,
  FOLDER_ROWS,
  TAG_ROWS,
} from "../../../tests/fixtures/environmentStateDerivedValues.js";
import { servedFrom } from "../../../tests/fixtures/environmentStateServing.js";
import {
  bookClock,
  numberedUuid,
} from "../../../tests/fixtures/environmentStateWrites.js";
import type { JsonValue } from "../../domain/jsonValue.js";

/** The clock the first served write of a capture of `rows` stamps: one second past the served clock's start. */
const firstServedClock = (rows: readonly unknown[]): string =>
  bookClock(rows.length + 1);

const objectOf = (body: JsonValue | undefined): Record<string, JsonValue> => {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("Expected an object body");
  return body;
};

describe("served values an application derives from others", () => {
  it("stamps a created tag's clocks with trailing fraction zeros dropped, as the capture spelled them", () => {
    const tags = servedFrom(TAG_ROWS);
    const created = objectOf(
      tags.answer("post_tags", { body: { name: "Spare" } }).body,
    );
    expect(created).toMatchObject({
      name: "Spare",
      createdAt: firstServedClock(TAG_ROWS),
      updatedAt: firstServedClock(TAG_ROWS),
    });
  });

  it("composes a created bookmark's snapshot address from the served clock and the sent URL", () => {
    const bookmarks = servedFrom(BOOKMARK_ROWS);
    const url = "https://pier.example.test/inspection";
    const created = objectOf(
      bookmarks.answer("post_bookmarks", { body: { url, title: "Pier" } }).body,
    );
    const digits = firstServedClock(BOOKMARK_ROWS)
      .replace(/\D/gu, "")
      .slice(0, 14);
    expect(created).toMatchObject({
      url,
      web_archive_snapshot_url: `https://web.archive.org/web/${digits}/${url}`,
    });
  });

  it("gives a created folder a fresh numeric id and an address that follows its uid and title, and renames it", () => {
    const folders = servedFrom(FOLDER_ROWS);
    const uid = numberedUuid(200);
    const created = objectOf(
      folders.answer("post_folders", {
        body: { uid, title: "New Folder Name" },
      }).body,
    );
    expect(created).toMatchObject({
      uid,
      url: `/dashboards/f/${uid}/new-folder-name`,
    });
    expect(typeof created["id"]).toBe("number");
    expect(String(created["id"])).toHaveLength(16);
    expect([
      1655476044521472, 1656166527623168, 1656166745726976,
    ]).not.toContain(created["id"]);
    const renamed = objectOf(
      folders.answer("put_folders_by_uuid", {
        uuid: uid,
        body: { title: "Moved Folder" },
      }).body,
    );
    expect(renamed).toMatchObject({
      id: created["id"],
      url: `/dashboards/f/${uid}/moved-folder`,
    });
    expect(
      folders.answer("get_folders_by_uuid", { uuid: uid }).body,
    ).toMatchObject({ title: "Moved Folder", url: renamed["url"] });
  });
});
