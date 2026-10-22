import { describe, expect, it } from "vitest";
import { servedFrom } from "../../../tests/fixtures/environmentStateServing.js";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("assigned values preserve every recorded relation", () => {
  it("freezes a copied member when another template would retain its old value", () => {
    const item = (id: number, slug: string) => ({
      id,
      code: slug,
      url: `/${slug}`,
      mixed: `/${id}/${slug}`,
    });
    const first = item(1, "first-slug");
    const second = item(2, "second-slug");
    const third = item(3, "abcdefgh");
    const books = servedFrom([
      ["GET", "/api/books", [first, second]],
      ["GET", "/api/books/1", first],
      ["GET", "/api/books/2", second],
      ["POST", "/api/books", third, 201, { customSlug: "abcdefgh" }],
      ["GET", "/api/books/3", third],
    ]);
    expect(books.state.writes.get("post_books")).toMatchObject({
      served: true,
      body: { fixed: [{ member: "customSlug", sent: "abcdefgh" }] },
    });
    expect(
      books.refusal("post_books", { body: { customSlug: "ijklmnop" } }),
    ).toMatchObject({ code: "invalid_request" });
    expect(
      books.answer("post_books", { body: { customSlug: "abcdefgh" } }).body,
    ).toMatchObject({ code: "abcdefgh", url: "/abcdefgh" });
  });

  it.each(["nested", "scalar"] as const)(
    "withholds an update whose generated scalar shares a fresh UUID with a %s field",
    (shape) => {
      const linked = (id: number, value: string) => ({
        id,
        name: "Before",
        version: value,
        link: shape === "nested" ? [{ id: value }] : value,
      });
      const first = linked(1, uuid(1));
      const second = linked(2, uuid(2));
      const after = { ...linked(1, uuid(3)), name: "After" };
      const books = servedFrom([
        ["GET", "/api/books", [first, second]],
        ["GET", "/api/books/1", first],
        ["GET", "/api/books/2", second],
        ["PATCH", "/api/books/1", after, 200, { name: "After" }],
        ["GET", "/api/books/1", after],
      ]);
      expect(books.state.writes.get("patch_books_by_id")).toMatchObject({
        served: false,
        reason: "unexplained-change",
      });
    },
  );
});
