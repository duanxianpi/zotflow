/**
 * Dexie version upgrades that rewrite stored rows.
 *
 * Each test builds a database at the previous schema version by hand, seeds
 * it the way older plugin versions stored rows, then opens the real `db` so
 * the upgrade chain runs exactly as it does for an existing user.
 */
import Dexie from "dexie";
import { describe, test, expect, beforeEach } from "vitest";

import { db } from "db/db";

import type { AnyIDBZoteroItem } from "types/db-schema";

const LIB = 1;

/** Open the database at v5, the schema before titles were base-mapped. */
async function openV5(): Promise<Dexie> {
    const legacy = new Dexie(db.name);
    legacy.version(5).stores({
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
    return legacy;
}

/** A row as v5 stored it: `title` computed from `data.title` only. */
function legacyRow(
    key: string,
    itemType: string,
    data: Record<string, unknown>,
    title = "",
) {
    return {
        libraryID: LIB,
        key,
        itemType,
        title,
        parentItem: "",
        trashed: 0,
        collections: [],
        searchCreators: [],
        searchTags: [],
        raw: { key, data: { key, itemType, ...data } },
    };
}

beforeEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
});

describe("v6: base-mapped titles", () => {
    test("backfills the titles v5 stored empty", async () => {
        const legacy = await openV5();
        await legacy
            .table("items")
            .bulkPut([
                legacyRow("CASE0001", "case", { caseName: "Roe v. Wade" }),
                legacyRow("STAT0001", "statute", {
                    nameOfAct: "Clean Air Act",
                }),
                legacyRow("MAIL0001", "email", { subject: "Re: draft" }),
            ]);
        legacy.close();

        await db.open();
        const titles = (await db.items.toArray()).map((i: AnyIDBZoteroItem) => [
            i.key,
            i.title,
        ]);
        expect(Object.fromEntries(titles)).toEqual({
            CASE0001: "Roe v. Wade",
            STAT0001: "Clean Air Act",
            MAIL0001: "Re: draft",
        });
    });

    test("leaves other rows untouched", async () => {
        const legacy = await openV5();
        await legacy
            .table("items")
            .bulkPut([
                legacyRow("ARTICLE1", "journalArticle", {}, ""),
                legacyRow("CASE0002", "case", { caseName: "New" }, "Kept"),
            ]);
        legacy.close();

        await db.open();
        expect((await db.items.get([LIB, "ARTICLE1"]))?.title).toBe("");
        expect((await db.items.get([LIB, "CASE0002"]))?.title).toBe("Kept");
    });
});

/** Open the database at v6, the schema before the v7 sync model. */
async function openV6(): Promise<Dexie> {
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
    return legacy;
}

/** A row as v6 stored it, sync state in `syncStatus` / `syncError` / `serverCopyRaw`. */
function v6Row(
    key: string,
    syncStatus: string,
    extra: Record<string, unknown> = {},
    data: Record<string, unknown> = {},
) {
    const version = (extra.version as number | undefined) ?? 5;
    return {
        libraryID: LIB,
        key,
        itemType: (data.itemType as string | undefined) ?? "journalArticle",
        title: (data.title as string | undefined) ?? key,
        parentItem: (data.parentItem as string | undefined) ?? "",
        trashed: 0,
        collections: [],
        searchCreators: [],
        searchTags: [],
        version,
        syncStatus,
        syncError: "",
        raw: { key, version, data: { key, version, itemType: "journalArticle", title: key, ...data } },
        ...extra,
    };
}

describe("v7: the sync model", () => {
    async function migrate(rows: Record<string, unknown>[]) {
        const legacy = await openV6();
        await legacy.table("items").bulkPut(rows);
        legacy.close();
        await db.open();
    }

    test("synced, created and updated rows map to synced/version", async () => {
        await migrate([
            v6Row("SYNCED01", "synced"),
            v6Row("CREATED1", "created", { version: 0 }),
            v6Row("UPDATED1", "updated"),
        ]);

        expect(await db.items.get([LIB, "SYNCED01"])).toMatchObject({ synced: 1, syncStatus: "synced" });
        expect(await db.items.get([LIB, "CREATED1"])).toMatchObject({ synced: 0, version: 0, syncStatus: "created" });
        expect(await db.items.get([LIB, "UPDATED1"])).toMatchObject({ synced: 0, syncStatus: "updated" });
        // No merge base exists for v6 edits; the merge falls back to reconcile2.
        expect(await db.syncCache.count()).toBe(0);
    });

    test("a pending delete leaves its row for the delete log", async () => {
        await migrate([v6Row("ANNOTAT1", "deleted", {}, { itemType: "annotation", parentItem: "ATTACH01" })]);

        expect(await db.items.get([LIB, "ANNOTAT1"])).toBeUndefined();
        expect(await db.syncDeleteLog.get([LIB, "ANNOTAT1"])).toMatchObject({
            itemType: "annotation",
            parentItem: "ATTACH01",
            version: 5,
        });
    });

    test("a conflict with a server copy becomes a changed conflict", async () => {
        await migrate([
            v6Row("ARTICLE1", "conflict", {
                syncError: "Remote update conflict",
                serverCopyRaw: { key: "ARTICLE1", version: 9, data: { key: "ARTICLE1", version: 9, itemType: "journalArticle", title: "Remote" } },
            }),
        ]);

        expect(await db.syncConflicts.get([LIB, "ARTICLE1"])).toMatchObject({
            kind: "changed",
            remoteVersion: 9,
            fields: ["title"],
        });
        const row = (await db.items.get([LIB, "ARTICLE1"])) as unknown as Record<string, unknown>;
        expect(row).toMatchObject({ syncStatus: "conflict", synced: 0 });
        expect(row).not.toHaveProperty("serverCopyRaw");
        expect(row).not.toHaveProperty("syncError");
    });

    test("a blocked remote deletion becomes a group of the root and its descendants", async () => {
        await migrate([
            v6Row("PARENT01", "conflict", { syncError: "Remote deletion blocked: Contains unsynced local changes." }),
            v6Row("NOTEAAAA", "updated", {}, { itemType: "note", parentItem: "PARENT01" }),
            v6Row("OTHER001", "synced"),
        ]);

        expect((await db.syncGroups.get([LIB, "PARENT01"]))!.members.sort()).toEqual(["NOTEAAAA", "PARENT01"]);
        for (const key of ["PARENT01", "NOTEAAAA"]) {
            expect(await db.syncConflicts.get([LIB, key])).toMatchObject({ kind: "remote-deleted", group: "PARENT01" });
            expect((await db.items.get([LIB, key]))!.syncStatus).toBe("conflict");
        }
        expect((await db.items.get([LIB, "OTHER001"]))!.syncStatus).toBe("synced");
    });

    test("a descendant pending deletion leaves with its delete log, not as a group member", async () => {
        await migrate([
            v6Row("PARENT01", "conflict", { syncError: "Remote deletion blocked: Contains unsynced local changes." }),
            v6Row("NOTEAAAA", "updated", {}, { itemType: "note", parentItem: "PARENT01" }),
            v6Row("ANNOTAT1", "deleted", {}, { itemType: "annotation", parentItem: "PARENT01" }),
        ]);

        expect((await db.syncGroups.get([LIB, "PARENT01"]))!.members.sort()).toEqual(["NOTEAAAA", "PARENT01"]);
        expect(await db.syncConflicts.get([LIB, "ANNOTAT1"])).toBeUndefined();
        expect(await db.items.get([LIB, "ANNOTAT1"])).toBeUndefined();
        expect(await db.syncDeleteLog.get([LIB, "ANNOTAT1"])).toMatchObject({ itemType: "annotation" });
    });

    test("one remote deletion that marked a parent and its children becomes one group", async () => {
        // 1.6.6 marked every deleted key whose subtree held local changes:
        // here the book, its attachment and the edited annotation.
        const blocked = { syncError: "Remote deletion blocked: Contains unsynced local changes." };
        await migrate([
            v6Row("BOOK0001", "conflict", blocked),
            v6Row("EPUB0001", "conflict", blocked, { itemType: "attachment", parentItem: "BOOK0001" }),
            v6Row("ANNOTAT1", "conflict", blocked, { itemType: "annotation", parentItem: "EPUB0001" }),
        ]);

        const groups = await db.syncGroups.toArray();
        expect(groups.map((g) => g.id)).toEqual(["BOOK0001"]);
        expect(groups[0]!.members.sort()).toEqual(["ANNOTAT1", "BOOK0001", "EPUB0001"]);
        for (const key of ["BOOK0001", "EPUB0001", "ANNOTAT1"]) {
            expect(await db.syncConflicts.get([LIB, key])).toMatchObject({ kind: "remote-deleted", group: "BOOK0001" });
        }
    });

    describe("a remote deletion 1.6.6 blocked only for a delete made here", () => {
        // 1.6.6 counted a pending delete as a local change, so deleting an
        // annotation here and its book in Zotero marked the whole subtree.
        const blocked = { syncError: "Remote deletion blocked: Contains unsynced local changes." };
        const book = () => [
            v6Row("BOOK0001", "conflict", blocked),
            v6Row("EPUB0001", "conflict", blocked, { itemType: "attachment", parentItem: "BOOK0001" }),
            v6Row("ANNOTAT1", "conflict", blocked, { itemType: "annotation", parentItem: "EPUB0001", deleted: true }),
        ];

        test("is no conflict: the deletion applies", async () => {
            await migrate(book());

            expect(await db.items.count()).toBe(0);
            expect(await db.syncGroups.count()).toBe(0);
            expect(await db.syncConflicts.count()).toBe(0);
            expect(await db.syncDeleteLog.count()).toBe(0);
        });

        test("with an edit beside it, the group keeps the edit and drops the delete", async () => {
            await migrate([
                ...book(),
                v6Row("ANNOTAT2", "conflict", blocked, { itemType: "annotation", parentItem: "EPUB0001" }),
            ]);

            const groups = await db.syncGroups.toArray();
            expect(groups.map((g) => g.id)).toEqual(["BOOK0001"]);
            expect(groups[0]!.members.sort()).toEqual(["ANNOTAT2", "BOOK0001", "EPUB0001"]);
            expect(await db.items.get([LIB, "ANNOTAT1"])).toBeUndefined();
            expect(await db.syncDeleteLog.count()).toBe(0);
        });

        test("with a note created under it, the group stays", async () => {
            await migrate([...book(), v6Row("NOTE0001", "created", { version: 0 }, { itemType: "note", parentItem: "BOOK0001" })]);

            expect((await db.syncGroups.toArray()).map((g) => g.id)).toEqual(["BOOK0001"]);
            expect(await db.syncConflicts.get([LIB, "NOTE0001"])).toMatchObject({ kind: "remote-deleted", group: "BOOK0001" });
        });
    });

    describe("an annotation 1.6.6 deleted here", () => {
        // 1.6.6 deleted an annotation by flagging it; a conflict or a 412
        // on the DELETE then replaced the "deleted" status.
        const flagged = { itemType: "annotation", parentItem: "ATTACH01", deleted: true };

        test("still in conflict with a server copy is deleted here, changed there", async () => {
            await migrate([
                v6Row("ANNOTAT1", "conflict", {
                    syncError: "Remote update conflict",
                    serverCopyRaw: { key: "ANNOTAT1", version: 9, data: { key: "ANNOTAT1", version: 9, itemType: "annotation", annotationComment: "remote" } },
                }, flagged),
            ]);

            expect(await db.items.get([LIB, "ANNOTAT1"])).toBeUndefined();
            expect(await db.syncDeleteLog.get([LIB, "ANNOTAT1"])).toMatchObject({ version: 5 });
            expect(await db.syncConflicts.get([LIB, "ANNOTAT1"])).toMatchObject({ kind: "local-deleted", remoteVersion: 9 });
        });

        test("refused by a 412 stays a delete to send, not an edit uploading deleted: 1", async () => {
            await migrate([v6Row("ANNOTAT1", "conflict", { syncError: "Remote item has been modified since you deleted it." }, flagged)]);

            expect(await db.items.get([LIB, "ANNOTAT1"])).toBeUndefined();
            expect(await db.syncDeleteLog.get([LIB, "ANNOTAT1"])).toMatchObject({ version: 5 });
            expect(await db.syncConflicts.count()).toBe(0);
        });

        // An annotation in Zotero's trash carries the same flag: the API
        // accepts `deleted: 1` on one and keeps it in /items/trash.
        for (const status of ["synced", "updated"]) {
            test(`the flag alone on a ${status} row is the server's trash, not a delete`, async () => {
                await migrate([v6Row("ANNOTAT1", status, {}, { ...flagged, deleted: 1 })]);

                expect(await db.items.get([LIB, "ANNOTAT1"])).toMatchObject({ synced: status === "synced" ? 1 : 0 });
                expect(await db.syncDeleteLog.count()).toBe(0);
                expect(await db.syncConflicts.count()).toBe(0);
            });
        }

        test("in conflict with a server copy that is in the trash too is no delete", async () => {
            await migrate([
                v6Row("ANNOTAT1", "conflict", {
                    syncError: "Remote update conflict",
                    serverCopyRaw: { key: "ANNOTAT1", version: 9, data: { key: "ANNOTAT1", version: 9, itemType: "annotation", deleted: 1, annotationComment: "remote" } },
                }, flagged),
            ]);

            expect(await db.items.get([LIB, "ANNOTAT1"])).toBeDefined();
            expect(await db.syncDeleteLog.count()).toBe(0);
            expect(await db.syncConflicts.get([LIB, "ANNOTAT1"])).toMatchObject({ kind: "changed" });
        });

        test("deleted on the server too is simply gone", async () => {
            await migrate([v6Row("ANNOTAT1", "conflict", { syncError: "Remote deletion blocked: Contains unsynced local changes." }, flagged)]);

            expect(await db.items.get([LIB, "ANNOTAT1"])).toBeUndefined();
            expect(await db.syncDeleteLog.count()).toBe(0);
            expect(await db.syncConflicts.count()).toBe(0);
            expect(await db.syncGroups.count()).toBe(0);
        });
    });

    test("a refused write becomes a refused conflict", async () => {
        await migrate([v6Row("ARTICLE1", "conflict", { syncError: "413: Tag too long" })]);

        expect(await db.syncConflicts.get([LIB, "ARTICLE1"])).toMatchObject({ kind: "refused", error: "413: Tag too long" });
    });

    test("a conflict with no evidence of its kind becomes a plain unsynced row", async () => {
        await migrate([v6Row("ARTICLE1", "conflict", { syncError: "Remote item has been modified since you deleted it." })]);

        expect(await db.syncConflicts.count()).toBe(0);
        expect((await db.items.get([LIB, "ARTICLE1"]))!.syncStatus).toBe("updated");
    });

    test("ignore rows become local-only", async () => {
        await migrate([v6Row("EXTERN01", "ignore", {}, { itemType: "annotation" })]);

        expect(await db.items.get([LIB, "EXTERN01"])).toMatchObject({ localOnly: true, syncStatus: "ignore" });
    });
});
