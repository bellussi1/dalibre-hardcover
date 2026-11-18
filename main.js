// @ts-check
// Hardcover (https://hardcover.app/) metadata source and reading-status sync
// plugin for Dalibre, using Hardcover's GraphQL API v1.

const API = "https://api.hardcover.app/v1/graphql";
const MAX_CANDIDATES = 12;

/** @type {Record<number, { tag: string, group: string }>} */
const STATUS_INFO = {
  1: { tag: "Want to Read", group: "Want to Read" },
  2: { tag: "Reading", group: "Currently Reading" },
  3: { tag: "Read", group: "Read" },
  4: { tag: "Paused", group: "Paused" },
  5: { tag: "DNF", group: "Did Not Finish" },
};

const BOOK_FIELDS_GQL = `
  id
  title
  slug
  description
  release_year
  rating
  ratings_count
  cached_tags
  image { url }
  contributions { author { name } }
  book_series { position series { name } }
  editions(limit: 60, order_by: {users_count: desc}) {
    id
    title
    isbn_13
    isbn_10
    pages
    release_date
    image { url }
    publisher { name }
    language { code2 }
  }
`;

/**
 * Look up book metadata candidates in Hardcover by id, ISBN, or title & authors.
 * @param {Dalibre.Book} book
 * @returns {Promise<Dalibre.Candidate[]>}
 */
export async function identify(book) {
  const ids = book?.identifiers ?? {};
  const authors = book?.authors ?? [];
  const title = String(book?.title ?? "").trim();
  const preferredLang = book?.language;

  if (ids.hardcover && /^\d+$/.test(ids.hardcover.trim())) {
    const id = Number(ids.hardcover.trim());
    const data = await graphql(
      `query ($id: Int!) { books(where: {id: {_eq: $id}}, limit: 1) { ${BOOK_FIELDS_GQL} } }`,
      { id },
    );
    const items = data?.books ?? [];
    if (items.length > 0) {
      const c = toCandidate(items[0], "", preferredLang);
      return c ? [c] : [];
    }
  }

  const isbn = cleanISBN(ids.isbn ?? "");
  if (isbn) {
    const data = await graphql(
      `query ($isbn: String!) {
        books(where: {editions: {_or: [{isbn_13: {_eq: $isbn}}, {isbn_10: {_eq: $isbn}}]}}, limit: 5) {
          ${BOOK_FIELDS_GQL}
        }
      }`,
      { isbn },
    );
    const items = data?.books ?? [];
    if (items.length > 0) {
      return items
        .map((/** @type {any} */ b) => toCandidate(b, isbn, preferredLang))
        .filter((/** @type {Dalibre.Candidate | null} */ c) => c !== null)
        .slice(0, MAX_CANDIDATES);
    }
  }

  if (!title) return [];

  const firstAuthor = authors[0]?.trim() ?? "";
  let hits = await searchBookHits(firstAuthor ? `${title} ${firstAuthor}` : title);
  if (hits.length === 0 && firstAuthor) {
    hits = await searchBookHits(title);
  }
  if (hits.length === 0) return [];

  const hitIds = [];
  const hitRank = new Map();
  for (let i = 0; i < hits.length; i++) {
    const id = Number(hits[i]?.document?.id);
    if (Number.isInteger(id) && id > 0 && !hitRank.has(id)) {
      hitRank.set(id, i);
      hitIds.push(id);
      if (hitIds.length >= MAX_CANDIDATES) break;
    }
  }
  if (hitIds.length === 0) return [];

  const data = await graphql(
    `query ($ids: [Int!]!) { books(where: {id: {_in: $ids}}) { ${BOOK_FIELDS_GQL} } }`,
    { ids: hitIds },
  );
  const fetched = /** @type {any[]} */ (data?.books ?? []);
  fetched.sort((a, b) => (hitRank.get(a.id) ?? 999) - (hitRank.get(b.id) ?? 999));

  return fetched
    .map((b) => toCandidate(b, "", preferredLang))
    .filter((/** @type {Dalibre.Candidate | null} */ c) => c !== null)
    .slice(0, MAX_CANDIDATES);
}

/**
 * Run a Hardcover library sync or status-update action.
 * @param {string} action
 * @param {Dalibre.ActionInput} input
 * @returns {Promise<Dalibre.ActionResult | null>}
 */
export async function run(action, input) {
  if (action === "sync-from-hardcover") {
    return runSyncFromHardcover();
  }
  if (action === "set-hardcover-status") {
    return runSetStatus(input?.books ?? []);
  }
  throw dalibre.error("invalid", `Unknown action ${action}.`);
}

/**
 * Pull Hardcover reading shelves/progress and map them onto the open Dalibre library.
 * @returns {Promise<Dalibre.ActionResult>}
 */
async function runSyncFromHardcover() {
  const answers = await dalibre.form({
    submit: "Sync from Hardcover",
    remember: true,
    fields: [
      { key: "syncTags", title: "Add status tags (Reading, Want to Read, Read, DNF)", type: "toggle", value: true },
      { key: "syncRatings", title: "Import missing book ratings from Hardcover", type: "toggle", value: true },
      { key: "fillMissingIsbn", title: "Fill missing ISBN from matched Hardcover edition", type: "toggle", value: true },
    ],
  });

  const syncTags = answers.syncTags !== false && answers.syncTags !== "false";
  const syncRatings = answers.syncRatings !== false && answers.syncRatings !== "false";
  const fillMissingIsbn = answers.fillMissingIsbn !== false && answers.fillMissingIsbn !== "false";
  const prefix = statusTagPrefix();

  const { username, userBooks } = await fetchMyUserBooks();
  if (userBooks.length === 0) {
    return { message: `No books found on Hardcover (@${username || "me"})` };
  }

  const index = buildHardcoverIndex(userBooks);

  /** @type {Map<number, { title: string, books: { id: number, note?: string }[] }>} */
  const groupsByStatus = new Map([
    [2, { title: "Currently Reading", books: [] }],
    [1, { title: "Want to Read", books: [] }],
    [3, { title: "Read", books: [] }],
    [4, { title: "Paused", books: [] }],
    [5, { title: "Did Not Finish", books: [] }],
  ]);

  /** @type {{ book: number, metadata: Dalibre.Changes }[]} */
  const changes = [];
  let matchedCount = 0;
  let totalRead = 0;

  for await (const book of dalibre.library.books()) {
    dalibre.progress(++totalRead, 0);
    const ub = matchLibraryBook(book, index);
    if (!ub) continue;

    matchedCount++;
    const statusId = Number(ub.status_id || 0);
    const info = STATUS_INFO[statusId];
    if (info) {
      if (!groupsByStatus.has(statusId)) groupsByStatus.set(statusId, { title: info.group, books: [] });
      groupsByStatus.get(statusId)?.books.push({ id: book.id, note: formatProgressNote(ub) });
    }

    const metadata = buildSyncPatch(book, ub, { prefix, syncTags, syncRatings, fillMissingIsbn });
    if (metadata) changes.push({ book: book.id, metadata });
  }

  const groups = [...groupsByStatus.values()].filter((g) => g.books.length > 0);
  if (matchedCount === 0) {
    return { message: `Checked ${userBooks.length} Hardcover books; none matched in this library` };
  }
  const msg = `${matchedCount} matched on Hardcover` + (changes.length ? `, ${changes.length} to update` : "");
  return { message: msg, groups, changes };
}

/**
 * Push a reading status (and optional rating) from selected Dalibre books to Hardcover.
 * @param {Dalibre.BookInfo[]} books
 * @returns {Promise<Dalibre.ActionResult>}
 */
async function runSetStatus(books) {
  if (!books.length) throw dalibre.error("invalid", "Choose at least one book.");

  const answers = await dalibre.form({
    submit: "Update Hardcover",
    remember: true,
    fields: [
      {
        key: "status",
        title: "Shelf status",
        type: "select",
        value: "2",
        options: [
          { value: "2", title: "Currently Reading" },
          { value: "1", title: "Want to Read" },
          { value: "3", title: "Read" },
          { value: "5", title: "Did Not Finish" },
        ],
      },
      {
        key: "rating",
        title: "Rating (optional)",
        type: "select",
        value: "keep",
        options: [
          { value: "keep", title: "Keep existing" },
          { value: "5", title: "5 / 5" },
          { value: "4.5", title: "4.5 / 5" },
          { value: "4", title: "4 / 5" },
          { value: "3.5", title: "3.5 / 5" },
          { value: "3", title: "3 / 5" },
          { value: "2.5", title: "2.5 / 5" },
          { value: "2", title: "2 / 5" },
          { value: "1.5", title: "1.5 / 5" },
          { value: "1", title: "1 / 5" },
          { value: "0.5", title: "0.5 / 5" },
        ],
      },
    ],
  });

  const statusId = Number(answers.status);
  const info = STATUS_INFO[statusId];
  if (!info) throw dalibre.error("invalid", "Choose a valid Hardcover status.");
  const ratingVal = answers.rating && answers.rating !== "keep" ? Number(answers.rating) : null;
  const prefix = statusTagPrefix();

  const { userBooks } = await fetchMyUserBooks();
  /** @type {Map<number, any>} */
  const existingByBookId = new Map();
  for (const ub of userBooks) {
    const bid = Number(ub?.book?.id);
    if (bid > 0) existingByBookId.set(bid, ub);
  }

  /** @type {{ book: Dalibre.BookInfo, hcBookId: number, editionId?: number, isbn?: string }[]} */
  const resolved = [];
  const missingDetailsIds = [];
  let skipped = 0;

  for (let i = 0; i < books.length; i++) {
    dalibre.progress(i + 1, books.length);
    const b = books[i];
    let hcBookId = Number(b.identifiers?.hardcover ?? 0);
    let isbn = cleanISBN(b.identifiers?.isbn ?? "");

    if (!hcBookId) {
      const cands = await identify({
        title: b.title,
        authors: b.authors ?? [],
        identifiers: b.identifiers ?? {},
        language: b.languages?.[0],
      });
      if (cands[0]?.identifiers?.hardcover) {
        hcBookId = Number(cands[0].identifiers.hardcover);
        if (!isbn && cands[0].identifiers.isbn) isbn = cleanISBN(cands[0].identifiers.isbn);
      }
    }

    if (!hcBookId) {
      skipped++;
      continue;
    }

    const existing = existingByBookId.get(hcBookId);
    let editionId = existing?.edition_id ? Number(existing.edition_id) : undefined;
    if (!existing && !editionId) missingDetailsIds.push(hcBookId);
    resolved.push({ book: b, hcBookId, editionId, isbn: isbn || undefined });
  }

  if (missingDetailsIds.length > 0) {
    const detailsData = await graphql(
      `query ($ids: [Int!]!) {
        books(where: {id: {_in: $ids}}) {
          id
          editions(limit: 60, order_by: {users_count: desc}) { id isbn_13 isbn_10 image { url } publisher { name } language { code2 } }
        }
      }`,
      { ids: [...new Set(missingDetailsIds)] },
    );
    const byId = new Map((detailsData?.books ?? []).map((/** @type {any} */ b) => [Number(b.id), b]));
    for (const item of resolved) {
      if (item.editionId) continue;
      const hb = byId.get(item.hcBookId);
      const ed = hb ? pickBestEdition(hb.editions ?? [], item.isbn ?? "", item.book.languages?.[0]) : null;
      if (ed?.id) item.editionId = Number(ed.id);
    }
  }

  /** @type {{ book: number, metadata: Dalibre.Changes }[]} */
  const changes = [];
  let updated = 0;

  for (const item of resolved) {
    const existing = existingByBookId.get(item.hcBookId);
    /** @type {Record<string, any>} */
    const obj = { status_id: statusId };
    if (ratingVal !== null && Number.isFinite(ratingVal)) obj.rating = ratingVal;
    if (item.editionId) obj.edition_id = item.editionId;

    if (existing?.id) {
      const res = await graphql(
        `mutation ($id: Int!, $object: UserBookUpdateInput!) {
          update_user_book(id: $id, object: $object) { id error }
        }`,
        { id: Number(existing.id), object: obj },
      );
      if (res?.update_user_book?.error) throw new Error(String(res.update_user_book.error));
    } else {
      const insertObj = { ...obj, book_id: item.hcBookId };
      const res = await graphql(
        `mutation ($object: UserBookCreateInput!) {
          insert_user_book(object: $object) { id error }
        }`,
        { object: insertObj },
      );
      if (res?.insert_user_book?.error) throw new Error(String(res.insert_user_book.error));
    }
    updated++;

    /** @type {Dalibre.Changes} */
    const meta = {};
    let hasMeta = false;
    /** @type {Record<string, string>} */
    const idsDelta = {};
    let hasIdsDelta = false;
    if (String(item.book.identifiers?.hardcover ?? "") !== String(item.hcBookId)) {
      idsDelta.hardcover = String(item.hcBookId);
      hasIdsDelta = true;
    }
    if (item.isbn && !cleanISBN(item.book.identifiers?.isbn ?? "")) {
      idsDelta.isbn = item.isbn;
      hasIdsDelta = true;
    }
    if (hasIdsDelta) {
      meta.identifiers = idsDelta;
      hasMeta = true;
    }
    if (prefix) {
      const nextTags = mergeStatusTag(item.book.tags ?? [], prefix, info.tag);
      if (nextTags) {
        meta.tags = nextTags;
        hasMeta = true;
      }
    }
    if (ratingVal !== null && Number.isFinite(ratingVal)) {
      const calRating = Math.max(0, Math.min(10, Math.round(ratingVal * 2)));
      if (calRating !== Number(item.book.rating ?? 0)) {
        meta.rating = calRating;
        hasMeta = true;
      }
    }
    if (hasMeta) changes.push({ book: item.book.id, metadata: meta });
  }

  const msg = `${updated} updated on Hardcover (${info.group})` + (skipped ? `, ${skipped} not found` : "");
  return { message: msg, changes };
}

/**
 * Execute a Hardcover GraphQL query or mutation.
 * @param {string} query
 * @param {Record<string, any>} [variables]
 * @returns {Promise<any>}
 */
async function graphql(query, variables = {}) {
  const raw = String(dalibre.settings.apiKey ?? "").trim();
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw dalibre.error("auth", "Add your Hardcover API token in plugin settings.");
  }

  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401 || res.status === 403) {
    throw dalibre.error("auth", "Hardcover rejected the API token.");
  }
  if (res.status === 429) {
    throw dalibre.error("rateLimited", "Hardcover asks to slow down. Try again in a minute.");
  }
  if (res.status >= 500) {
    throw dalibre.error("unavailable", `Hardcover answered ${res.status}.`);
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw dalibre.error("unavailable", "Hardcover sent something that isn’t JSON.");
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const msg = payload.errors.map((/** @type {any} */ e) => e?.message || String(e)).join("; ");
    if (/unauthor|jwt|token|permission|access-denied/i.test(msg)) {
      throw dalibre.error("auth", `Hardcover rejected the API token: ${msg}`);
    }
    if (/rate.?limit/i.test(msg)) {
      throw dalibre.error("rateLimited", msg);
    }
    throw new Error(`Hardcover error: ${msg}`);
  }

  if (!res.ok) {
    throw new Error(`Hardcover answered ${res.status} ${res.statusText}`);
  }
  return payload?.data ?? {};
}

/** @param {string} q @returns {Promise<any[]>} */
async function searchBookHits(q) {
  const data = await graphql(
    `query ($q: String!) {
      search(query: $q, query_type: "Book", per_page: 10) { results }
    }`,
    { q },
  );
  return data?.search?.results?.hits ?? [];
}

/** @returns {Promise<{ username: string, userBooks: any[] }>} */
async function fetchMyUserBooks() {
  const data = await graphql(`query {
    me {
      id
      username
      user_books(limit: 500, order_by: {updated_at: desc}) {
        id
        status_id
        rating
        edition_id
        edition { id title isbn_13 isbn_10 language { code2 } }
        book { id title slug contributions { author { name } } }
        user_book_reads(limit: 1, order_by: {id: desc}) { progress progress_pages }
      }
    }
  }`);
  const me = data?.me?.[0];
  return {
    username: String(me?.username ?? ""),
    userBooks: /** @type {any[]} */ (me?.user_books ?? []),
  };
}

/**
 * Convert a Hardcover book + chosen edition into a Dalibre metadata Candidate.
 * @param {any} b @param {string} targetIsbn @param {string | undefined} preferredLang
 * @returns {Dalibre.Candidate | null}
 */
function toCandidate(b, targetIsbn, preferredLang) {
  if (!b?.id || !b?.title) return null;
  const ed = pickBestEdition(b.editions ?? [], targetIsbn, preferredLang);

  const authors = (b.contributions ?? [])
    .map((/** @type {any} */ c) => String(c?.author?.name ?? "").trim())
    .filter(Boolean);

  /** @type {Record<string, string>} */
  const identifiers = { hardcover: String(b.id) };
  const isbn = cleanISBN(ed?.isbn_13 || ed?.isbn_10 || targetIsbn || "");
  if (isbn) identifiers.isbn = isbn;

  const seriesEntry = b.book_series?.[0];
  const series = seriesEntry?.series?.name ? String(seriesEntry.series.name).trim() : undefined;
  const seriesIndex = typeof seriesEntry?.position === "number" ? seriesEntry.position : undefined;

  const cover = validCoverUrl(ed?.image?.url) ?? validCoverUrl(b.image?.url);
  const rawLang = normalizeLangCode(ed?.language?.code2);
  const pubdate = parseDate(ed?.release_date, b.release_year);

  const tags = [];
  const seen = new Set();
  for (const list of [b.cached_tags?.Genre, b.cached_tags?.Tag]) {
    for (const item of list ?? []) {
      const t = String(item?.tag ?? "").trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        tags.push(t);
        if (tags.length >= 10) break;
      }
    }
    if (tags.length >= 10) break;
  }

  /** @type {Dalibre.Field[]} */
  const fields = [];
  if (typeof b.rating === "number" && b.rating > 0) {
    fields.push({
      label: "Rating",
      value: `${b.rating.toFixed(1)} / 5` + (b.ratings_count ? ` (${b.ratings_count} ratings)` : ""),
    });
  }
  if (typeof ed?.pages === "number" && ed.pages > 0) fields.push({ label: "Pages", value: String(ed.pages) });
  if (ed?.id) fields.push({ label: "Edition", value: String(ed.id) });

  return {
    id: String(b.id),
    title: String(ed?.title || b.title).trim(),
    authors: [...new Set(authors)],
    description: cleanText(b.description),
    publisher: cleanText(ed?.publisher?.name),
    language: rawLang,
    pubdate,
    series,
    seriesIndex,
    tags,
    identifiers,
    cover,
    url: b.slug ? `https://hardcover.app/books/${b.slug}` : undefined,
    fields: fields.slice(0, 12),
  };
}

/**
 * Pick the best matching edition (exact ISBN > preferred language/BR ISBN > cover+publisher).
 * @param {any[]} editions @param {string} targetIsbn @param {string | undefined} preferredLang
 * @returns {any | null}
 */
function pickBestEdition(editions, targetIsbn, preferredLang) {
  if (!Array.isArray(editions) || editions.length === 0) return null;
  if (targetIsbn) {
    const exact = editions.find(
      (e) => cleanISBN(e?.isbn_13 ?? "") === targetIsbn || cleanISBN(e?.isbn_10 ?? "") === targetIsbn,
    );
    if (exact) return exact;
  }

  const pref = normalizeLangCode(preferredLang);
  let best = editions[0];
  let bestScore = -1;

  for (const e of editions) {
    let s = 0;
    const edLang = normalizeLangCode(e?.language?.code2);
    const isbn = cleanISBN(e?.isbn_13 || e?.isbn_10 || "");
    if (pref && edLang === pref) s += 10;
    if (pref === "pt" && (isbn.startsWith("97865") || isbn.startsWith("97885"))) s += 4;
    if (e?.image?.url) s += 2;
    if (e?.publisher?.name) s += 1;
    if (cleanISBN(e?.isbn_13 ?? "")) s += 1;
    if (e?.release_date) s += 0.5;
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return best;
}

/** @param {any[]} userBooks */
function buildHardcoverIndex(userBooks) {
  const byHcId = new Map();
  const byIsbn = new Map();
  const byExactTitleAuthor = new Map();
  const byNoColonAuthor = new Map();
  const byColonBaseAuthor = new Map();

  for (const ub of userBooks) {
    const hid = ub?.book?.id ? String(ub.book.id) : "";
    if (hid) byHcId.set(hid, ub);
    for (const raw of [ub?.edition?.isbn_13, ub?.edition?.isbn_10]) {
      const c = cleanISBN(raw ?? "");
      if (c && !byIsbn.has(c)) byIsbn.set(c, ub);
      const c13 = toISBN13(raw ?? "");
      if (c13 && !byIsbn.has(c13)) byIsbn.set(c13, ub);
    }
    const hcAuthors = (ub?.book?.contributions ?? []).map((/** @type {any} */ c) => canonicalAuthor(c?.author?.name ?? "")).filter(Boolean);
    for (const rawTitle of [ub?.book?.title, ub?.edition?.title]) {
      const s = String(rawTitle ?? "").trim();
      const nt = normTitle(s);
      if (!nt) continue;
      const hasColon = s.includes(":");
      const base = hasColon ? normTitle(s.split(":")[0]) : nt;
      for (const a of hcAuthors) {
        const key = `${nt}\0${a}`;
        if (!byExactTitleAuthor.has(key)) byExactTitleAuthor.set(key, ub);
        if (!hasColon) {
          const ncKey = `${nt}\0${a}`;
          if (!byNoColonAuthor.has(ncKey)) byNoColonAuthor.set(ncKey, ub);
        } else if (base.length >= 5) {
          const cbKey = `${base}\0${a}`;
          if (!byColonBaseAuthor.has(cbKey)) byColonBaseAuthor.set(cbKey, ub);
        }
      }
    }
  }
  return { byHcId, byIsbn, byExactTitleAuthor, byNoColonAuthor, byColonBaseAuthor };
}

/** @param {Dalibre.BookInfo} book @param {ReturnType<typeof buildHardcoverIndex>} index */
function matchLibraryBook(book, index) {
  const hid = String(book.identifiers?.hardcover ?? "").trim();
  if (hid && index.byHcId.has(hid)) return index.byHcId.get(hid);

  const isbn = cleanISBN(book.identifiers?.isbn ?? "");
  if (isbn) {
    if (index.byIsbn.has(isbn)) return index.byIsbn.get(isbn);
    const i13 = toISBN13(isbn);
    if (i13 && index.byIsbn.has(i13)) return index.byIsbn.get(i13);
  }

  const authors = (book.authors ?? []).map(canonicalAuthor).filter(Boolean);
  const rawTitle = String(book.title ?? "");
  const fullTitle = normTitle(rawTitle);
  const hasColon = rawTitle.includes(":");
  const baseTitle = hasColon ? normTitle(rawTitle.split(":")[0]) : fullTitle;

  for (const a of authors) {
    if (fullTitle) {
      const exact = index.byExactTitleAuthor.get(`${fullTitle}\0${a}`);
      if (exact) return exact;
    }
    if (hasColon && baseTitle.length >= 5) {
      const subHit = index.byNoColonAuthor.get(`${baseTitle}\0${a}`);
      if (subHit) return subHit;
    } else if (!hasColon && fullTitle.length >= 5) {
      const baseHit = index.byColonBaseAuthor.get(`${fullTitle}\0${a}`);
      if (baseHit) return baseHit;
    }
  }
  return null;
}

/** @param {Dalibre.BookInfo} book */
function bookLangBucket(book) {
  for (const l of book.languages ?? []) {
    const n = normalizeLangCode(l);
    if (n === "pt" || n === "en") return n;
  }
  for (const t of book.tags ?? []) {
    const u = String(t).trim().toUpperCase();
    if (u === "PT-BR" || u === "PT-PT" || u === "PT") return "pt";
    if (u === "EN" || u === "ENG") return "en";
  }
  return "";
}

/**
 * Compute non-destructive Dalibre metadata updates for a matched Hardcover user_book.
 * @param {Dalibre.BookInfo} book
 * @param {any} ub
 * @param {{ prefix: string, syncTags: boolean, syncRatings: boolean, fillMissingIsbn: boolean }} opts
 * @returns {Dalibre.Changes | null}
 */
function buildSyncPatch(book, ub, opts) {
  /** @type {Dalibre.Changes} */
  const meta = {};
  let changed = false;

  /** @type {Record<string, string>} */
  const idsDelta = {};
  let hasIdsDelta = false;
  const targetHc = String(ub.book?.id ?? "");
  const edIsbn = cleanISBN(ub.edition?.isbn_13 || ub.edition?.isbn_10 || "");
  if (targetHc && String(book.identifiers?.hardcover ?? "") !== targetHc) {
    idsDelta.hardcover = targetHc;
    hasIdsDelta = true;
  }
  if (opts.fillMissingIsbn && edIsbn && !cleanISBN(book.identifiers?.isbn ?? "")) {
    const bLang = bookLangBucket(book);
    const eLang = normalizeLangCode(ub.edition?.language?.code2);
    if (!bLang || !eLang || bLang === eLang) {
      idsDelta.isbn = edIsbn;
      hasIdsDelta = true;
    }
  }
  if (hasIdsDelta) {
    meta.identifiers = idsDelta;
    changed = true;
  }

  const info = STATUS_INFO[Number(ub.status_id || 0)];
  if (opts.syncTags && opts.prefix && info) {
    const nextTags = mergeStatusTag(book.tags ?? [], opts.prefix, info.tag);
    if (nextTags) {
      meta.tags = nextTags;
      changed = true;
    }
  }

  if (opts.syncRatings && typeof ub.rating === "number" && ub.rating > 0 && !(Number(book.rating ?? 0) > 0)) {
    const calRating = Math.max(0, Math.min(10, Math.round(ub.rating * 2)));
    if (calRating > 0) {
      meta.rating = calRating;
      changed = true;
    }
  }

  return changed ? meta : null;
}

/** @param {string[]} current @param {string} prefix @param {string} label */
function mergeStatusTag(current, prefix, label) {
  const target = `${prefix}${label}`;
  const lowerPrefix = prefix.toLowerCase();
  const kept = current.filter((t) => !t.toLowerCase().startsWith(lowerPrefix));
  if (current.includes(target) && kept.length === current.length - 1) return null;
  return [...kept, target];
}

/** @param {any} ub */
function formatProgressNote(ub) {
  const parts = [];
  const read = ub?.user_book_reads?.[0];
  if (typeof read?.progress === "number" && read.progress > 0) {
    parts.push(`${Math.round(read.progress)}%`);
  }
  if (typeof read?.progress_pages === "number" && read.progress_pages > 0) {
    parts.push(`p. ${read.progress_pages}`);
  }
  if (typeof ub?.rating === "number" && ub.rating > 0) {
    parts.push(`${ub.rating}/5★`);
  }
  return parts.join(" · ") || undefined;
}

function statusTagPrefix() {
  const raw = dalibre.settings.tagPrefix;
  if (raw === undefined) return "Hardcover: ";
  const str = String(raw);
  return str.trim() ? str : "";
}

/** @param {unknown} raw */
function normalizeLangCode(raw) {
  if (typeof raw !== "string") return undefined;
  const c = raw.trim().toLowerCase().split(/[-_]/)[0];
  if (!c) return undefined;
  if (c === "pb" || c === "por") return "pt";
  if (c === "eng") return "en";
  return c;
}

/** @param {unknown} rel @param {unknown} year */
function parseDate(rel, year) {
  const s = typeof rel === "string" ? rel.trim() : "";
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return s;
  const y = year != null ? String(year).trim() : "";
  return /^\d{4}$/.test(y) ? y : undefined;
}

/** @param {unknown} raw */
function validCoverUrl(raw) {
  if (typeof raw !== "string") return undefined;
  const u = raw.trim().replace(/^http:\/\//i, "https://");
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:" && parsed.hostname === "assets.hardcover.app") return u;
  } catch {}
  return undefined;
}

/** @param {unknown} raw */
function cleanText(raw) {
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(/\r\n?/g, "\n").trim();
  return s || undefined;
}

/** @param {string} raw */
function cleanISBN(raw) {
  const s = String(raw).replace(/[^0-9Xx]/g, "").toUpperCase();
  return s.length === 10 || s.length === 13 ? s : "";
}

/** @param {string} raw */
function toISBN13(raw) {
  const s = cleanISBN(raw);
  if (s.length === 13) return s;
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
    const core = `978${s.slice(0, 9)}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
    return core + String((10 - (sum % 10)) % 10);
  }
  return "";
}

/** @param {string} s */
function normTitle(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Normalize both "First Last" and Calibre's "Last, First" into sorted tokens. @param {string} s */
function canonicalAuthor(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}
