import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  analysisViewCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  environmentStateServeFixture,
  environmentStateServeInputs,
} from "../../../tests/fixtures/environmentServe.js";
import { servedFrom } from "../../../tests/fixtures/environmentStateServing.js";
import {
  BOOK_NOT_FOUND,
  FIRST_BOOK,
  SECOND_BOOK,
  book,
  bookClock,
  renamedBook,
} from "../../../tests/fixtures/environmentStateWrites.js";

import { webNetworkCaptureSchema } from "../../domain/webNetworkCapture.js";

const archived = (value: boolean) => ({ ...FIRST_BOOK, archived: value });

describe("bodyless action evidence", () => {
  it.each([
    {
      name: "form",
      postData: {
        mimeType: "application/x-www-form-urlencoded",
        text: "toggle=false",
      },
    },
    {
      name: "malformed JSON",
      postData: { mimeType: "application/json", text: "{" },
    },
    {
      name: "oversized JSON",
      postData: {
        mimeType: "application/json",
        text: JSON.stringify({ note: "x".repeat(256 * 1024) }),
      },
    },
    { name: "unretained body", postData: undefined },
  ])(
    "does not use unreadable or unretained request bodies as a repeated bodyless action: $name",
    ({ postData }) => {
      const capture = timedCaptureEvidence([
        ["GET", "/api/books", [archived(false), SECOND_BOOK]],
        ["GET", "/api/books/1", archived(false)],
        ["GET", "/api/books/2", SECOND_BOOK],
        ["POST", "/api/books/1/archive", archived(true)],
        ["GET", "/api/books/1", archived(true)],
        ["POST", "/api/books/1/archive", archived(true)],
        ["GET", "/api/books/1", archived(true)],
      ]);
      const result = capture.normalized_result as {
        records: {
          reported: { request: { postData?: unknown; bodySize?: number } };
        }[];
      };
      const request = result.records[5]!.reported.request;
      request.bodySize = 12;
      if (postData === undefined) delete request.postData;
      else request.postData = postData;
      const { state } = environmentStateServeInputs(
        environmentStateServeFixture(
          analysisViewCaptureEvidence(
            webNetworkCaptureSchema.parse(capture.normalized_result),
          ),
        ),
      );
      expect(state.writes.get("post_books_archive_by_id")).toMatchObject({
        served: false,
      });
    },
  );
});

it("keeps a stored array-of-object field as an ordinary update body", () => {
  const original = { ...FIRST_BOOK, tags: [{ id: 7, name: "Old" }] };
  const second = { ...SECOND_BOOK, tags: [{ id: 8, name: "Other" }] };
  const changed = { ...original, tags: [{ id: 9, name: "Recorded" }] };
  const books = servedFrom([
    ["GET", "/api/books", [original, second]],
    ["GET", "/api/books/1", original],
    ["GET", "/api/books/2", second],
    ["PATCH", "/api/books/1", changed, 200, { tags: changed.tags }],
    ["GET", "/api/books/1", changed],
    ["GET", "/api/books", [changed, second]],
  ]);
  expect(books.state.writes.get("patch_books_by_id")).toMatchObject({
    served: true,
  });
  expect(books.state.writes.get("patch_books_by_id")?.body).not.toHaveProperty(
    "envelope",
  );
  const tags = [
    { id: 10, name: "Caller" },
    { id: 11, name: "Second tag" },
  ];
  expect(
    books.answer("patch_books_by_id", { id: "2", body: { tags } }).body,
  ).toMatchObject({ id: 2, tags });
});

const TOKENS = ["Abcdef0123456789A", "Abcdef0123456789B", "Abcdef0123456789C"];

it("withholds a generated create token copied into a nested constant", () => {
  const first = { ...FIRST_BOOK, version: TOKENS[0]! };
  const second = { ...SECOND_BOOK, version: TOKENS[1]! };
  const third = {
    ...book(3, "Created", bookClock(3)),
    version: TOKENS[2]!,
    metadata: { versions: [{ value: TOKENS[2]! }] },
  };
  const books = servedFrom([
    ["GET", "/api/books", [first, second]],
    ["GET", "/api/books/1", first],
    ["GET", "/api/books/2", second],
    ["POST", "/api/books", third, 201, { name: "Created" }],
    ["GET", "/api/books/3", third],
  ]);
  expect(books.state.writes.get("post_books")).toMatchObject({
    served: false,
    reason: "unexplained-change",
  });
});

it("withholds an update token already present in a nested unchanged field", () => {
  const first = {
    ...FIRST_BOOK,
    version: TOKENS[0]!,
    metadata: { versions: [TOKENS[1]!] },
  };
  const second = { ...SECOND_BOOK, version: TOKENS[2]!, metadata: {} };
  const changed = { ...first, version: TOKENS[1]! };
  const books = servedFrom([
    ["GET", "/api/books", [first, second]],
    ["GET", "/api/books/1", first],
    ["GET", "/api/books/2", second],
    ["PATCH", "/api/books/1", changed, 200, {}],
    ["GET", "/api/books/1", changed],
    ["GET", "/api/books", [changed, second]],
  ]);
  expect(books.state.writes.get("patch_books_by_id")).toMatchObject({
    served: false,
  });
});

it.each(["2", "02"])(
  "withholds a bulk acknowledgement with string count %s",
  (deleted) => {
    const rows: TimedCaptureRow[] = [
      [
        "GET",
        "/api/books",
        [
          { ...FIRST_BOOK, id: 10 },
          { ...SECOND_BOOK, id: 20 },
        ],
      ],
      ["GET", "/api/books/10", { ...FIRST_BOOK, id: 10 }],
      ["GET", "/api/books/20", { ...SECOND_BOOK, id: 20 }],
      ["DELETE", "/api/books", { deleted }, 200, { ids: [10, 20] }],
      ["GET", "/api/books/10", BOOK_NOT_FOUND, 404],
      ["GET", "/api/books/20", BOOK_NOT_FOUND, 404],
      ["GET", "/api/books", []],
    ];
    expect(servedFrom(rows).state.writes.get("delete_books")).toMatchObject({
      served: false,
      reason: "body-unusable",
    });
  },
);

const nestedClockRows = (edit: {
  [key: string]: string;
}): TimedCaptureRow[] => {
  const first = {
    ...FIRST_BOOK,
    edit: {
      at: FIRST_BOOK.created_at!,
      seen_at: FIRST_BOOK.created_at!,
      by: "alice",
    },
  };
  const second = {
    ...SECOND_BOOK,
    edit: {
      at: SECOND_BOOK.created_at!,
      seen_at: SECOND_BOOK.created_at!,
      by: "alice",
    },
  };
  const third = {
    ...book(3, "Third", bookClock(3)),
    edit: { at: bookClock(3), seen_at: bookClock(3), by: "alice" },
  };
  const fourth = { ...book(4, "Fourth", bookClock(5)), edit };
  return [
    ["GET", "/api/books", [first, second]],
    ["GET", "/api/books/1", first],
    ["GET", "/api/books/2", second],
    ["POST", "/api/books", third, 201, { name: "Third" }],
    ["GET", "/api/books/3", third],
    ["POST", "/api/books", fourth, 201, { name: "Fourth" }],
    ["GET", "/api/books/4", fourth],
    ["GET", "/api/books", [first, second, third, fourth]],
  ];
};

it.each<{ name: string; edit: { [key: string]: string } }>([
  {
    name: "changed editor",
    edit: { at: bookClock(5), seen_at: bookClock(5), by: "bob" },
  },
  {
    name: "added member",
    edit: {
      at: bookClock(5),
      seen_at: bookClock(5),
      by: "alice",
      role: "admin",
    },
  },
  { name: "omitted member", edit: { at: bookClock(5), seen_at: bookClock(5) } },
  {
    name: "different clock values",
    edit: { at: bookClock(5), seen_at: bookClock(6), by: "alice" },
  },
])(
  "withholds creates whose nested-clock renderer cannot reproduce a later $name",
  ({ edit }) => {
    expect(
      servedFrom(nestedClockRows(edit)).state.writes.get("post_books"),
    ).toMatchObject({ served: false, reason: "unexplained-change" });
  },
);

it("serves successive creates whose complete nested-clock objects are reproducible", () => {
  const books = servedFrom(
    nestedClockRows({ at: bookClock(5), seen_at: bookClock(5), by: "alice" }),
  );
  expect(books.state.writes.get("post_books")).toMatchObject({ served: true });
  const result = books.answer("post_books", { body: { name: "Caller" } });
  expect(result.body).toMatchObject({ name: "Caller", edit: { by: "alice" } });
  const edit = (result.body as { edit: { at: string; seen_at: string } }).edit;
  expect(edit.at).toBe(edit.seen_at);
});

it.each([0, 1])(
  "checks the complete nested-clock update for a %s-second member difference",
  (seconds) => {
    const first = {
      ...FIRST_BOOK,
      edit: { at: bookClock(-8), seen_at: bookClock(-8), by: "alice" },
    };
    const second = {
      ...SECOND_BOOK,
      edit: { at: bookClock(-7), seen_at: bookClock(-7), by: "alice" },
    };
    const changed = {
      ...renamedBook(first, "Renamed", 3),
      edit: { at: bookClock(3), seen_at: bookClock(3 + seconds), by: "alice" },
    };
    const books = servedFrom([
      ["GET", "/api/books", [first, second]],
      ["GET", "/api/books/1", first],
      ["GET", "/api/books/2", second],
      ["PATCH", "/api/books/1", changed, 200, { name: "Renamed" }],
      ["GET", "/api/books/1", changed],
      ["GET", "/api/books", [changed, second]],
    ]);
    expect(books.state.writes.get("patch_books_by_id")).toMatchObject({
      served: seconds === 0,
    });
    if (seconds === 0) {
      const result = books.answer("patch_books_by_id", {
        id: "2",
        body: { name: "Caller" },
      });
      expect(result.body).toMatchObject({ edit: { by: "alice" } });
      const edit = (result.body as { edit: { at: string; seen_at: string } })
        .edit;
      expect(edit.at).toBe(edit.seen_at);
    }
  },
);

it.each([
  { bulk: false, unequal: false },
  { bulk: true, unequal: false },
  { bulk: false, unequal: true },
  { bulk: true, unequal: true },
])(
  "validates the write response before its stored clock spelling (bulk=$bulk, unequal=$unequal)",
  ({ bulk, unequal }) => {
    const edit = (seconds: number, fraction: string) => ({
      at: new Date(bookClock(seconds)).toISOString().replace(".000Z", fraction),
      seen_at: new Date(bookClock(seconds))
        .toISOString()
        .replace(".000Z", fraction),
      by: "alice",
    });
    const first = { ...FIRST_BOOK, edit: edit(-8, ".000123Z") };
    const second = { ...SECOND_BOOK, edit: edit(-7, ".000123Z") };
    const changed = {
      ...renamedBook(first, "Renamed", 3),
      edit: {
        ...edit(3, ".000Z"),
        seen_at: new Date(bookClock(unequal ? 4 : 3)).toISOString(),
      },
    };
    const read = { ...changed, edit: edit(3, ".000123Z") };
    const books = servedFrom([
      ["GET", "/api/books", [first, second]],
      ["GET", "/api/books/1", first],
      ["GET", "/api/books/2", second],
      [
        "PATCH",
        bulk ? "/api/books" : "/api/books/1",
        bulk ? [changed] : changed,
        200,
        bulk ? [{ id: 1, name: "Renamed" }] : { name: "Renamed" },
      ],
      ["GET", "/api/books/1", read],
      ["GET", "/api/books", [read, second]],
    ]);
    const name = bulk ? "patch_books" : "patch_books_by_id";
    expect(books.state.writes.get(name)).toMatchObject({ served: !unequal });
    if (!unequal) {
      const result = books.answer(
        name,
        bulk
          ? { body: [{ id: 2, name: "Caller" }] }
          : { id: "2", body: { name: "Caller" } },
      );
      const entity = (bulk ? (result.body as unknown[])[0] : result.body) as {
        name: string;
        edit: { at: string; seen_at: string; by: string };
      };
      expect(entity).toMatchObject({ name: "Caller", edit: { by: "alice" } });
      expect(entity.edit.at).toBe(entity.edit.seen_at);
      expect(entity.edit.at).toMatch(/\.\d{3}Z$/u);
    }
  },
);
