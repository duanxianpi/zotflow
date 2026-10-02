/**
 * `db/normalize` — the API-payload → IDB-record boundary (pure functions).
 *
 * Written ahead of the lint cleanup of this module, which replaces its `any`
 * casts with real types. Everything here pins *current* behaviour, including
 * the rough edges (see "documented quirks"), so that the retype can be judged
 * on whether it preserves behaviour rather than on whether it looks tidier.
 */
import { describe, test, expect, vi, afterEach } from "vitest";

import {
    normalizeItem,
    normalizeCollection,
    toZoteroDate,
} from "db/normalize";

import type { ZoteroCollection, ZoteroItem } from "types/zotero";
import type {
    ZoteroItemData,
    ZoteroItemDataTypeMap,
} from "types/zotero-item";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LIBRARY_ID = 42;

/** The fields `BaseZoteroItemData` requires of every item type. */
const baseData = {
    key: "ITEM0001",
    version: 7,
    dateAdded: "2020-01-01T00:00:00Z",
    dateModified: "2020-02-02T00:00:00Z",
    tags: [] as Array<{ tag: string; type?: number }>,
    relations: {},
    deleted: false,
};

/**
 * Wraps item data in the API response envelope. Only `data` and `csljson`
 * matter to `normalizeItem`; the rest is filled in so the value really is a
 * `ZoteroItem<T>` rather than a cast.
 */
function envelope<T extends ZoteroItemData>(
    data: T,
    csljson?: Record<string, unknown>,
): ZoteroItem<T> {
    return {
        key: data.key,
        version: data.version,
        library: { type: "user", id: LIBRARY_ID, name: "Test", links: {} },
        links: {},
        meta: { numChildren: 0 },
        data,
        ...(csljson ? { csljson } : {}),
    };
}

/** Builds an item of type `K`, with `overrides` merged over the base fields. */
function item<K extends keyof ZoteroItemDataTypeMap>(
    itemType: K,
    overrides: Partial<ZoteroItemDataTypeMap[K]> = {},
    csljson?: Record<string, unknown>,
): ZoteroItem<ZoteroItemDataTypeMap[K]> {
    const data = {
        ...baseData,
        itemType,
        ...overrides,
    } as ZoteroItemDataTypeMap[K];
    return envelope(data, csljson);
}

const article = (
    overrides: Partial<ZoteroItemDataTypeMap["journalArticle"]> = {},
    csljson?: Record<string, unknown>,
) => item("journalArticle", overrides, csljson);

/** Attachments need `linkMode`/`contentType`/`filename` beyond the base. */
const attachment = (
    overrides: Partial<ZoteroItemDataTypeMap["attachment"]> = {},
) =>
    item("attachment", {
        linkMode: "imported_file",
        contentType: "application/pdf",
        filename: "paper.pdf",
        ...overrides,
    });

const note = (overrides: Partial<ZoteroItemDataTypeMap["note"]> = {}) =>
    item("note", { note: "", ...overrides });

const annotation = (
    overrides: Partial<ZoteroItemDataTypeMap["annotation"]> = {},
) =>
    item("annotation", {
        annotationType: "highlight",
        annotationText: "quoted",
        annotationComment: "",
        annotationColor: "#ffd400",
        annotationPageLabel: "1",
        annotationSortIndex: "00000|000000|00000",
        annotationPosition: "{}",
        ...overrides,
    });

// ---------------------------------------------------------------------------
// normalizeItem — title
// ---------------------------------------------------------------------------

describe("normalizeItem: title", () => {
    test("attachment prefers filename over title", () => {
        const out = normalizeItem(
            attachment({ filename: "paper.pdf", title: "Nice Title" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("paper.pdf");
    });

    test("attachment falls back to title when filename is empty", () => {
        const out = normalizeItem(
            attachment({ filename: "", title: "Nice Title" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("Nice Title");
    });

    test("attachment with neither filename nor title yields empty string", () => {
        const out = normalizeItem(
            attachment({ filename: "", title: "" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("");
    });

    test("note strips HTML tags and uses the first line", () => {
        const out = normalizeItem(
            note({ note: "<p>Hello <b>world</b></p>\n<p>second line</p>" }),
            LIBRARY_ID,
        );
        // Stripping the inner <b> leaves a run of spaces, which is collapsed.
        expect(out.title).toBe("Hello world");
    });

    test("block tags end the first line even without a literal newline", () => {
        // Zotero note bodies are a single line of HTML; the line structure is
        // carried entirely by the block tags.
        const out = normalizeItem(
            note({ note: "<p>First para</p><p>Second para</p>" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("First para");
    });

    test.each([
        ["<br>", "<p>One<br>Two</p>"],
        ["<br/>", "<p>One<br/>Two</p>"],
        ["</li>", "<ul><li>One</li><li>Two</li></ul>"],
        ["</h1>", "<h1>One</h1><p>Two</p>"],
        ["</div>", "<div>One</div><div>Two</div>"],
    ])("%s ends the first line", (_label, body) => {
        expect(normalizeItem(note({ note: body }), LIBRARY_ID).title).toBe(
            "One",
        );
    });

    test("leading markup does not consume the 50-character budget", () => {
        const out = normalizeItem(
            note({ note: `<p>${" ".repeat(60)}Real title</p>` }),
            LIBRARY_ID,
        );
        // Truncating before trimming used to throw the title away entirely.
        expect(out.title).toBe("Real title");
    });

    test("the space left by leading markup does not shorten a full title", () => {
        // Collapsing leaves exactly one leading space, so this is only
        // observable once the content itself reaches the 50-char cap: without
        // trimming first, that space costs one character of real title.
        const out = normalizeItem(
            note({ note: `<p>   ${"y".repeat(60)}</p>` }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("y".repeat(50));
    });

    test("note title is capped at 50 characters", () => {
        const body = "x".repeat(80);
        const out = normalizeItem(note({ note: body }), LIBRARY_ID);
        expect(out.title).toBe("x".repeat(50));
    });

    test("a cut landing on a space leaves no trailing space", () => {
        // Character 49 is the space, so the 50-char slice ends on it.
        const out = normalizeItem(
            note({ note: `${"x".repeat(49)} tail` }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("x".repeat(49));
    });

    test("empty note falls back to `Note <key>`", () => {
        const out = normalizeItem(
            note({ key: "NOTEKEY1", note: "" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("Note NOTEKEY1");
    });

    test("note of only markup falls back to `Note <key>`", () => {
        const out = normalizeItem(
            note({ key: "NOTEKEY2", note: "<p></p>" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("Note NOTEKEY2");
    });

    test.each([
        ["&amp;", "Tea &amp; Coffee", "Tea & Coffee"],
        ["&lt; and &gt;", "a &lt;b&gt; c", "a <b> c"],
        ["&quot;", "say &quot;hi&quot;", 'say "hi"'],
        ["&apos;", "it&apos;s", "it's"],
        ["decimal &#65;", "&#65;lpha", "Alpha"],
        ["hex &#x41;", "&#x41;lpha", "Alpha"],
        ["uppercase &#X41;", "&#X41;lpha", "Alpha"],
        // HTML5 keeps the all-caps spellings as legacy aliases.
        ["uppercase &AMP;", "Tea &AMP; Coffee", "Tea & Coffee"],
        ["mixed-case &Quot;", "say &Quot;hi&Quot;", 'say "hi"'],
    ])("decodes %s in note titles", (_label, body, expected) => {
        expect(normalizeItem(note({ note: `<p>${body}</p>` }), LIBRARY_ID).title)
            .toBe(expected);
    });

    test("&nbsp; is decoded and then folded into a normal space", () => {
        const out = normalizeItem(
            note({ note: "<p>Tea&nbsp;&nbsp;Coffee</p>" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("Tea Coffee");
    });

    test("decoding is single-pass, so &amp;lt; does not become a tag", () => {
        const out = normalizeItem(
            note({ note: "<p>&amp;lt;script&amp;gt;</p>" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("&lt;script&gt;");
    });

    test("a decoded &lt;p&gt; is not re-read as markup", () => {
        const out = normalizeItem(
            note({ note: "<p>&lt;p&gt;literal&lt;/p&gt;</p>" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("<p>literal</p>");
    });

    test.each([
        ["an unknown named entity", "&copy; 2020", "&copy; 2020"],
        ["an out-of-range code point", "&#99999999;x", "&#99999999;x"],
        // Decoding this to a literal NUL would smuggle a control character
        // into an indexed field.
        ["a null code point", "&#0;x", "&#0;x"],
        ["a null hex code point", "&#x0;x", "&#x0;x"],
        ["a bare ampersand", "AT&T", "AT&T"],
    ])("leaves %s untouched", (_label, body, expected) => {
        expect(normalizeItem(note({ note: `<p>${body}</p>` }), LIBRARY_ID).title)
            .toBe(expected);
    });

    test("a numeric newline reference collapses instead of truncating", () => {
        const out = normalizeItem(
            note({ note: "<p>One&#10;Two</p>" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("One Two");
    });

    test("annotation gets no title", () => {
        const out = normalizeItem(annotation(), LIBRARY_ID);
        expect(out.title).toBe("");
    });

    test("regular item uses its title field", () => {
        const out = normalizeItem(
            article({ title: "On Widgets" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("On Widgets");
    });

    test("regular item without a title yields empty string", () => {
        const out = normalizeItem(article({ title: undefined }), LIBRARY_ID);
        expect(out.title).toBe("");
    });

    // Zotero shows these types' base-mapped stand-in as the title.
    test("a case takes its title from caseName", () => {
        const out = normalizeItem(
            item("case", { caseName: "Roe v. Wade" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("Roe v. Wade");
    });

    test("a statute takes its title from nameOfAct", () => {
        const out = normalizeItem(
            item("statute", { nameOfAct: "Clean Air Act" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("Clean Air Act");
    });

    test("an email takes its title from subject", () => {
        const out = normalizeItem(
            item("email", { subject: "Re: draft" }),
            LIBRARY_ID,
        );
        expect(out.title).toBe("Re: draft");
    });
});

// ---------------------------------------------------------------------------
// normalizeItem — searchCreators
// ---------------------------------------------------------------------------

describe("normalizeItem: searchCreators", () => {
    test("single-field creators use `name` verbatim", () => {
        const out = normalizeItem(
            article({
                creators: [{ creatorType: "author", name: "World Health Org" }],
            }),
            LIBRARY_ID,
        );
        expect(out.searchCreators).toEqual(["World Health Org"]);
    });

    test("two-field creators are joined first-then-last", () => {
        const out = normalizeItem(
            article({
                creators: [
                    { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
                ],
            }),
            LIBRARY_ID,
        );
        expect(out.searchCreators).toEqual(["Ada Lovelace"]);
    });

    test("a missing half does not leave stray whitespace", () => {
        const out = normalizeItem(
            article({
                creators: [
                    { creatorType: "author", lastName: "Knuth" },
                    { creatorType: "author", firstName: "Grace" },
                ],
            }),
            LIBRARY_ID,
        );
        expect(out.searchCreators).toEqual(["Knuth", "Grace"]);
    });

    test("creators with no usable name are skipped entirely", () => {
        const out = normalizeItem(
            article({
                creators: [
                    { creatorType: "author" },
                    { creatorType: "author", lastName: "Real" },
                ],
            }),
            LIBRARY_ID,
        );
        expect(out.searchCreators).toEqual(["Real"]);
    });

    test("`name` wins over firstName/lastName on the same creator", () => {
        const out = normalizeItem(
            article({
                creators: [
                    {
                        creatorType: "author",
                        name: "Combined",
                        firstName: "Ada",
                        lastName: "Lovelace",
                    },
                ],
            }),
            LIBRARY_ID,
        );
        expect(out.searchCreators).toEqual(["Combined"]);
    });

    test("missing creators array yields an empty list", () => {
        const out = normalizeItem(article({ creators: undefined }), LIBRARY_ID);
        expect(out.searchCreators).toEqual([]);
    });

    test.each(["attachment", "note", "annotation"] as const)(
        "%s never carries creators",
        (kind) => {
            // Child types have no `creators` field in the schema, but the API
            // can still echo one back; normalizeItem must ignore it.
            const raw = { attachment, note, annotation }[kind]();
            (raw.data as unknown as Record<string, unknown>).creators = [
                { creatorType: "author", lastName: "Ignored" },
            ];
            expect(normalizeItem(raw, LIBRARY_ID).searchCreators).toEqual([]);
        },
    );
});

// ---------------------------------------------------------------------------
// normalizeItem — searchTags
// ---------------------------------------------------------------------------

describe("normalizeItem: searchTags", () => {
    test("tag objects are flattened to their `tag` string", () => {
        const out = normalizeItem(
            article({ tags: [{ tag: "physics" }, { tag: "ml", type: 1 }] }),
            LIBRARY_ID,
        );
        expect(out.searchTags).toEqual(["physics", "ml"]);
    });

    test("entries without a `tag` are skipped", () => {
        const out = normalizeItem(
            article({
                tags: [{ tag: "" }, { tag: "kept" }] as ZoteroItemDataTypeMap["journalArticle"]["tags"],
            }),
            LIBRARY_ID,
        );
        expect(out.searchTags).toEqual(["kept"]);
    });

    test("a missing tags array yields an empty list", () => {
        const raw = article();
        delete (raw.data as unknown as Record<string, unknown>).tags;
        expect(normalizeItem(raw, LIBRARY_ID).searchTags).toEqual([]);
    });

    test("tags on child types are still collected", () => {
        const out = normalizeItem(
            annotation({ tags: [{ tag: "important" }] }),
            LIBRARY_ID,
        );
        expect(out.searchTags).toEqual(["important"]);
    });
});

// ---------------------------------------------------------------------------
// normalizeItem — citationKey
// ---------------------------------------------------------------------------

describe("normalizeItem: citationKey", () => {
    test("an explicit citationKey field is used as-is", () => {
        const out = normalizeItem(
            article({ citationKey: "lovelace1843" }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBe("lovelace1843");
    });

    test("falls back to `Citation Key:` inside extra", () => {
        const out = normalizeItem(
            article({ extra: "Citation Key: knuth1974" }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBe("knuth1974");
    });

    test("the explicit field wins over extra", () => {
        const out = normalizeItem(
            article({ citationKey: "explicit", extra: "Citation Key: fromExtra" }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBe("explicit");
    });

    test("finds the key among other extra lines", () => {
        const out = normalizeItem(
            article({ extra: "tex.ids: a\nCitation Key: abc_1\nPMID: 9" }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBe("abc_1");
    });

    test("undefined when there is neither a field nor a match", () => {
        const out = normalizeItem(
            article({ extra: "PMID: 12345" }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBeUndefined();
    });

    test("undefined when extra is absent entirely", () => {
        const out = normalizeItem(article({ extra: undefined }), LIBRARY_ID);
        expect(out.citationKey).toBeUndefined();
    });

    test.each([
        ["hyphens", "smith-2020"],
        ["dots", "Smith.2020"],
        ["colons", "smith:2020a"],
        ["plain word characters", "smith_2020"],
    ])("keeps keys containing %s", (_label, key) => {
        const out = normalizeItem(
            article({ extra: `Citation Key: ${key}` }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBe(key);
    });

    test("the key stops at whitespace, not at the end of extra", () => {
        const out = normalizeItem(
            article({ extra: "Citation Key: smith-2020\ntex.ids: other" }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBe("smith-2020");
    });

    test("tolerates extra spacing after the colon", () => {
        const out = normalizeItem(
            article({ extra: "Citation Key:   smith-2020" }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBe("smith-2020");
    });

    test("undefined when the label has no value after it", () => {
        const out = normalizeItem(
            article({ extra: "Citation Key:\nPMID: 9" }),
            LIBRARY_ID,
        );
        expect(out.citationKey).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// normalizeItem — csljson
// ---------------------------------------------------------------------------

describe("normalizeItem: csljson", () => {
    test("is carried over for citable item types", () => {
        const csl = { type: "article-journal", title: "On Widgets" };
        const out = normalizeItem(article({}, csl), LIBRARY_ID);
        expect(out.csljson).toEqual(csl);
    });

    test("is absent when the API did not return one", () => {
        const out = normalizeItem(article(), LIBRARY_ID);
        expect(out.csljson).toBeUndefined();
    });

    test.each(["attachment", "note", "annotation"] as const)(
        "is dropped for %s, which is not citable",
        (kind) => {
            const raw = { attachment, note, annotation }[kind]();
            raw.csljson = { type: "document" };
            expect(normalizeItem(raw, LIBRARY_ID).csljson).toBeUndefined();
        },
    );
});

// ---------------------------------------------------------------------------
// normalizeItem — scalar mapping and defaults
// ---------------------------------------------------------------------------

describe("normalizeItem: scalar fields", () => {
    test("copies identity and version fields off `data`, not the envelope", () => {
        const raw = article({ key: "DATAKEY1", version: 99 });
        // The envelope carries the same values in the real API; diverge them
        // to prove which side is read.
        raw.key = "ENVKEY01";
        raw.version = 1;

        const out = normalizeItem(raw, LIBRARY_ID);
        expect(out.key).toBe("DATAKEY1");
        expect(out.version).toBe(99);
    });

    test("libraryID comes from the argument, not the payload", () => {
        const out = normalizeItem(article(), 777);
        expect(out.libraryID).toBe(777);
    });

    test("dates are passed through untouched", () => {
        const out = normalizeItem(article(), LIBRARY_ID);
        expect(out.dateAdded).toBe("2020-01-01T00:00:00Z");
        expect(out.dateModified).toBe("2020-02-02T00:00:00Z");
    });

    test("deleted maps to trashed 1, otherwise 0", () => {
        expect(normalizeItem(article({ deleted: true }), LIBRARY_ID).trashed).toBe(1);
        expect(normalizeItem(article({ deleted: false }), LIBRARY_ID).trashed).toBe(0);
    });

    test("parentItem defaults to an empty string", () => {
        expect(normalizeItem(article(), LIBRARY_ID).parentItem).toBe("");
        expect(
            normalizeItem(attachment({ parentItem: "PARENT01" }), LIBRARY_ID)
                .parentItem,
        ).toBe("PARENT01");
    });

    test("collections default to an empty array", () => {
        expect(normalizeItem(article(), LIBRARY_ID).collections).toEqual([]);
        expect(
            normalizeItem(article({ collections: ["COLL0001"] }), LIBRARY_ID)
                .collections,
        ).toEqual(["COLL0001"]);
    });

    test("a freshly normalized item is marked synced", () => {
        const out = normalizeItem(article(), LIBRARY_ID);
        expect(out.syncStatus).toBe("synced");
        expect(out.synced).toBe(1);
        expect(Number.isNaN(Date.parse(out.syncedAt))).toBe(false);
    });

    test("the raw payload is kept by reference", () => {
        const raw = article();
        expect(normalizeItem(raw, LIBRARY_ID).raw).toBe(raw);
    });
});

// ---------------------------------------------------------------------------
// normalizeCollection
// ---------------------------------------------------------------------------

function collection(
    data: Partial<ZoteroCollection["data"]> = {},
): ZoteroCollection {
    return {
        key: "COLL0001",
        version: 3,
        library: { type: "user", id: LIBRARY_ID, name: "Test", links: {} },
        links: {},
        meta: { numItems: 0, numCollections: 0 },
        data: {
            key: "COLL0001",
            version: 3,
            name: "Papers",
            parentCollection: false,
            relations: {},
            deleted: false,
            ...data,
        },
    };
}

describe("normalizeCollection", () => {
    test("maps the indexed fields", () => {
        const out = normalizeCollection(collection(), LIBRARY_ID);
        expect(out).toMatchObject({
            key: "COLL0001",
            libraryID: LIBRARY_ID,
            version: 3,
            name: "Papers",
            parentCollection: "",
            trashed: 0,
            syncStatus: "synced",
            syncError: "",
        });
    });

    test("key and version come from the envelope, name from data", () => {
        const raw = collection({ name: "Nested" });
        raw.key = "ENVCOLL1";
        raw.version = 12;

        const out = normalizeCollection(raw, LIBRARY_ID);
        expect(out.key).toBe("ENVCOLL1");
        expect(out.version).toBe(12);
        expect(out.name).toBe("Nested");
    });

    test("a `false` parentCollection becomes an empty string", () => {
        expect(
            normalizeCollection(collection({ parentCollection: false }), LIBRARY_ID)
                .parentCollection,
        ).toBe("");
    });

    test("a real parentCollection key is preserved", () => {
        expect(
            normalizeCollection(
                collection({ parentCollection: "PARENT01" }),
                LIBRARY_ID,
            ).parentCollection,
        ).toBe("PARENT01");
    });

    test("deleted maps to trashed 1", () => {
        expect(
            normalizeCollection(collection({ deleted: true }), LIBRARY_ID).trashed,
        ).toBe(1);
    });

    test("the raw payload is kept by reference", () => {
        const raw = collection();
        expect(normalizeCollection(raw, LIBRARY_ID).raw).toBe(raw);
    });
});

// ---------------------------------------------------------------------------
// toZoteroDate
// ---------------------------------------------------------------------------

describe("toZoteroDate", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test("drops milliseconds from an ISO string", () => {
        expect(toZoteroDate("2020-05-01T10:20:30.456Z")).toBe(
            "2020-05-01T10:20:30Z",
        );
    });

    test("accepts a Date", () => {
        expect(toZoteroDate(new Date("2020-05-01T10:20:30.456Z"))).toBe(
            "2020-05-01T10:20:30Z",
        );
    });

    test("normalizes a non-UTC offset to UTC", () => {
        expect(toZoteroDate("2020-05-01T12:20:30+02:00")).toBe(
            "2020-05-01T10:20:30Z",
        );
    });

    test("a whole-second input round-trips unchanged", () => {
        expect(toZoteroDate("2020-05-01T10:20:30Z")).toBe(
            "2020-05-01T10:20:30Z",
        );
    });

    test("with no argument it uses the current time", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2021-03-04T05:06:07.890Z"));
        expect(toZoteroDate()).toBe("2021-03-04T05:06:07Z");
    });

    test.each([
        ["an empty string", ""],
        ["an unparseable string", "garbage"],
        ["an invalid Date", new Date("nope")],
    ])("throws on %s", (_label, input) => {
        // The empty string used to be treated as "no argument" and silently
        // return the current time, which then went to the server as a real
        // date. All unparseable inputs now fail the same way.
        expect(() => toZoteroDate(input)).toThrow(RangeError);
        expect(() => toZoteroDate(input)).toThrow(/unparseable date/);
    });

    test("an omitted argument still means now, and does not throw", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2021-03-04T05:06:07.890Z"));
        expect(toZoteroDate(undefined)).toBe("2021-03-04T05:06:07Z");
    });
});
