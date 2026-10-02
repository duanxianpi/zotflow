/**
 * ConflictService — what the Activity Center shows for a conflict, and what
 * resolving it does to the DB.
 *
 * Items only: collections are pull-only, so they never enter a dirty state and
 * cannot conflict.
 *
 * The stakes are asymmetric: "keep local" must leave a row the next upload
 * can send as a patch against the server copy (so remote changes nobody chose
 * against survive), and "accept remote" must only discard what was listed.
 */
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { ConflictService } from "worker/services/conflict";
import { db, resetDb, seedItem, seedLibrary } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";

import type { FakeParentHost } from "../fakes/parent-host";
import type { IDBSyncConflict } from "types/db-schema";

const LIB = 1;
const GROUP = 777;
const AT = "2026-10-01T00:00:00Z";

let host: FakeParentHost;
let conflict: ConflictService;

beforeEach(async () => {
    await resetDb();
    await seedLibrary({ id: LIB, type: "user", name: "My Library" });
    host = createFakeParentHost();
    conflict = new ConflictService(host);
});

afterEach(() => vi.restoreAllMocks());

async function addConflict(c: Partial<IDBSyncConflict> & { key: string; kind: IDBSyncConflict["kind"] }, libraryID = LIB) {
    await db.syncConflicts.put({ libraryID, remoteVersion: 0, fields: [], createdAt: AT, ...c });
}

const article = (key: string, version: number, fields: Record<string, unknown>) => ({
    key,
    version,
    itemType: "journalArticle",
    title: "Original",
    pages: "1-10",
    tags: [],
    ...fields,
});

/**
 * Changed on both sides: base v3 "Original", local "Local title", remote v7
 * "Remote title" plus a publisher the local side never touched.
 */
async function conflictedItem(key = "ARTICLE1") {
    await seedItem({
        libraryID: LIB,
        key,
        syncStatus: "conflict",
        title: "Local title",
        version: 3,
        raw: { key, version: 3, library: { type: "user", id: LIB, name: "L" }, data: article(key, 3, { title: "Local title" }) } as any,
    });
    await db.syncCache.put({ libraryID: LIB, key, version: 3, data: article(key, 3, {}) });
    await addConflict({
        key,
        kind: "changed",
        remote: article(key, 7, { title: "Remote title", publisher: "Remote Press" }),
        remoteVersion: 7,
        fields: ["title"],
    });
}

/** A parent deleted in Zotero with a changed note under it: one group. */
async function deletedFamily() {
    await seedItem({ libraryID: LIB, key: "PARENT01", syncStatus: "conflict", synced: 1 });
    await seedItem({
        libraryID: LIB,
        key: "NOTEAAAA",
        itemType: "note",
        parentItem: "PARENT01",
        syncStatus: "conflict",
        raw: { key: "NOTEAAAA", version: 1, data: { key: "NOTEAAAA", version: 1, itemType: "note", parentItem: "PARENT01", note: "<p>local</p>" } } as any,
    });
    await seedItem({ libraryID: LIB, key: "ANNOLOCL", itemType: "annotation", parentItem: "NOTEAAAA", syncStatus: "ignore" });
    for (const key of ["PARENT01", "NOTEAAAA"]) await addConflict({ key, kind: "remote-deleted", group: "PARENT01" });
    await db.syncGroups.put({ libraryID: LIB, id: "PARENT01", root: "PARENT01", members: ["PARENT01", "NOTEAAAA"] });
}

describe("listing conflicts", () => {
    test("only conflicts are reported", async () => {
        await conflictedItem();
        await seedItem({ libraryID: LIB, key: "SYNCED01", syncStatus: "synced" });
        await seedItem({ libraryID: LIB, key: "UPDATED1", syncStatus: "updated" });

        const conflicts = await conflict.getItemConflicts();
        expect(conflicts.map((c) => c.key)).toEqual(["ARTICLE1"]);
    });

    test("every library is scanned", async () => {
        await seedLibrary({ id: GROUP, type: "group", name: "Group" });
        await conflictedItem();
        await seedItem({ libraryID: GROUP, key: "GROUPITM", syncStatus: "conflict" });
        await addConflict({ key: "GROUPITM", kind: "refused", error: "400: bad" }, GROUP);

        const conflicts = await conflict.getItemConflicts();
        expect(conflicts.map((c) => c.key).sort()).toEqual(["ARTICLE1", "GROUPITM"]);
    });

    test("a titleless item is labelled by type and key", async () => {
        await seedItem({ libraryID: LIB, key: "ANNOTAT1", itemType: "annotation", title: "", syncStatus: "conflict" });
        await addConflict({ key: "ANNOTAT1", kind: "refused", error: "413: too long" });

        const [info] = await conflict.getItemConflicts();
        expect(info!.title).toBe("annotation (ANNOTAT1)");
    });

    test("a group is listed together, its root first", async () => {
        await deletedFamily();
        await conflictedItem("AAAAAAAA");

        const infos = await conflict.getItemConflicts();
        expect(infos.map((c) => c.key)).toEqual(["AAAAAAAA", "PARENT01", "NOTEAAAA"]);
        expect(infos[1]).toMatchObject({ group: "PARENT01", groupSize: 2 });
    });

    test("an item deleted here is listed from its delete log", async () => {
        await db.syncDeleteLog.put({
            libraryID: LIB,
            key: "ANNOAAAA",
            itemType: "annotation",
            parentItem: "ATTACH01",
            version: 4,
            dateDeleted: AT,
            snapshot: { key: "ANNOAAAA", itemType: "annotation", title: "" } as any,
        });
        await addConflict({ key: "ANNOAAAA", kind: "local-deleted", remote: { annotationComment: "remote" }, remoteVersion: 9 });

        const [info] = await conflict.getItemConflicts();
        expect(info).toMatchObject({ key: "ANNOAAAA", itemType: "annotation", kind: "local-deleted", conflictType: "delete" });
        expect(info!.localData).toEqual({ deleted: true });
    });

    test("a read failure is reported as a DB error", async () => {
        vi.spyOn(db.syncConflicts, "toArray").mockRejectedValue(new Error("boom"));
        await expect(conflict.getItemConflicts()).rejects.toThrow(/Failed to query item conflicts/i);
    });
});

describe("conflict classification", () => {
    test.each([
        ["changed", "update"],
        ["remote-deleted", "delete"],
        ["local-deleted", "delete"],
        ["refused", "push"],
    ] as const)("%s is shown as %s", async (kind, type) => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", syncStatus: "conflict" });
        await addConflict({ key: "ARTICLE1", kind, remote: { title: "r" }, remoteVersion: 2 });
        const [info] = await conflict.getItemConflicts();
        expect(info).toMatchObject({ kind, conflictType: type });
    });

    test("a refusal carries the server's reason", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", syncStatus: "conflict" });
        await addConflict({ key: "ARTICLE1", kind: "refused", error: "413: Tag too long" });
        const [info] = await conflict.getItemConflicts();
        expect(info!.syncError).toBe("413: Tag too long");
    });
});

describe("field diffs", () => {
    test("only differing fields are listed", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();

        const fields = Object.fromEntries(info!.fields.map((f) => [f.field, [f.localValue, f.remoteValue]]));
        expect(fields.title).toEqual(["Local title", "Remote title"]);
        expect(fields.publisher).toEqual(["(undefined)", "Remote Press"]);
        expect(fields).not.toHaveProperty("pages");
    });

    test("key and version are never shown as differences", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();
        expect(info!.fields.map((f) => f.field)).not.toContain("key");
        expect(info!.fields.map((f) => f.field)).not.toContain("version");
    });

    test("a remote deletion is shown as a whole-item diff", async () => {
        await deletedFamily();
        const info = (await conflict.getItemConflicts()).find((c) => c.key === "NOTEAAAA")!;

        expect(info.fields).toHaveLength(1);
        expect(info.fields[0]!.field).toBe("(entire item)");
        expect(info.fields[0]!.remoteValue).toBe("(deleted on server)");
        expect(info.fields[0]!.localValue).toContain("local");
    });

    test("structured values are stringified for display", async () => {
        await seedItem({
            libraryID: LIB,
            key: "ARTICLE1",
            syncStatus: "conflict",
            raw: { key: "ARTICLE1", data: { key: "ARTICLE1", tags: [{ tag: "local" }], extra: null } } as any,
        });
        await addConflict({ key: "ARTICLE1", kind: "changed", remote: { key: "ARTICLE1", tags: [{ tag: "remote" }], extra: 42 }, remoteVersion: 2 });
        const [info] = await conflict.getItemConflicts();

        const fields = Object.fromEntries(info!.fields.map((f) => [f.field, [f.localValue, f.remoteValue]]));
        expect(fields.tags![0]).toContain('"tag": "local"');
        expect(fields.extra).toEqual(["(null)", "42"]);
    });
});

describe("resolving a changed item", () => {
    test("keep-local keeps the local side and the remote changes that did not conflict", async () => {
        await conflictedItem();

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.syncStatus).toBe("updated");
        expect(stored.raw.data).toMatchObject({ title: "Local title", publisher: "Remote Press" });
        expect(await db.syncConflicts.count()).toBe(0);
    });

    test("keep-local bases the next upload on the server copy", async () => {
        // The next upload is a patch against this base at this version, so
        // it neither 412s on a stale version nor reverts the remote fields.
        await conflictedItem();

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.version).toBe(7);
        const cache = (await db.syncCache.get([LIB, "ARTICLE1"]))!;
        expect(cache.version).toBe(7);
        expect(cache.data.title).toBe("Remote title");
    });

    test("keep-local takes per-field choices when given", async () => {
        await conflictedItem();

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local", article("ARTICLE1", 7, { title: "Chosen", publisher: "Remote Press" }));

        expect((await db.items.get([LIB, "ARTICLE1"]))!.raw.data).toMatchObject({ title: "Chosen" });
    });

    test("accept-remote replaces the row and re-derives its fields", async () => {
        await conflictedItem();

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.title).toBe("Remote title");
        expect(stored.version).toBe(7);
        expect(await db.syncCache.count()).toBe(0);
    });
});

describe("resolving a remote deletion (a group)", () => {
    test("keep-local recreates every member", async () => {
        await deletedFamily();

        await conflict.resolveItemConflict(LIB, "NOTEAAAA", "keep-local");

        for (const key of ["PARENT01", "NOTEAAAA"]) {
            const row = (await db.items.get([LIB, key]))!;
            expect(row.syncStatus).toBe("created");
            expect(row.version).toBe(0);
        }
        expect(await db.syncConflicts.count()).toBe(0);
        expect(await db.syncGroups.count()).toBe(0);
    });

    test("accept-remote removes the members and everything under them", async () => {
        await deletedFamily();
        await seedItem({ libraryID: LIB, key: "OTHER001", syncStatus: "synced" });

        await conflict.resolveItemConflict(LIB, "PARENT01", "accept-remote");

        expect((await db.items.toArray()).map((r) => r.key)).toEqual(["OTHER001"]);
        expect(await db.syncConflicts.count()).toBe(0);
    });
});

describe("resolving a local deletion", () => {
    beforeEach(async () => {
        await db.syncDeleteLog.put({
            libraryID: LIB,
            key: "ANNOAAAA",
            itemType: "annotation",
            parentItem: "",
            version: 4,
            dateDeleted: AT,
            snapshot: { libraryID: LIB, key: "ANNOAAAA", itemType: "annotation", parentItem: "", version: 4, synced: 1, raw: { key: "ANNOAAAA", data: { key: "ANNOAAAA", itemType: "annotation", annotationComment: "old" } } } as any,
        });
        await addConflict({ key: "ANNOAAAA", kind: "local-deleted", remote: { key: "ANNOAAAA", itemType: "annotation", annotationComment: "remote" }, remoteVersion: 9 });
    });

    test("keep-local keeps the delete, now against the remote version", async () => {
        await conflict.resolveItemConflict(LIB, "ANNOAAAA", "keep-local");

        expect((await db.syncDeleteLog.get([LIB, "ANNOAAAA"]))!.version).toBe(9);
        expect(await db.items.count()).toBe(0);
    });

    test("accept-remote restores the item from the server copy", async () => {
        await conflict.resolveItemConflict(LIB, "ANNOAAAA", "accept-remote");

        const row = (await db.items.get([LIB, "ANNOAAAA"]))!;
        expect(row.syncStatus).toBe("synced");
        expect(row.version).toBe(9);
        expect(row.raw.data).toMatchObject({ annotationComment: "remote" });
        expect(await db.syncDeleteLog.count()).toBe(0);
    });
});

describe("resolving a refusal", () => {
    test("keep-local retries the upload", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", syncStatus: "conflict" });
        await addConflict({ key: "ARTICLE1", kind: "refused", error: "500: x" });

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local");

        expect((await db.items.get([LIB, "ARTICLE1"]))!.syncStatus).toBe("updated");
    });

    test("accept-remote restores the server copy rather than deleting", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", syncStatus: "conflict" });
        await addConflict({ key: "ARTICLE1", kind: "refused", error: "413: x", remote: article("ARTICLE1", 5, {}), remoteVersion: 5 });

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote");

        const row = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(row).toMatchObject({ syncStatus: "synced", version: 5, title: "Original" });
    });

    test("accept-remote of a refused create removes it", async () => {
        await seedItem({ libraryID: LIB, key: "NEWNOTE1", syncStatus: "conflict", version: 0 });
        await addConflict({ key: "NEWNOTE1", kind: "refused", error: "400: x" });

        await conflict.resolveItemConflict(LIB, "NEWNOTE1", "accept-remote");

        expect(await db.items.count()).toBe(0);
    });

    test("accept-remote without a server copy is unavailable, and says why", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", syncStatus: "conflict" });
        await addConflict({ key: "ARTICLE1", kind: "refused", error: "413: x" });

        const [info] = await conflict.getItemConflicts();
        expect(info!.acceptRemoteBlocked).toMatch(/server's copy/);
        await expect(conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote")).rejects.toThrow();
        expect(await db.syncConflicts.count()).toBe(1);
    });
});

describe("resolution guards", () => {
    test("a row that is no longer in conflict is skipped, not clobbered", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", syncStatus: "synced", title: "Already resolved" });

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.title).toBe("Already resolved");
        expect(host.logsAt("warn").some((l) => /is not in conflict/.test(l.message))).toBe(true);
    });

    test("an unknown row is an error, not a silent no-op", async () => {
        await expect(conflict.resolveItemConflict(LIB, "MISSING1", "keep-local")).rejects.toThrow(/Item not found: 1\/MISSING1/);
    });

    test("resolution is logged with the action taken", async () => {
        await conflictedItem();
        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local");
        expect(host.logsAt("info").some((l) => /Resolved item conflict ARTICLE1 → keep-local/.test(l.message))).toBe(true);
    });
});

describe("batch resolution", () => {
    test("every conflict is resolved, a group once", async () => {
        await conflictedItem();
        await deletedFamily();
        await seedItem({ libraryID: LIB, key: "SYNCED01", syncStatus: "synced" });

        expect(await conflict.resolveAllItemConflicts("keep-local")).toBe(2);

        expect((await db.items.get([LIB, "ARTICLE1"]))!.syncStatus).toBe("updated");
        expect((await db.items.get([LIB, "PARENT01"]))!.syncStatus).toBe("created");
        expect((await db.items.get([LIB, "NOTEAAAA"]))!.syncStatus).toBe("created");
        expect((await db.items.get([LIB, "SYNCED01"]))!.syncStatus).toBe("synced");
        expect(await conflict.getItemConflicts()).toEqual([]);
    });

    test("accept-remote in bulk skips what cannot accept remote", async () => {
        await deletedFamily();
        await seedItem({ libraryID: LIB, key: "ARTICLE2", syncStatus: "conflict" });
        await addConflict({ key: "ARTICLE2", kind: "refused", error: "413: x" });

        expect(await conflict.resolveAllItemConflicts("accept-remote")).toBe(1);
        expect((await db.items.toArray()).map((r) => r.key)).toEqual(["ARTICLE2"]);
    });

    test("nothing to resolve reports zero", async () => {
        expect(await conflict.resolveAllItemConflicts("keep-local")).toBe(0);
    });

    test("a failure mid-batch propagates rather than being swallowed", async () => {
        await conflictedItem();
        await conflictedItem("ARTICLE2");
        vi.spyOn(db.items, "put").mockRejectedValue(new Error("disk full"));

        await expect(conflict.resolveAllItemConflicts("keep-local")).rejects.toThrow(/Failed to resolve item conflict/i);
    });
});
