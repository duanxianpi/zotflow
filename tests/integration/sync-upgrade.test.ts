/**
 * The first syncs after the v6 → v7 upgrade, for states 1.6.6 (8f85e05)
 * left that only a sync can settle: a database is synced, rewritten as
 * 1.6.6 would have left it, reopened (the migration runs) and synced again.
 *
 * The live test (tests/live/sync/upgrade.live.mjs) has 1.6.6 make these
 * states itself, but there several of them share one sync, and one can
 * settle another by chance (a full sync started for one item repairs the
 * rest); here each stands alone.
 */
import Dexie from "dexie";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "db/db";
import { createLocalItems, newLocalItem } from "db/mutate";
import { ConflictService } from "worker/services/conflict";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { AnyIDBZoteroItem } from "types/db-schema";
import type { SyncHarness } from "../fakes/sync-harness";

let h: SyncHarness;
afterEach(() => h?.dispose());

type Row = Record<string, unknown> & { key: string };

/**
 * Rewrites the local database as 1.6.6 stored it (Dexie v6, all sync state
 * in `syncStatus`), with `edit` applied to the item rows, then reopens it
 * with this build, which migrates it.
 */
async function asV6(edit: (rows: Row[]) => Row[]) {
    const keys = await db.keys.toArray();
    const groups = await db.groups.toArray();
    const libraries = (await db.libraries.toArray()).map(
        ({ id, type, name, itemVersion, collectionVersion, syncedAt }) => ({ id, type, name, itemVersion, collectionVersion, syncedAt }),
    );
    const collections = (await db.collections.toArray()).map((c) => ({ ...c, syncStatus: "synced" }));
    const items: Row[] = (await db.items.toArray()).map((r) => {
        const { synced: _s, localRevision: _r, localOnly: _l, ...rest } = r as unknown as Row;
        return { ...rest, syncStatus: "synced", syncError: "" };
    });
    db.close();
    await db.delete();

    const legacy = new Dexie(db.name);
    legacy.version(6).stores({
        keys: "&key",
        groups: "&id",
        libraries: "&id",
        collections: `&[libraryID+key], [libraryID+trashed],
            [libraryID+syncStatus], [libraryID+parentCollection]`,
        items: `&[libraryID+key], [libraryID+syncStatus],
            [libraryID+itemType+trashed],
            [libraryID+parentItem+itemType+trashed],
            *collections, *searchCreators, *searchTags, dateModified,
            lastAccessedAt`,
        files: "&[libraryID+key], md5, lastAccessedAt",
        cslCache: "&key",
    });
    await legacy.open();
    await legacy.table("keys").bulkPut(keys);
    await legacy.table("groups").bulkPut(groups);
    await legacy.table("libraries").bulkPut(libraries);
    await legacy.table("collections").bulkPut(collections);
    await legacy.table("items").bulkPut(edit(items));
    legacy.close();
    await db.open();
}

const writes = () => h.server.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);

describe("the first sync after the upgrade", () => {
    test("a database in step with the server writes nothing", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "A" } });
        lib.addItem({ key: "NOTEAAAA", data: { itemType: "note", parentItem: "AAAAAAAA", note: "<p>n</p>" } });
        await h.sync.startSync();

        await asV6((rows) => rows);
        h.server.clearRequests();
        await h.sync.startSync();

        expect(writes()).toEqual([]);
        expect((await db.items.toArray()).map((r) => r.syncStatus)).toEqual(["synced", "synced"]);
    });

    test("an item 1.6.6 dropped here (Accept Remote on a refused write) comes back", async () => {
        // 1.6.6's Accept Remote on a conflict with no server copy deleted
        // the row; the server kept the item, and the download cursor was
        // already past it, so no delta lists it again.
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "Refused once" } });
        lib.addItem({ key: "BBBBBBBB", data: { title: "Other" } });
        await h.sync.startSync();

        await asV6((rows) => rows.filter((r) => r.key !== "AAAAAAAA"));
        await h.sync.startSync();

        expect(await db.items.get([USER_ID, "AAAAAAAA"])).toMatchObject({ syncStatus: "synced", title: "Refused once" });
        expect(writes()).toEqual([]);
    });

    describe("a row 1.6.6 left under a parent it dropped", () => {
        // A note created under an item that was then deleted in Zotero made
        // the deletion a conflict; 1.6.6's Accept Remote removed only the
        // parent's row. The note, never uploaded, has nowhere to go.
        async function orphan(itemType: "note" | "attachment" = "note") {
            h = await createSyncHarness();
            const lib = h.server.library(USER_ID);
            lib.addItem({ key: "PARENT01", data: { title: "Deleted in Zotero" } });
            await h.sync.startSync();
            const parent = (await db.items.get([USER_ID, "PARENT01"]))!;
            lib.deleteItem("PARENT01");

            const data =
                itemType === "note"
                    ? { itemType, note: "<p>orphan</p>" }
                    : { itemType, linkMode: "linked_url", url: "https://example.org", title: "Link" };
            await asV6((rows) => [
                ...rows.filter((r) => r.key !== "PARENT01"),
                {
                    ...(parent as unknown as Row),
                    key: "ORPHAN01",
                    itemType,
                    parentItem: "PARENT01",
                    title: "orphan",
                    version: 0,
                    syncStatus: "created",
                    syncError: "",
                    raw: {
                        key: "ORPHAN01",
                        version: 0,
                        library: parent.raw.library,
                        data: { key: "ORPHAN01", version: 0, parentItem: "PARENT01", tags: [], relations: {}, deleted: false, ...data },
                    },
                },
            ]);
            h.server.clearRequests();
            await h.sync.startSync();
            return lib;
        }

        test("is listed and never uploaded", async () => {
            const lib = await orphan();
            await h.sync.startSync();

            const info = (await new ConflictService(h.host).getItemConflicts()).find((c) => c.key === "ORPHAN01");
            expect(info).toMatchObject({ kind: "refused" });
            expect(info!.keepLocalBlocked).toBeUndefined();
            expect(info!.acceptRemoteBlocked).toBeUndefined();
            expect((await db.items.get([USER_ID, "ORPHAN01"]))?.raw.data).toMatchObject({ note: "<p>orphan</p>" });
            expect(writes()).toEqual([]);
            expect(lib.items.has("ORPHAN01")).toBe(false);
        });

        test("Keep Local on a note uploads it as a standalone note", async () => {
            const lib = await orphan();
            await new ConflictService(h.host).resolveItemConflict(USER_ID, "ORPHAN01", "keep-local");
            await h.sync.startSync();

            expect(lib.items.get("ORPHAN01")?.data).toMatchObject({ itemType: "note", note: "<p>orphan</p>" });
            expect(lib.items.get("ORPHAN01")!.data.parentItem).toBeUndefined();
            expect(await db.items.get([USER_ID, "ORPHAN01"])).toMatchObject({ syncStatus: "synced", parentItem: "" });
            expect(await db.syncConflicts.count()).toBe(0);
        });

        test("Accept Remote discards it", async () => {
            const lib = await orphan();
            await new ConflictService(h.host).resolveItemConflict(USER_ID, "ORPHAN01", "accept-remote");
            await h.sync.startSync();

            expect(await db.items.get([USER_ID, "ORPHAN01"])).toBeUndefined();
            expect(lib.items.has("ORPHAN01")).toBe(false);
            expect(await db.syncConflicts.count()).toBe(0);
        });

        test("anything but a note can only be discarded", async () => {
            await orphan("attachment");
            const service = new ConflictService(h.host);
            const info = (await service.getItemConflicts()).find((c) => c.key === "ORPHAN01");
            expect(info!.keepLocalBlocked).toMatch(/only a note/);
            await expect(service.resolveItemConflict(USER_ID, "ORPHAN01", "keep-local")).rejects.toThrow(/only a note/);
            expect(await service.resolveAllItemConflicts("keep-local")).toBe(0);
            expect(await db.syncConflicts.get([USER_ID, "ORPHAN01"])).toBeDefined();
        });
    });
});

describe("an orphan in this version", () => {
    test("a write refused for a parent that exists nowhere is listed once, not retried every round", async () => {
        // A guard: v7 itself should not produce this state, but a row under
        // a parent with no row would otherwise be sent again on every
        // upload round of every sync.
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "PARENT01", data: { title: "P" } });
        await h.sync.startSync();
        const parent = (await db.items.get([USER_ID, "PARENT01"]))!;
        const note = "NOTEAAAA";
        await createLocalItems(USER_ID, [
            newLocalItem(
                {
                    key: note,
                    version: 0,
                    library: parent.raw.library,
                    links: {},
                    meta: {},
                    data: { key: note, version: 0, itemType: "note", parentItem: "PARENT01", note: "<p>n</p>", tags: [], relations: {} },
                } as never,
                USER_ID,
                "push",
            ) as AnyIDBZoteroItem,
        ]);
        lib.deleteItem("PARENT01");
        // The parent's row gone without a trace, as 1.6.6 left it.
        await db.items.delete([USER_ID, "PARENT01"]);

        h.server.clearRequests();
        await h.sync.startSync();
        // One POST refused as a whole (the parent's deletion moved the
        // library), then the one that is refused for the missing parent.
        expect(writes()).toEqual(["POST /users/1/items", "POST /users/1/items"]);
        expect(await db.syncConflicts.get([USER_ID, note])).toMatchObject({ kind: "refused", orphan: true });

        h.server.clearRequests();
        await h.sync.startSync();
        expect(writes()).toEqual([]);
        expect(await db.syncConflicts.get([USER_ID, note])).toMatchObject({ kind: "refused", orphan: true });
    });
});
