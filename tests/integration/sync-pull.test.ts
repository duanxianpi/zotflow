/**
 * The pull half of a sync: `format=versions` deltas, batching, the
 * local-dirty-vs-remote-change conflict rules, and the cascade that removes an
 * item or collection along with its descendants.
 */
import { describe, test, expect, afterEach } from "vitest";
import { deleteLocalItems, mutateItem } from "db/mutate";
import { db, seedItem, seedCollection } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";

let h: SyncHarness;
afterEach(() => h?.dispose());

describe("item pull", () => {
    test("first sync stores every item and records the library version", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "First" } });
        lib.addItem({ key: "BBBBBBBB", data: { title: "Second" } });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(0);
        const stored = await db.items.toArray();
        expect(stored.map((i) => i.key).sort()).toEqual(["AAAAAAAA", "BBBBBBBB"]);
        expect(stored.every((i) => i.syncStatus === "synced")).toBe(true);
        expect(stored.find((i) => i.key === "AAAAAAAA")!.title).toBe("First");
        expect((await db.libraries.get(USER_ID))!.itemVersion).toBe(lib.version);
    });

    test("no remote change means no batch fetch", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        h.server.clearRequests();
        await h.sync.startSync();

        // The delta probe still runs; nothing follows it.
        expect(
            h.server.requestsFor("/items").filter((r) => r.query.has("itemKey")),
        ).toHaveLength(0);
        expect(await db.items.count()).toBe(1);
    });

    test("an incremental sync fetches only keys newer than the stored version", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        lib.addItem({ key: "BBBBBBBB", data: { title: "Added later" } });
        h.server.clearRequests();
        await h.sync.startSync();

        const batch = h.server
            .requestsFor("/items")
            .find((r) => r.query.has("itemKey"));
        expect(batch!.query.get("itemKey")).toBe("BBBBBBBB");
        expect(await db.items.count()).toBe(2);
    });

    test("the item fetch is batched at PULL_BULK_SIZE", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        // 101 items -> two batch requests (100 + 1).
        for (let i = 0; i < 101; i++) {
            lib.addItem({ key: `KEY${String(i).padStart(5, "0")}` });
        }

        await h.sync.startSync();

        const batches = h.server
            .requestsFor("/items")
            .filter((r) => r.query.has("itemKey"));
        expect(batches).toHaveLength(2);
        expect(batches[0]!.query.get("itemKey")!.split(",")).toHaveLength(100);
        expect(batches[1]!.query.get("itemKey")!.split(",")).toHaveLength(1);
        expect(await db.items.count()).toBe(101);
    });

    test("csljson is requested alongside data", async () => {
        h = await createSyncHarness();
        h.server
            .library(USER_ID)
            .addItem({ key: "AAAAAAAA", csljson: { id: "doe2020" } });

        await h.sync.startSync();

        const batch = h.server
            .requestsFor("/items")
            .find((r) => r.query.has("itemKey"));
        expect(batch!.query.get("include")).toBe("data,csljson");
    });

    test("trashed items are included in the delta", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });

        await h.sync.startSync();

        const probe = h.server
            .requestsFor("/items")
            .find((r) => r.query.get("format") === "versions");
        expect(probe!.query.get("includeTrashed")).toBeTruthy();
    });

    test("changedItems reports what the pull touched", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });

        const result = await h.sync.startSync();

        expect(result.changedItems).toContainEqual({
            libraryID: USER_ID,
            itemKey: "AAAAAAAA",
        });
    });
});

describe("item pull conflicts", () => {
    test("a local edit and a remote edit of the same field become a conflict", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "Original" } });
        await h.sync.startSync();

        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "My local title"));
        lib.updateItem("AAAAAAAA", { title: "Remote title" });

        await h.sync.startSync();

        const stored = await db.items.get([USER_ID, "AAAAAAAA"]);
        expect(stored!.syncStatus).toBe("conflict");
        // Local edits survive; the server copy waits on the conflict.
        expect(stored!.title).toBe("My local title");
        const conflict = (await db.syncConflicts.get([USER_ID, "AAAAAAAA"]))!;
        expect(conflict).toMatchObject({ kind: "changed", fields: ["title"], remoteVersion: lib.items.get("AAAAAAAA")!.version });
        expect(conflict.remote!.title).toBe("Remote title");
        // Nothing was uploaded over the remote change.
        expect(lib.items.get("AAAAAAAA")!.data.title).toBe("Remote title");
    });

    test("edits of different fields merge, and the merge is uploaded as a patch", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "Original", extra: "" } });
        await h.sync.startSync();

        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.extra = "local extra"));
        lib.updateItem("AAAAAAAA", { title: "Remote title" });
        h.server.clearRequests();

        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.raw.data).toMatchObject({ title: "Remote title", extra: "local extra" });
        expect(lib.items.get("AAAAAAAA")!.data).toMatchObject({ title: "Remote title", extra: "local extra" });
        const posts = h.server.requests.filter((r) => r.method === "POST");
        const last = (posts.at(-1)!.body as Record<string, unknown>[])[0]!;
        expect(last).toHaveProperty("extra", "local extra");
        expect(last).not.toHaveProperty("title");
    });

    test("a local delete meeting a remote edit becomes a conflict", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "PARENT01" });
        lib.addItem({ key: "ATTACH01", data: { itemType: "attachment", parentItem: "PARENT01", linkMode: "linked_url" } });
        lib.addItem({ key: "ANNOTAT1", data: { itemType: "annotation", parentItem: "ATTACH01", annotationComment: "c" } });
        await h.sync.startSync();

        await deleteLocalItems(USER_ID, ["ANNOTAT1"]);
        lib.updateItem("ANNOTAT1", { annotationComment: "remote" });
        await h.sync.startSync();

        expect(await db.items.get([USER_ID, "ANNOTAT1"])).toBeUndefined();
        expect(await db.syncConflicts.get([USER_ID, "ANNOTAT1"])).toMatchObject({ kind: "local-deleted" });
        // The DELETE waits for the user.
        expect(lib.items.has("ANNOTAT1")).toBe(true);
    });

    test("a newer remote version refreshes a conflict, which stays a conflict", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "Original" } });
        await h.sync.startSync();
        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "Local"));
        lib.updateItem("AAAAAAAA", { title: "Remote 1" });
        await h.sync.startSync();

        lib.updateItem("AAAAAAAA", { title: "Remote 2" });
        await h.sync.startSync();

        const conflict = (await db.syncConflicts.get([USER_ID, "AAAAAAAA"]))!;
        expect(conflict.remote!.title).toBe("Remote 2");
        expect((await db.items.get([USER_ID, "AAAAAAAA"]))!.title).toBe("Local");
    });

    test("a remote edit to a clean local item overwrites it in place", async () => {
        // The ordinary case, and the one the conflict rules are the exception
        // to: a synced row must take the server's version silently.
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "Original" } });
        await h.sync.startSync();

        lib.updateItem("AAAAAAAA", { title: "Remote title" });
        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.title).toBe("Remote title");
        expect(stored.version).toBe(lib.items.get("AAAAAAAA")!.version);
        expect(await db.syncConflicts.count()).toBe(0);
        expect(await db.items.count()).toBe(1);
    });

    test('an "ignore" item is overwritten like a clean one', async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "Original" } });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "ignore" });
        lib.updateItem("AAAAAAAA", { title: "Remote title" });

        await h.sync.startSync();

        const stored = await db.items.get([USER_ID, "AAAAAAAA"]);
        expect(stored!.syncStatus).toBe("synced");
        expect(stored!.title).toBe("Remote title");
    });
});

describe("item pull deletions", () => {
    test("a remotely deleted item is removed locally", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        lib.addItem({ key: "BBBBBBBB" });
        await h.sync.startSync();

        lib.deleteItem("AAAAAAAA");
        await h.sync.startSync();

        expect((await db.items.toArray()).map((i) => i.key)).toEqual(["BBBBBBBB"]);
    });

    test("deleting a parent cascades to descendants", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "PARENT01" });
        await h.sync.startSync();

        // Children only exist locally (Zotero does not bump the parent for them).
        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
        });
        await seedItem({
            libraryID: USER_ID,
            key: "ANNOTAT1",
            itemType: "annotation",
            parentItem: "ATTACH01",
        });

        lib.deleteItem("PARENT01");
        await h.sync.startSync();

        expect(await db.items.count()).toBe(0);
    });

    test("an unsynced local change anywhere in the family blocks the delete", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "PARENT01" });
        await h.sync.startSync();

        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
            syncStatus: "updated", // the dirty descendant
        });

        lib.deleteItem("PARENT01");
        await h.sync.startSync();

        // One conflict for the deletion: the changed row and the ancestors
        // it needs to be restored with.
        for (const key of ["PARENT01", "ATTACH01"]) {
            expect((await db.items.get([USER_ID, key]))!.syncStatus).toBe("conflict");
            expect(await db.syncConflicts.get([USER_ID, key])).toMatchObject({ kind: "remote-deleted", group: "PARENT01" });
        }
        expect((await db.syncGroups.get([USER_ID, "PARENT01"]))!.members.sort()).toEqual(["ATTACH01", "PARENT01"]);
        // Nothing was destroyed.
        expect(await db.items.count()).toBe(2);
        expect(
            h.host.logsAt("warn").some((l) => /PARENT01 was deleted in Zotero but holds local changes/.test(l.message)),
        ).toBe(true);
    });

    test("deleting a child records its top-level ancestor as changed", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "PARENT01" });
        lib.addItem({ key: "ANNOTAT1" });
        await h.sync.startSync();

        // Re-parent locally: annotation → attachment → journalArticle.
        await seedItem({
            libraryID: USER_ID,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
        });
        await db.items.update([USER_ID, "ANNOTAT1"], {
            itemType: "annotation",
            parentItem: "ATTACH01",
        });

        lib.deleteItem("ANNOTAT1");
        const result = await h.sync.startSync();

        // Deleting an annotation does not bump the article's version, so
        // without this the source note would never be re-rendered.
        expect(result.changedItems).toContainEqual({
            libraryID: USER_ID,
            itemKey: "PARENT01",
        });
        expect(await db.items.get([USER_ID, "ANNOTAT1"])).toBeUndefined();
    });

    for (const annotationType of ["image", "ink"] as const) {
        test(`deleting an ${annotationType} annotation removes its rendered image`, async () => {
            h = await createSyncHarness({
                settings: { annotationImageFolder: "ZotFlow/images" },
                host: { files: { "ZotFlow/images/ANNOTAT1.png": "png bytes" } },
            });
            const lib = h.server.library(USER_ID);
            lib.addItem({ key: "ANNOTAT1" });
            await h.sync.startSync();

            await db.items.update([USER_ID, "ANNOTAT1"], {
                itemType: "annotation",
                raw: { data: { annotationType } } as any,
            });

            lib.deleteItem("ANNOTAT1");
            await h.sync.startSync();

            expect(h.host.vault.has("ZotFlow/images/ANNOTAT1.png")).toBe(false);
        });
    }

    test("a text annotation leaves no image behind to delete", async () => {
        h = await createSyncHarness({
            settings: { annotationImageFolder: "ZotFlow/images" },
            host: { files: { "ZotFlow/images/ANNOTAT1.png": "unrelated" } },
        });
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "ANNOTAT1" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "ANNOTAT1"], {
            itemType: "annotation",
            raw: { data: { annotationType: "highlight" } } as any,
        });

        lib.deleteItem("ANNOTAT1");
        await h.sync.startSync();

        expect(h.host.vault.has("ZotFlow/images/ANNOTAT1.png")).toBe(true);
    });

    test("a vault that refuses the image delete does not break the sync", async () => {
        h = await createSyncHarness({
            settings: { annotationImageFolder: "ZotFlow/images" },
            host: { files: { "ZotFlow/images/ANNOTAT1.png": "png bytes" } },
        });
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "ANNOTAT1" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "ANNOTAT1"], {
            itemType: "annotation",
            raw: { data: { annotationType: "image" } } as any,
        });
        h.host.deleteFile = () => Promise.reject(new Error("EPERM"));

        lib.deleteItem("ANNOTAT1");
        const result = await h.sync.startSync();

        // The item is gone from the DB; only the leftover file remains.
        expect(result.failCount).toBe(0);
        expect(await db.items.get([USER_ID, "ANNOTAT1"])).toBeUndefined();
        expect(
            h.host.logsAt("warn").some((l) =>
                /Failed to delete annotation image ANNOTAT1/.test(l.message),
            ),
        ).toBe(true);
    });

    test("a cyclic parentItem does not stall the deletion cascade", async () => {
        // The descendant walk runs inside an open Dexie transaction, so an
        // unguarded cycle would hang holding a write lock. No code path
        // produces one today — nothing local ever edits parentItem — but the
        // guard is what keeps that an invariant rather than a dependency.
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "ITEMAAAA" });
        await h.sync.startSync();

        await db.items.update([USER_ID, "ITEMAAAA"], { parentItem: "ITEMBBBB" });
        await seedItem({
            libraryID: USER_ID,
            key: "ITEMBBBB",
            parentItem: "ITEMAAAA",
        });

        lib.deleteItem("ITEMAAAA");
        const result = await h.sync.startSync();

        expect(result.failCount).toBe(0);
        expect(await db.items.count()).toBe(0);
    });

    test("a tombstone for an item we never had is ignored", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        lib.addItem({ key: "NEVERHAD" });
        lib.deleteItem("NEVERHAD");
        await h.sync.startSync();

        expect((await db.items.toArray()).map((i) => i.key)).toEqual(["AAAAAAAA"]);
        expect(h.host.logsAt("error")).toHaveLength(0);
    });

    test("the deleted endpoint is skipped on a first-ever sync", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });

        await h.sync.startSync();

        // localVersion is 0, so there is no window to ask about.
        expect(h.server.requestsFor("/deleted")).toHaveLength(0);
    });
});

describe("collection pull", () => {
    test("collections land in their own table", async () => {
        h = await createSyncHarness();
        h.server
            .library(USER_ID)
            .addCollection({ key: "CCCCCCCC", data: { name: "Papers" } });

        await h.sync.startSync();

        const collections = await db.collections.toArray();
        expect(collections).toHaveLength(1);
        expect(collections[0]!.name).toBe("Papers");
        expect(collections[0]!.syncStatus).toBe("synced");
    });

    test("collectionVersion is recorded separately from itemVersion", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addCollection({ key: "CCCCCCCC" });
        lib.addItem({ key: "AAAAAAAA" });

        await h.sync.startSync();

        const stored = (await db.libraries.get(USER_ID))!;
        expect(stored.collectionVersion).toBe(lib.version);
        expect(stored.itemVersion).toBe(lib.version);
    });

    test("the collection fetch is batched at PULL_BULK_SIZE", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        for (let i = 0; i < 101; i++) {
            lib.addCollection({ key: `COL${String(i).padStart(5, "0")}` });
        }

        await h.sync.startSync();

        const batches = h.server
            .requestsFor("/collections")
            .filter((r) => r.query.has("collectionKey"));
        expect(batches).toHaveLength(2);
        expect(await db.collections.count()).toBe(101);
    });

    test("no remote change means no batch fetch", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addCollection({ key: "CCCCCCCC" });
        await h.sync.startSync();

        h.server.clearRequests();
        await h.sync.startSync();

        expect(
            h.server
                .requestsFor("/collections")
                .filter((r) => r.query.has("collectionKey")),
        ).toHaveLength(0);
    });

    test("a remote edit to a clean local collection overwrites it in place", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addCollection({ key: "CCCCCCCC", data: { name: "Original" } });
        await h.sync.startSync();

        lib.updateCollection("CCCCCCCC", { name: "Renamed remotely" });
        await h.sync.startSync();

        const stored = (await db.collections.get([USER_ID, "CCCCCCCC"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.name).toBe("Renamed remotely");
        expect(await db.collections.count()).toBe(1);
    });

    test("the server copy wins unconditionally — collections are pull-only", async () => {
        // Nothing in the plugin dirties a collection, so the pull does not
        // read local state before overwriting. A row that somehow carried a
        // dirty status would still be replaced rather than flagged.
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addCollection({ key: "CCCCCCCC", data: { name: "Original" } });
        await h.sync.startSync();

        await db.collections.update([USER_ID, "CCCCCCCC"], {
            syncStatus: "updated",
            name: "Somehow local",
        });
        lib.updateCollection("CCCCCCCC", { name: "Remote name" });

        await h.sync.startSync();

        const stored = (await db.collections.get([USER_ID, "CCCCCCCC"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.name).toBe("Remote name");
        expect(stored.serverCopyRaw).toBeUndefined();
    });

    test("a remotely deleted collection is removed locally", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addCollection({ key: "CCCCCCCC" });
        lib.addCollection({ key: "DDDDDDDD" });
        await h.sync.startSync();

        lib.deleteCollection("CCCCCCCC");
        await h.sync.startSync();

        expect((await db.collections.toArray()).map((c) => c.key)).toEqual([
            "DDDDDDDD",
        ]);
    });

    test("deleting a collection cascades through nested subcollections", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addCollection({ key: "ROOTCOLL" });
        await h.sync.startSync();

        await seedCollection({
            libraryID: USER_ID,
            key: "CHILDCOL",
            parentCollection: "ROOTCOLL",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "GRANDCOL",
            parentCollection: "CHILDCOL",
        });

        lib.deleteCollection("ROOTCOLL");
        await h.sync.startSync();

        expect(await db.collections.count()).toBe(0);
    });

    test("a cyclic parentCollection does not stall the deletion cascade", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addCollection({ key: "COLLAAAA" });
        await h.sync.startSync();

        await db.collections.update([USER_ID, "COLLAAAA"], {
            parentCollection: "COLLBBBB",
        });
        await seedCollection({
            libraryID: USER_ID,
            key: "COLLBBBB",
            parentCollection: "COLLAAAA",
        });

        lib.deleteCollection("COLLAAAA");
        const result = await h.sync.startSync();

        expect(result.failCount).toBe(0);
        expect(await db.collections.count()).toBe(0);
    });

    test("a tombstone for a collection we never had is ignored", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addCollection({ key: "CCCCCCCC" });
        await h.sync.startSync();

        lib.addCollection({ key: "NEVERHAD" });
        lib.deleteCollection("NEVERHAD");
        await h.sync.startSync();

        expect((await db.collections.toArray()).map((c) => c.key)).toEqual([
            "CCCCCCCC",
        ]);
        expect(h.host.logsAt("error")).toHaveLength(0);
    });

    test("collections are pulled before items", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addCollection({ key: "CCCCCCCC" });
        lib.addItem({ key: "AAAAAAAA", data: { collections: ["CCCCCCCC"] } });

        await h.sync.startSync();

        const firstCollection = h.server.requests.findIndex((r) =>
            r.path.endsWith("/collections"),
        );
        const firstItem = h.server.requests.findIndex((r) =>
            r.path.endsWith("/items"),
        );
        // An item referencing a collection must not land before the collection.
        expect(firstCollection).toBeLessThan(firstItem);
    });
});

describe("pull failures", () => {
    test("a failed collection pull aborts the library and is reported", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        h.server.failNext({ status: 500, pathIncludes: "/collections" });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(1);
        // Items are pulled after collections, so nothing was stored.
        expect(await db.items.count()).toBe(0);
    });

    test("a failed item pull leaves the stored version untouched", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        h.server.failNext({
            status: 500,
            pathIncludes: "/items",
            method: "GET",
        });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(1);
        expect((await db.libraries.get(USER_ID))!.itemVersion).toBe(0);
    });
});
