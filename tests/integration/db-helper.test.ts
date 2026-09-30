/**
 * DbHelperService — the shared query layer. Every method here runs against
 * the real Dexie schema, so these tests double as coverage of the compound
 * indexes they depend on.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { db, seedItem, seedCollection } from "../fakes/db";
import { createServiceHarness, USER_ID } from "../fakes/services";

import type { ServiceHarness } from "../fakes/services";

let h: ServiceHarness;

const GROUP_ID = 777;

describe("library filtering", () => {
    beforeEach(async () => {
        h = await createServiceHarness();
    });

    test("a missing API key is a configuration error", async () => {
        h = await createServiceHarness({ omitKey: true });
        await expect(h.dbHelper.getFilteredLibraryIDs()).rejects.toThrow(
            /API Key is missing/i,
        );
    });

    test("returns every configured library", async () => {
        h = await createServiceHarness({
            libraries: [{ id: USER_ID }, { id: GROUP_ID }],
        });
        expect((await h.dbHelper.getFilteredLibraryIDs()).sort()).toEqual([
            USER_ID,
            GROUP_ID,
        ]);
    });

    test("ignored libraries are excluded", async () => {
        h = await createServiceHarness({
            libraries: [{ id: USER_ID }, { id: GROUP_ID, mode: "ignored" }],
        });
        expect(await h.dbHelper.getFilteredLibraryIDs()).toEqual([USER_ID]);
    });
});

describe("settings updates", () => {
    test("updateSettings changes which libraries later calls consider", async () => {
        h = await createServiceHarness({
            libraries: [{ id: USER_ID }, { id: GROUP_ID }],
        });
        expect(await h.dbHelper.getFilteredLibraryIDs()).toHaveLength(2);

        const narrowed = {
            ...h.settings,
            librariesConfig: { [USER_ID]: { mode: "bidirectional" as const } },
        };
        h.dbHelper.updateSettings(narrowed);
        h.library.updateSettings(narrowed);

        expect(await h.dbHelper.getFilteredLibraryIDs()).toEqual([USER_ID]);
    });
});

describe("top-level item enumeration", () => {
    beforeEach(async () => {
        h = await createServiceHarness();
    });

    test("keeps only untrashed, parentless, note-bearing types", async () => {
        await seedItem({ libraryID: USER_ID, key: "ARTICLE1" });
        await seedItem({ libraryID: USER_ID, key: "TRASHED1", trashed: 1 });
        await seedItem({
            libraryID: USER_ID,
            key: "CHILDATT",
            itemType: "attachment",
            parentItem: "ARTICLE1",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "STANDALN",
            itemType: "attachment",
        });
        await seedItem({ libraryID: USER_ID, key: "NOTEITEM", itemType: "note" });
        await seedItem({
            libraryID: USER_ID,
            key: "ANNOTAT1",
            itemType: "annotation",
        });
        // A book is a note-bearing type just like a journal article.
        await seedItem({ libraryID: USER_ID, key: "BOOKITEM", itemType: "book" });

        const ids = await h.dbHelper.getAllTopLevelItemIdentifiers();

        expect(ids.map((i) => i.itemKey).sort()).toEqual([
            "ARTICLE1",
            "BOOKITEM",
        ]);
    });

    test("items in unconfigured libraries are skipped", async () => {
        h = await createServiceHarness({
            libraries: [{ id: USER_ID }, { id: GROUP_ID, mode: "ignored" }],
        });
        await seedItem({ libraryID: USER_ID, key: "MINEITEM" });
        await seedItem({ libraryID: GROUP_ID, key: "THEIRITM" });

        const ids = await h.dbHelper.getAllTopLevelItemIdentifiers();
        expect(ids.map((i) => i.itemKey)).toEqual(["MINEITEM"]);
    });
});

describe("single item lookups", () => {
    beforeEach(async () => {
        h = await createServiceHarness();
    });

    test("getItem returns undefined for a key that does not exist", async () => {
        await seedItem({ libraryID: USER_ID, key: "ARTICLE1" });
        expect((await h.dbHelper.getItem(USER_ID, "ARTICLE1"))!.key).toBe(
            "ARTICLE1",
        );
        expect(await h.dbHelper.getItem(USER_ID, "MISSING1")).toBeUndefined();
        // Keys are only unique within a library.
        expect(await h.dbHelper.getItem(GROUP_ID, "ARTICLE1")).toBeUndefined();
    });

    test("getAttachmentItem refuses a non-attachment", async () => {
        await seedItem({ libraryID: USER_ID, key: "ARTICLE1" });
        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH01",
            itemType: "attachment",
        });

        expect(
            (await h.dbHelper.getAttachmentItem(USER_ID, "ATTACH01"))!.key,
        ).toBe("ATTACH01");
        expect(
            await h.dbHelper.getAttachmentItem(USER_ID, "ARTICLE1"),
        ).toBeUndefined();
    });

    test("getAttachments returns untrashed attachment children only", async () => {
        await seedItem({ libraryID: USER_ID, key: "ARTICLE1" });
        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "ARTICLE1",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH02",
            itemType: "attachment",
            parentItem: "ARTICLE1",
            trashed: 1,
        });
        await seedItem({
            libraryID: USER_ID,
            key: "NOTECHLD",
            itemType: "note",
            parentItem: "ARTICLE1",
        });

        const attachments = await h.dbHelper.getAttachments(USER_ID, "ARTICLE1");
        expect(attachments.map((a) => a.key)).toEqual(["ATTACH01"]);
    });
});

describe("updateLastAccessed", () => {
    beforeEach(async () => {
        h = await createServiceHarness();
    });

    test("stamps the item", async () => {
        await seedItem({ libraryID: USER_ID, key: "ARTICLE1" });

        await h.dbHelper.updateLastAccessed(USER_ID, "ARTICLE1");

        const stored = (await db.items.get([USER_ID, "ARTICLE1"]))!;
        expect(stored.lastAccessedAt).toBeTruthy();
    });

    test("opening an attachment also stamps its parent", async () => {
        // The parent is what the recent-items list shows, so a child read has
        // to surface as a read of the thing the user recognises.
        await seedItem({ libraryID: USER_ID, key: "ARTICLE1" });
        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "ARTICLE1",
        });

        await h.dbHelper.updateLastAccessed(USER_ID, "ATTACH01");

        const parent = (await db.items.get([USER_ID, "ARTICLE1"]))!;
        const child = (await db.items.get([USER_ID, "ATTACH01"]))!;
        expect(child.lastAccessedAt).toBeTruthy();
        expect(parent.lastAccessedAt).toBe(child.lastAccessedAt);
    });

    test("an unknown key is a no-op", async () => {
        await expect(
            h.dbHelper.updateLastAccessed(USER_ID, "MISSING1"),
        ).resolves.toBeUndefined();
    });
});

describe("annotation candidates", () => {
    beforeEach(async () => {
        h = await createServiceHarness();
    });

    async function seedAnnotation(key: string, parentItem: string, over = {}) {
        await seedItem({
            libraryID: USER_ID,
            key,
            itemType: "annotation",
            parentItem,
            raw: {
                key,
                data: {
                    key,
                    itemType: "annotation",
                    annotationType: "highlight",
                    annotationText: `text of ${key}`,
                    annotationPageLabel: "7",
                    ...over,
                },
            } as any,
        });
    }

    test("collects annotations across every attachment of an item", async () => {
        await seedItem({ libraryID: USER_ID, key: "ARTICLE1" });
        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "ARTICLE1",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH02",
            itemType: "attachment",
            parentItem: "ARTICLE1",
        });
        await seedAnnotation("ANNOTAT1", "ATTACH01");
        await seedAnnotation("ANNOTAT2", "ATTACH02");

        const found = await h.dbHelper.getAnnotationCandidates(USER_ID, "ARTICLE1");

        expect(found.map((a) => a.key).sort()).toEqual(["ANNOTAT1", "ANNOTAT2"]);
        expect(found[0]).toMatchObject({
            pageLabel: "7",
            type: "highlight",
        });
    });

    test("a standalone attachment is its own annotation parent", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "STANDALN",
            itemType: "attachment",
        });
        await seedAnnotation("ANNOTAT1", "STANDALN");

        const found = await h.dbHelper.getAnnotationCandidates(
            USER_ID,
            "STANDALN",
        );
        expect(found.map((a) => a.key)).toEqual(["ANNOTAT1"]);
    });

    test("a null libraryID is resolved by scanning the active libraries", async () => {
        h = await createServiceHarness({
            libraries: [{ id: USER_ID }, { id: GROUP_ID }],
        });
        await seedItem({
            libraryID: GROUP_ID,
            key: "STANDALN",
            itemType: "attachment",
        });
        await seedItem({
            libraryID: GROUP_ID,
            key: "ANNOTAT1",
            itemType: "annotation",
            parentItem: "STANDALN",
            raw: {
                key: "ANNOTAT1",
                data: { key: "ANNOTAT1", annotationType: "note" },
            } as any,
        });

        const found = await h.dbHelper.getAnnotationCandidates(null, "STANDALN");
        expect(found.map((a) => a.key)).toEqual(["ANNOTAT1"]);
    });

    test("an unresolvable key yields nothing rather than throwing", async () => {
        expect(await h.dbHelper.getAnnotationCandidates(null, "MISSING1")).toEqual(
            [],
        );
    });

    test("an annotation without a raw payload is skipped", async () => {
        await seedItem({
            libraryID: USER_ID,
            key: "STANDALN",
            itemType: "attachment",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "ANNOTAT1",
            itemType: "annotation",
            parentItem: "STANDALN",
            raw: undefined,
        });

        expect(
            await h.dbHelper.getAnnotationCandidates(USER_ID, "STANDALN"),
        ).toEqual([]);
    });
});

describe("getItemPaths", () => {
    beforeEach(async () => {
        h = await createServiceHarness();
    });

    test("an item in no collection sits at the library root", async () => {
        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ARTICLE1", collections: [] },
        ]);
        expect(paths).toEqual({ "1:ARTICLE1": ["My Library/"] });
    });

    test("an empty batch does no work", async () => {
        expect(await h.dbHelper.getItemPaths([])).toEqual({});
    });

    test("a single collection becomes one breadcrumb", async () => {
        await seedCollection({
            libraryID: USER_ID,
            key: "COLL0001",
            name: "Papers",
        });

        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ARTICLE1", collections: ["COLL0001"] },
        ]);
        expect(paths["1:ARTICLE1"]).toEqual(["My Library/Papers/"]);
    });

    test("nested collections resolve root-first", async () => {
        await seedCollection({ libraryID: USER_ID, key: "ROOTCOLL", name: "Root" });
        await seedCollection({
            libraryID: USER_ID,
            key: "MIDCOLL0",
            name: "Middle",
            parentCollection: "ROOTCOLL",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "LEAFCOLL",
            name: "Leaf",
            parentCollection: "MIDCOLL0",
        });

        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ARTICLE1", collections: ["LEAFCOLL"] },
        ]);
        expect(paths["1:ARTICLE1"]).toEqual(["My Library/Root/Middle/Leaf/"]);
    });

    test("an item in several collections gets one path each", async () => {
        await seedCollection({ libraryID: USER_ID, key: "COLL0001", name: "One" });
        await seedCollection({ libraryID: USER_ID, key: "COLL0002", name: "Two" });

        const paths = await h.dbHelper.getItemPaths([
            {
                libraryID: USER_ID,
                key: "ARTICLE1",
                collections: ["COLL0001", "COLL0002"],
            },
        ]);
        expect(paths["1:ARTICLE1"]).toEqual([
            "My Library/One/",
            "My Library/Two/",
        ]);
    });

    test("items sharing an ancestor chain resolve consistently", async () => {
        // Exercises the path cache: the second item must reuse the first
        // item's resolved ancestry rather than rebuild a different answer.
        await seedCollection({ libraryID: USER_ID, key: "ROOTCOLL", name: "Root" });
        await seedCollection({
            libraryID: USER_ID,
            key: "CHILDA00",
            name: "ChildA",
            parentCollection: "ROOTCOLL",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "CHILDB00",
            name: "ChildB",
            parentCollection: "ROOTCOLL",
        });

        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ITEMONE0", collections: ["CHILDA00"] },
            { libraryID: USER_ID, key: "ITEMTWO0", collections: ["CHILDB00"] },
            { libraryID: USER_ID, key: "ITEMTHRE", collections: ["CHILDA00"] },
        ]);

        expect(paths["1:ITEMONE0"]).toEqual(["My Library/Root/ChildA/"]);
        expect(paths["1:ITEMTWO0"]).toEqual(["My Library/Root/ChildB/"]);
        expect(paths["1:ITEMTHRE"]).toEqual(["My Library/Root/ChildA/"]);
    });

    test("a later item extends an ancestor path an earlier one already cached", async () => {
        // Ordering matters: the first item caches "Root/Middle" under the
        // MIDDLE key, and the second item's walk has to stop there and append
        // rather than rebuild the chain from scratch.
        await seedCollection({ libraryID: USER_ID, key: "ROOTCOLL", name: "Root" });
        await seedCollection({
            libraryID: USER_ID,
            key: "MIDCOLL0",
            name: "Middle",
            parentCollection: "ROOTCOLL",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "LEAFCOLL",
            name: "Leaf",
            parentCollection: "MIDCOLL0",
        });

        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ITEMMID0", collections: ["MIDCOLL0"] },
            { libraryID: USER_ID, key: "ITEMLEAF", collections: ["LEAFCOLL"] },
        ]);

        expect(paths["1:ITEMMID0"]).toEqual(["My Library/Root/Middle/"]);
        expect(paths["1:ITEMLEAF"]).toEqual(["My Library/Root/Middle/Leaf/"]);
    });

    test("the same answer regardless of batch order", async () => {
        await seedCollection({ libraryID: USER_ID, key: "ROOTCOLL", name: "Root" });
        await seedCollection({
            libraryID: USER_ID,
            key: "MIDCOLL0",
            name: "Middle",
            parentCollection: "ROOTCOLL",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "LEAFCOLL",
            name: "Leaf",
            parentCollection: "MIDCOLL0",
        });

        const forward = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ITEMMID0", collections: ["MIDCOLL0"] },
            { libraryID: USER_ID, key: "ITEMLEAF", collections: ["LEAFCOLL"] },
        ]);
        const reverse = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ITEMLEAF", collections: ["LEAFCOLL"] },
            { libraryID: USER_ID, key: "ITEMMID0", collections: ["MIDCOLL0"] },
        ]);

        expect(reverse).toEqual(forward);
    });

    test("a batch spanning libraries keeps them apart", async () => {
        h = await createServiceHarness({
            libraries: [
                { id: USER_ID, name: "Mine" },
                { id: GROUP_ID, name: "Ours" },
            ],
        });
        // Same collection key in both libraries, different names.
        await seedCollection({ libraryID: USER_ID, key: "SAMEKEY0", name: "Here" });
        await seedCollection({ libraryID: GROUP_ID, key: "SAMEKEY0", name: "There" });

        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ITEMONE0", collections: ["SAMEKEY0"] },
            { libraryID: GROUP_ID, key: "ITEMTWO0", collections: ["SAMEKEY0"] },
        ]);

        expect(paths["1:ITEMONE0"]).toEqual(["Mine/Here/"]);
        expect(paths["777:ITEMTWO0"]).toEqual(["Ours/There/"]);
    });

    test("an unknown library falls back to a generated name", async () => {
        const paths = await h.dbHelper.getItemPaths([
            { libraryID: 999, key: "ARTICLE1", collections: [] },
        ]);
        expect(paths["999:ARTICLE1"]).toEqual(["Library 999/"]);
    });

    test("a dangling collection reference is treated as no collection", async () => {
        // The row is gone while the item still names it — an interrupted pull,
        // or a remote collection deletion whose member items have not been
        // re-pulled. The item is, as far as the local DB knows, uncollected.
        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ARTICLE1", collections: ["GHOSTCOL"] },
        ]);
        expect(paths["1:ARTICLE1"]).toEqual(["My Library/"]);
    });

    test("a dangling reference alongside a real one drops only the dangling", async () => {
        await seedCollection({ libraryID: USER_ID, key: "COLL0001", name: "One" });

        const paths = await h.dbHelper.getItemPaths([
            {
                libraryID: USER_ID,
                key: "ARTICLE1",
                collections: ["COLL0001", "GHOSTCOL"],
            },
        ]);
        // Not "My Library/" as an extra entry: the item's real membership is
        // the only thing worth reporting.
        expect(paths["1:ARTICLE1"]).toEqual(["My Library/One/"]);
    });

    test("empty strings in the collection list are ignored", async () => {
        await seedCollection({ libraryID: USER_ID, key: "COLL0001", name: "One" });

        const paths = await h.dbHelper.getItemPaths([
            {
                libraryID: USER_ID,
                key: "ARTICLE1",
                collections: ["", "COLL0001", ""],
            },
        ]);
        expect(paths["1:ARTICLE1"]).toEqual(["My Library/One/"]);
    });

    test("a partially dangling chain keeps the segments it can resolve", async () => {
        // The parent row is missing, e.g. an interrupted collection pull.
        await seedCollection({
            libraryID: USER_ID,
            key: "LEAFCOLL",
            name: "Leaf",
            parentCollection: "GHOSTCOL",
        });

        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ARTICLE1", collections: ["LEAFCOLL"] },
        ]);
        expect(paths["1:ARTICLE1"]).toEqual(["My Library/Leaf/"]);
    });

    /**
     * A cycle in `parentCollection` used to hang the worker outright.
     *
     * The ancestry walk had no visited set, and the path cache it would
     * otherwise break on is written only *after* the walk completes, so
     * A -> B -> A looped forever — synchronously, so nothing yielded and
     * neither an error, a timeout, nor vitest's own abort could land.
     *
     * No code path can currently produce such a cycle: a collection is only
     * ever written as `synced` (normalizeCollection hardcodes it, and every
     * write that could dirty one already requires it to be dirty), so the
     * local parentCollection never diverges from the server's. The guard is
     * therefore insurance, not a bug fix — but it is the cheap half of the
     * trade, and local collection editing would remove the invariant.
     */
    test("a cyclic parentCollection terminates instead of hanging", async () => {
        await seedCollection({
            libraryID: USER_ID,
            key: "COLLAAAA",
            name: "A",
            parentCollection: "COLLBBBB",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "COLLBBBB",
            name: "B",
            parentCollection: "COLLAAAA",
        });

        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ARTICLE1", collections: ["COLLAAAA"] },
        ]);

        // The walk stops the moment it revisits a key, so the breadcrumbs are
        // whatever it collected before closing the loop — one lap, no repeats.
        expect(paths["1:ARTICLE1"]).toEqual(["My Library/B/A/"]);
    });

    test("a self-parented collection terminates too", async () => {
        await seedCollection({
            libraryID: USER_ID,
            key: "SELFCOLL",
            name: "Self",
            parentCollection: "SELFCOLL",
        });

        const paths = await h.dbHelper.getItemPaths([
            { libraryID: USER_ID, key: "ARTICLE1", collections: ["SELFCOLL"] },
        ]);
        expect(paths["1:ARTICLE1"]).toEqual(["My Library/Self/"]);
    });
});
