import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bookmarkService,
  bookmarksDb,
  type Bookmark,
} from "./bookmark-service";

describe("bookmarkService imports", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should avoid duplicating the first nested bookmark in browser HTML imports", async () => {
    const created: Bookmark[] = [];

    vi.spyOn(bookmarksDb, "create").mockImplementation(async (item) => {
      created.push(item);
      return item;
    });
    vi.spyOn(bookmarksDb, "getAll").mockImplementation(async () => created);

    const html = `
      <!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL>
        <DT><H3>Folder A</H3>
        <DL>
          <DT><A HREF="https://example.com">Nested Link</A>
        </DL>
      </DL>
    `;

    const result = await bookmarkService.importFromBrowserHTML(html, new Set());

    expect(result.count).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: "Nested Link",
      url: "https://example.com",
      category: "Folder A",
    });
  });

  it("should dedupe repeated urls within the same JSON import batch", async () => {
    const created: Bookmark[] = [];

    vi.spyOn(bookmarksDb, "create").mockImplementation(async (item) => {
      created.push(item);
      return item;
    });
    vi.spyOn(bookmarksDb, "getAll").mockImplementation(async () => created);

    const payload = JSON.stringify([
      {
        id: "bm_1",
        title: "One",
        url: "https://repeat.example.com",
      },
      {
        id: "bm_2",
        title: "Two",
        url: "https://repeat.example.com",
      },
    ]);

    const result = await bookmarkService.importFromJSON(payload, new Set());

    expect(result.count).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].url).toBe("https://repeat.example.com");
  });
});
