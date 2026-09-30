/**
 * SearchService — the item search behind the search modals: recency lists
 * for an empty query, ranked results for a typed one, and the value lists
 * for `library:` / `collection:` autocomplete. Runs against the real Dexie
 * schema; ranking itself is covered by the SearchMatcher unit tests.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { seedItem, seedCollection, seedLibrary } from "../fakes/db";
import { createServiceHarness, USER_ID } from "../fakes/services";

import type { ServiceHarness } from "../fakes/services";

let h: ServiceHarness;

const GROUP_ID = 777;

describe("recency queries", () => {
    beforeEach(async () => {
        h = await createServiceHarness();
    });

    test("recently accessed items come back newest first", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "OLDESTIT",
            lastAccessedAt: "2026-01-01T00:00:00.000Z",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "NEWESTIT",
            lastAccessedAt: "2026-03-01T00:00:00.000Z",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "MIDDLEIT",
            lastAccessedAt: "2026-02-01T00:00:00.000Z",
        });
        // Never opened — excluded by the `above("")` bound.
        await seedItem({ libraryID: USER_ID, key: "UNTOUCHD" });

        const recent = await h.search.getRecentItems(10);
        expect(recent.map((i) => i.key)).toEqual([
            "NEWESTIT",
            "MIDDLEIT",
            "OLDESTIT",
        ]);
    });

    test("recently accessed respects the limit", async () => {
        for (let i = 0; i < 5; i++) {
            await seedItem({
                libraryID: USER_ID,
                key: `ITEM000${i}`,
                lastAccessedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
            });
        }
        expect(await h.search.getRecentItems(2)).toHaveLength(2);
    });

    test("recently accessed excludes children, notes, annotations and trash", async () => {
        const at = "2026-01-01T00:00:00.000Z";
        await seedItem({
            libraryID: USER_ID,
            key: "GOODITEM",
            lastAccessedAt: at,
        });
        await seedItem({
            libraryID: USER_ID,
            key: "CHILDATT",
            itemType: "attachment",
            parentItem: "GOODITEM",
            lastAccessedAt: at,
        });
        await seedItem({
            libraryID: USER_ID,
            key: "NOTEITEM",
            itemType: "note",
            lastAccessedAt: at,
        });
        await seedItem({
            libraryID: USER_ID,
            key: "TRASHED1",
            trashed: 1,
            lastAccessedAt: at,
        });

        expect((await h.search.getRecentItems(10)).map((i) => i.key)).toEqual([
            "GOODITEM",
        ]);
    });

    test("recently added items are ordered by dateModified, newest first", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "OLDESTIT",
            dateModified: "2026-01-01T00:00:00.000Z",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "NEWESTIT",
            dateModified: "2026-03-01T00:00:00.000Z",
        });

        expect(
            (await h.search.getRecentlyAddedItems(10)).map((i) => i.key),
        ).toEqual(["NEWESTIT", "OLDESTIT"]);
    });
});

describe("autocomplete sources", () => {
    test("library names are sorted and fall back to the id", async () => {
        h = await createServiceHarness({
            libraries: [
                { id: USER_ID, name: "Zebra" },
                { id: GROUP_ID, name: "alpha" },
            ],
        });

        // Accent-insensitive sort puts "alpha" before "Zebra".
        expect(await h.search.getLibraryNames()).toEqual(["alpha", "Zebra"]);
    });

    test("a nameless library falls back to its id", async () => {
        h = await createServiceHarness();
        await seedLibrary({ id: USER_ID, name: "", type: "user" });
        expect(await h.search.getLibraryNames()).toEqual([String(USER_ID)]);
    });

    test("collection names are deduplicated, sorted and exclude trash", async () => {
        h = await createServiceHarness({
            libraries: [{ id: USER_ID }, { id: GROUP_ID }],
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "COLL0001",
            name: "Beta",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "COLL0002",
            name: "alpha",
        });
        // Same name in another library — one entry, not two.
        await seedCollection({
            libraryID: GROUP_ID,
            key: "COLL0003",
            name: "alpha",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "COLL0004",
            name: "Trashed",
            trashed: 1,
        });

        expect(await h.search.getCollectionNames()).toEqual(["alpha", "Beta"]);
    });

    test("no active libraries means no names", async () => {
        h = await createServiceHarness({
            libraries: [{ id: USER_ID, mode: "ignored" }],
        });
        expect(await h.search.getLibraryNames()).toEqual([]);
        expect(await h.search.getCollectionNames()).toEqual([]);
    });
});

describe("searchItems", () => {
    beforeEach(async () => {
        h = await createServiceHarness({
            libraries: [
                { id: USER_ID, name: "Mine" },
                { id: GROUP_ID, name: "Shared" },
            ],
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "COLL0001",
            name: "Machine Learning",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "COLL0002",
            name: "Archive",
        });

        await seedItem({
            libraryID: USER_ID,
            key: "ATTENTIO",
            title: "Attention Is All You Need",
            itemType: "conferencePaper",
            searchCreators: ["Ashish Vaswani", "Noam Shazeer"],
            searchTags: ["transformer", "nlp"],
            collections: ["COLL0001"],
        });
        await seedItem({
            libraryID: USER_ID,
            key: "BITCOIN0",
            title: "Bitcoin: A Peer-to-Peer Electronic Cash System",
            itemType: "journalArticle",
            searchCreators: ["Satoshi Nakamoto"],
            searchTags: ["crypto"],
            collections: ["COLL0002"],
        });
        await seedItem({
            libraryID: GROUP_ID,
            key: "SHAREDIT",
            title: "Shared Attention Study",
            itemType: "book",
            searchCreators: ["Jane Doe"],
        });
    });

    test("matches on the title", async () => {
        const found = await h.search.searchItems("attention", 10);
        expect(found.map((i) => i.key).sort()).toEqual([
            "ATTENTIO",
            "SHAREDIT",
        ]);
    });

    test("matches on a creator name", async () => {
        const found = await h.search.searchItems("Nakamoto", 10);
        expect(found.map((i) => i.key)).toEqual(["BITCOIN0"]);
    });

    test("matches an accented creator with a plain-letter query", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "DIACRITC",
            title: "Accent Study",
            searchCreators: ["Lämmermann"],
        });

        const freeText = await h.search.searchItems("Lammermann", 10);
        expect(freeText.map((i) => i.key)).toEqual(["DIACRITC"]);

        const filtered = await h.search.searchItems("creator:Lammermann", 10);
        expect(filtered.map((i) => i.key)).toEqual(["DIACRITC"]);
    });

    test("matches on a tag", async () => {
        const found = await h.search.searchItems("transformer", 10);
        expect(found.map((i) => i.key)).toEqual(["ATTENTIO"]);
    });

    test("respects the limit", async () => {
        expect(await h.search.searchItems("attention", 1)).toHaveLength(1);
    });

    test("child items, notes, annotations and trash never surface", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "ATTNOTE0",
            title: "Attention note",
            itemType: "note",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "ATTCHILD",
            title: "Attention attachment",
            itemType: "attachment",
            parentItem: "ATTENTIO",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "ATTTRASH",
            title: "Attention trashed",
            trashed: 1,
        });

        const found = await h.search.searchItems("attention", 10);
        expect(found.map((i) => i.key).sort()).toEqual([
            "ATTENTIO",
            "SHAREDIT",
        ]);
    });

    test("a type: filter narrows by item type", async () => {
        const found = await h.search.searchItems("type:book", 10);
        expect(found.map((i) => i.key)).toEqual(["SHAREDIT"]);
    });

    test("a negated type: filter excludes it", async () => {
        const found = await h.search.searchItems("attention -type:book", 10);
        expect(found.map((i) => i.key)).toEqual(["ATTENTIO"]);
    });

    test("a tag: filter narrows by tag", async () => {
        const found = await h.search.searchItems("tag:crypto", 10);
        expect(found.map((i) => i.key)).toEqual(["BITCOIN0"]);
    });

    test("a creator: filter narrows by author", async () => {
        const found = await h.search.searchItems("creator:Shazeer", 10);
        expect(found.map((i) => i.key)).toEqual(["ATTENTIO"]);
    });

    test("a collection: filter resolves keys to names first", async () => {
        // Collection names are only looked up when a filter needs them, so
        // this also covers the lazy resolveCollectionNames path.
        const found = await h.search.searchItems(
            'collection:"Machine Learning"',
            10,
        );
        expect(found.map((i) => i.key)).toEqual(["ATTENTIO"]);
    });

    test("a library: filter narrows by library name", async () => {
        const found = await h.search.searchItems(
            "attention library:Shared",
            10,
        );
        expect(found.map((i) => i.key)).toEqual(["SHAREDIT"]);
    });

    test("a dangling collection reference does not break the filter", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "ORPHANIT",
            title: "Attention orphan",
            collections: ["GHOSTCOL"],
        });

        const found = await h.search.searchItems(
            'collection:"Machine Learning"',
            10,
        );
        expect(found.map((i) => i.key)).toEqual(["ATTENTIO"]);
    });

    test("no match yields an empty list", async () => {
        expect(await h.search.searchItems("zzzzzznothing", 10)).toEqual([]);
    });
});
