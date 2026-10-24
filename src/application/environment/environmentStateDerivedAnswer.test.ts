import { describe, expect, it } from "vitest";

import {
  BOOKMARK_ROWS,
  FILED_ROWS,
  FOLDER_ROWS,
  TAG_ROWS,
  TAGGED_ROWS,
  optionallyFiledRows,
  referencedCreateRows,
  shelvedRows,
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

describe("served creates learned from every call", () => {
  it("stores a member a create leaves out at the default a recorded call showed, and a sent one as sent", () => {
    const books = servedFrom(
      shelvedRows(
        { name: "Third Book" },
        { name: "Fourth Book", shelf: "rare" },
      ),
    );
    expect(
      objectOf(books.answer("post_books", { body: { name: "Plain" } }).body),
    ).toMatchObject({ name: "Plain", shelf: "general" });
    expect(
      objectOf(
        books.answer("post_books", { body: { name: "Kept", shelf: "attic" } })
          .body,
      ),
    ).toMatchObject({ name: "Kept", shelf: "attic" });
  });
});

describe("served objects that repeat a named entity, and sorted arrays", () => {
  it("embeds the shelf a create names as the environment holds it, lists it with the listed keys, and refuses an unknown shelf", () => {
    const books = servedFrom(FILED_ROWS);
    const created = objectOf(
      books.answer("post_books", { body: { name: "Pilot Guide", shelf_id: 2 } })
        .body,
    );
    expect(created["shelf"]).toEqual({
      id: 2,
      name: "Map Room",
      floor: "upper",
    });
    const listed = books.answer("get_books").body as JsonValue[];
    expect(listed.at(-1)).toMatchObject({
      name: "Pilot Guide",
      shelf: { id: 2, name: "Map Room" },
    });
    expect(JSON.stringify(listed.at(-1))).not.toContain("upper");
    expect(
      JSON.stringify(
        books.refusal("post_books", { body: { name: "Lost", shelf_id: 9 } }),
      ),
    ).toContain("names no entity of /api/shelves");
  });

  it("keeps a contradicted reference out of state writes without changing recording fallback", () => {
    const books = servedFrom(
      referencedCreateRows({ id: 1, name: "Different Hall", floor: "ground" }),
    );
    expect(books.state.writes.get("post_books")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
    const before = books.snapshot();
    expect(
      books.answer("post_books", { body: { name: "New Book", shelf_id: 1 } }),
    ).toMatchObject({ state: { source: "recording" } });
    expect(books.snapshot()).toBe(before);
  });

  it.each([true, false])(
    "answers a create with the shelf only when it names one, whichever recorded create was first (shelf first: %s)",
    (shelfFirst) => {
      const books = servedFrom(optionallyFiledRows(shelfFirst));
      const plain = objectOf(
        books.answer("post_books", { body: { name: "Loose Leaf" } }).body,
      );
      expect(plain).toMatchObject({ name: "Loose Leaf" });
      expect(plain).not.toHaveProperty("shelf");
      const shelved = objectOf(
        books.answer("post_books", {
          body: { name: "Pilot Guide", shelf_id: 1 },
        }).body,
      );
      expect(shelved).toMatchObject({
        name: "Pilot Guide",
        shelf: { id: 1, name: "Main Hall", floor: "ground" },
      });
    },
  );

  it("stores the tags a create sends in code-point order", () => {
    const books = servedFrom(TAGGED_ROWS);
    expect(
      objectOf(
        books.answer("post_books", {
          body: { name: "Logbook", tags: ["wind", "ice", "fog"] },
        }).body,
      )["tags"],
    ).toEqual(["fog", "ice", "wind"]);
  });
});
