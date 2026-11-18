import assert from "node:assert/strict";

globalThis.dalibre = {
  settings: { apiKey: "test-token", tagPrefix: "Hardcover: " },
  error(kind, message) {
    const err = new Error(message || kind);
    err.kind = kind;
    return err;
  },
  progress() {},
  async form() {
    return {};
  },
  library: {
    async *books() {},
  },
};

const { identify, run } = await import("./main.js");
assert.equal(typeof identify, "function", "main.js must export identify()");
assert.equal(typeof run, "function", "main.js must export run()");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 1. Missing or invalid token throws dalibre.error("auth"), and optional "Bearer " prefix is normalized
{
  globalThis.dalibre.settings = { apiKey: "", tagPrefix: "Hardcover: " };
  await assert.rejects(
    () => identify({ title: "Dune", authors: [], identifiers: {} }),
    (err) => err?.kind === "auth",
  );

  let seenAuth = "";
  globalThis.dalibre.settings = { apiKey: "Bearer my-secret-pat", tagPrefix: "Hardcover: " };
  globalThis.fetch = async (_url, init) => {
    seenAuth = init?.headers?.Authorization ?? "";
    return jsonResponse({ data: { books: [] } });
  };
  const out = await identify({ title: "", authors: [], identifiers: { hardcover: "427537" } });
  assert.deepEqual(out, []);
  assert.equal(seenAuth, "Bearer my-secret-pat");
}

// 2. identify(): by hardcover id, ISBN, and title/author selecting PT-BR edition when book.language is pt
{
  globalThis.dalibre.settings = { apiKey: "pat-123", tagPrefix: "Hardcover: " };
  const sampleBook = {
    id: 427537,
    title: "Artificial Condition",
    slug: "artificial-condition",
    description: "Murderbot #2 description.",
    release_year: 2018,
    rating: 4.2,
    ratings_count: 2900,
    image: { url: "https://assets.hardcover.app/book/427537.jpg" },
    contributions: [{ author: { name: "Martha Wells" } }],
    book_series: [{ position: 2, series: { name: "The Murderbot Diaries" } }],
    cached_tags: { Genre: [{ tag: "Science Fiction" }, { tag: "Dystopian" }] },
    editions: [
      {
        id: 1001,
        title: "Artificial Condition",
        isbn_13: "9781250186928",
        isbn_10: "1250186927",
        pages: 158,
        release_date: "2018-05-08",
        image: { url: "https://assets.hardcover.app/edition/1001.jpg" },
        publisher: { name: "Tor.com" },
        language: { code2: "en" },
      },
      {
        id: 32116755,
        title: "Condição Artificial",
        isbn_13: "9788576577263",
        isbn_10: "8576577267",
        pages: 224,
        release_date: "2025-05-22",
        image: { url: "https://assets.hardcover.app/edition/32116755.jpg" },
        publisher: { name: "Editora Aleph" },
        language: { code2: "pb" },
      },
    ],
  };

  // 2a. Search by title + author + language="pt" prefers Brazilian edition
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.query.includes("search(")) {
      return jsonResponse({
        data: {
          search: {
            results: {
              hits: [{ document: { id: "427537", title: "Artificial Condition", author_names: ["Martha Wells"] } }],
            },
          },
        },
      });
    }
    if (body.query.includes("books(")) {
      return jsonResponse({ data: { books: [sampleBook] } });
    }
    throw new Error(`Unexpected GraphQL query: ${body.query}`);
  };

  const cands = await identify({
    title: "Artificial Condition",
    authors: ["Martha Wells"],
    identifiers: {},
    language: "pt",
  });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].title, "Condição Artificial");
  assert.equal(cands[0].publisher, "Editora Aleph");
  assert.equal(cands[0].pubdate, "2025-05-22");
  assert.equal(cands[0].language, "pt");
  assert.equal(cands[0].series, "The Murderbot Diaries");
  assert.equal(cands[0].seriesIndex, 2);
  assert.equal(cands[0].cover, "https://assets.hardcover.app/edition/32116755.jpg");
  assert.equal(cands[0].url, "https://hardcover.app/books/artificial-condition");
  assert.deepEqual(cands[0].identifiers, { hardcover: "427537", isbn: "9788576577263" });
  assert.deepEqual(cands[0].tags, ["Science Fiction", "Dystopian"]);

  // 2b. ISBN lookup matches exact edition
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.variables.isbn, "9781250186928");
    return jsonResponse({ data: { books: [sampleBook] } });
  };
  const [byIsbn] = await identify({ title: "", authors: [], identifiers: { isbn: "978-1-250-18692-8" } });
  assert.equal(byIsbn.title, "Artificial Condition");
  assert.equal(byIsbn.publisher, "Tor.com");
  assert.equal(byIsbn.identifiers.isbn, "9781250186928");
  assert.equal(byIsbn.identifiers.hardcover, "427537");
}

function assertDalibre063Form(form) {
  assert.ok(form && typeof form === "object");
  const allowed = new Set(["submit", "fields", "remember"]);
  for (const k of Object.keys(form)) {
    assert.ok(allowed.has(k), `unexpected form key ${k} (breaks Dalibre <=0.6.3)`);
  }
  assert.equal("note" in form, false, "must not send note (breaks Dalibre <=0.6.3)");
}

// 3. Action: sync-from-hardcover matches by hardcover id, ISBN, and normalized (edition/book title, "Last, First" author)
{
  globalThis.dalibre.settings = { apiKey: "pat-123", tagPrefix: "Hardcover: " };
  let capturedForm = null;
  globalThis.dalibre.form = async (form) => {
    capturedForm = form;
    assertDalibre063Form(form);
    return {
      syncTags: true,
      syncRatings: true,
      fillMissingIsbn: true,
    };
  };

  globalThis.dalibre.library = {
    async *books() {
      yield {
        id: 101,
        title: "O Aprendiz de Assassino",
        authors: ["Hobb, Robin"],
        tags: ["Fantasy", "Hardcover: Want to Read"],
        identifiers: {},
        rating: 0,
        formats: ["EPUB"],
        hasCover: true,
      };
      yield {
        id: 102,
        title: "Condição Artificial",
        authors: ["Martha Wells"],
        tags: ["Sci-Fi"],
        identifiers: { isbn: "9788576577263" },
        rating: 0,
        formats: ["EPUB"],
        hasCover: true,
      };
      yield {
        id: 103,
        title: "Unmatched Local Book",
        authors: ["Someone"],
        tags: [],
        identifiers: {},
        rating: 0,
        formats: ["EPUB"],
        hasCover: false,
      };
      yield {
        id: 104,
        title: "Mistborn: Secret History",
        authors: ["Brandon Sanderson"],
        tags: ["PT-BR"],
        identifiers: {},
        rating: 0,
        formats: ["EPUB"],
        hasCover: false,
      };
      yield {
        id: 105,
        title: "Empire of the Dawn",
        authors: ["Jay Kristoff"],
        tags: ["PT-BR"],
        languages: ["por"],
        identifiers: {},
        rating: 0,
        formats: ["EPUB"],
        hasCover: false,
      };
    },
  };

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.ok(body.query.includes("user_books"));
    assert.ok(body.query.includes("language { code2 }"), "must request edition language.code2");
    return jsonResponse({
      data: {
        me: [
          {
            id: 109039,
            username: "bellussi",
            user_books: [
              {
                id: 15108906,
                status_id: 2,
                rating: null,
                edition: { id: 32672942, title: "O Aprendiz de Assassino", isbn_13: "9788554515263", isbn_10: "8554515269", language: { code2: "pb" } },
                book: { id: 427336, title: "Assassin's Apprentice", contributions: [{ author: { name: "Robin Hobb" } }] },
                user_book_reads: [{ progress: 61.74, progress_pages: 305 }],
              },
              {
                id: 15108907,
                status_id: 3,
                rating: 4.5,
                edition: { id: 32116755, title: "Condição Artificial", isbn_13: "9788576577263", isbn_10: "8576577267", language: { code2: "pb" } },
                book: { id: 427537, title: "Artificial Condition", contributions: [{ author: { name: "Martha Wells" } }] },
                user_book_reads: [],
              },
              {
                id: 15108908,
                status_id: 3,
                rating: 4.5,
                edition: { id: 990001, title: "Mistborn: The Final Empire", isbn_13: "9780765311788", language: { code2: "en" } },
                book: { id: 369692, title: "Mistborn: The Final Empire", contributions: [{ author: { name: "Brandon Sanderson" } }] },
                user_book_reads: [],
              },
              {
                id: 15108909,
                status_id: 3,
                rating: 5.0,
                edition: { id: 990002, title: "Empire of the Dawn", isbn_13: "9781250245380", language: { code2: "en" } },
                book: { id: 1801904, title: "Empire of the Dawn", contributions: [{ author: { name: "Jay Kristoff" } }] },
                user_book_reads: [],
              },
            ],
          },
        ],
      },
    });
  };

  const res = await run("sync-from-hardcover", { books: [] });
  assertDalibre063Form(capturedForm);
  assert.ok(res.message.includes("3"));
  assert.equal(res.groups.length, 2);
  assert.equal(res.groups[0].title, "Currently Reading");
  assert.equal(res.groups[0].books[0].id, 101);
  assert.ok(res.groups[0].books[0].note.includes("62%"));

  assert.equal(res.changes.length, 3);
  assert.equal(res.changes.find((c) => c.book === 104), undefined, "Mistborn: Secret History must not match The Final Empire");
  const c101 = res.changes.find((c) => c.book === 101);
  assert.deepEqual(c101.metadata.identifiers, { hardcover: "427336", isbn: "9788554515263" });
  assert.deepEqual(c101.metadata.tags, ["Fantasy", "Hardcover: Reading"]);

  const c102 = res.changes.find((c) => c.book === 102);
  assert.deepEqual(c102.metadata.identifiers, { hardcover: "427537" });
  assert.equal(c102.metadata.rating, 9);
  assert.deepEqual(c102.metadata.tags, ["Sci-Fi", "Hardcover: Read"]);

  const c105 = res.changes.find((c) => c.book === 105);
  assert.deepEqual(c105.metadata.identifiers, { hardcover: "1801904" }, "PT-BR book must not inherit English edition ISBN");
  assert.equal(c105.metadata.rating, 10);
  assert.deepEqual(c105.metadata.tags, ["PT-BR", "Hardcover: Read"]);

  // Re-running sync when tags are already present in alphabetical order emits zero changes
  globalThis.dalibre.library = {
    async *books() {
      yield {
        id: 102,
        title: "Condição Artificial",
        authors: ["Martha Wells"],
        tags: ["Fantasy", "Hardcover: Read", "PT-BR", "Sci-Fi"],
        identifiers: { hardcover: "427537", isbn: "9788576577263" },
        rating: 9,
        formats: ["EPUB"],
        hasCover: true,
      };
    },
  };
  const noopRes = await run("sync-from-hardcover", { books: [] });
  assert.equal(noopRes.changes.length, 0, "must not emit reorder-only tag changes when status tag is already present");
  assert.equal(noopRes.groups.length, 1);
}

// 4. Action: set-hardcover-status updates existing user_book and inserts new user_book with edition_id
{
  globalThis.dalibre.settings = { apiKey: "pat-123", tagPrefix: "Hardcover: " };
  globalThis.dalibre.form = async (form) => {
    assertDalibre063Form(form);
    return { status: "3", rating: "4.5" };
  };

  const mutations = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.query.includes("user_books(")) {
      return jsonResponse({
        data: {
          me: [
            {
              id: 109039,
              username: "bellussi",
              user_books: [{ id: 15108906, status_id: 2, edition_id: 32672942, book: { id: 427336 } }],
            },
          ],
        },
      });
    }
    if (body.query.includes("update_user_book")) {
      mutations.push({ op: "update", vars: body.variables });
      return jsonResponse({ data: { update_user_book: { id: 15108906, error: null } } });
    }
    if (body.query.includes("where: {id: {_in:")) {
      return jsonResponse({
        data: {
          books: [
            {
              id: 427537,
              title: "Artificial Condition",
              editions: [{ id: 32116755, isbn_13: "9788576577263", language: { code2: "pb" } }],
            },
          ],
        },
      });
    }
    if (body.query.includes("insert_user_book")) {
      mutations.push({ op: "insert", vars: body.variables });
      return jsonResponse({ data: { insert_user_book: { id: 99999, error: null } } });
    }
    throw new Error(`Unexpected mutation query: ${body.query}`);
  };

  const res = await run("set-hardcover-status", {
    books: [
      { id: 101, title: "O Aprendiz de Assassino", authors: ["Robin Hobb"], tags: ["Hardcover: Reading"], identifiers: { hardcover: "427336" }, hasCover: true, formats: ["EPUB"] },
      { id: 102, title: "Condição Artificial", authors: ["Martha Wells"], tags: [], identifiers: { hardcover: "427537", isbn: "9788576577263" }, hasCover: true, formats: ["EPUB"] },
    ],
  });
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0].op, "update");
  assert.equal(mutations[0].vars.id, 15108906);
  assert.equal(mutations[0].vars.object.status_id, 3);
  assert.equal(mutations[0].vars.object.rating, 4.5);
  assert.equal(mutations[1].op, "insert");
  assert.equal(mutations[1].vars.object.book_id, 427537);
  assert.equal(mutations[1].vars.object.edition_id, 32116755);
  assert.equal(res.changes.length, 2);
  assert.deepEqual(res.changes[0].metadata.tags, ["Hardcover: Read"]);
  assert.equal(res.changes[0].metadata.rating, 9);
}

console.log("dalibre-hardcover unit tests passed!");
