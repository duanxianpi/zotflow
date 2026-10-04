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
import { ConvertService } from "worker/services/convert";
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
        expect(fields.publisher).toEqual(["", "Remote Press"]);
        expect(fields).not.toHaveProperty("pages");
    });

    test("key and version are never shown as differences", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();
        expect(info!.fields.map((f) => f.field)).not.toContain("key");
        expect(info!.fields.map((f) => f.field)).not.toContain("version");
    });

    test("a remote deletion lists the local side, with no remote value", async () => {
        await deletedFamily();
        const info = (await conflict.getItemConflicts()).find((c) => c.key === "NOTEAAAA")!;

        expect(info.fields.find((f) => f.field === "note")!.localValue).toContain("local");
        expect(info.fields.every((f) => f.remoteValue === undefined)).toBe(true);
    });

    test("tags are listed by name; other values are printed", async () => {
        await seedItem({
            libraryID: LIB,
            key: "ARTICLE1",
            syncStatus: "conflict",
            raw: { key: "ARTICLE1", data: { key: "ARTICLE1", tags: [{ tag: "local" }], extra: null } } as any,
        });
        await addConflict({ key: "ARTICLE1", kind: "changed", remote: { key: "ARTICLE1", tags: [{ tag: "remote" }], extra: 42 }, remoteVersion: 2 });
        const [info] = await conflict.getItemConflicts();

        const fields = Object.fromEntries(info!.fields.map((f) => [f.field, [f.localValue, f.remoteValue]]));
        expect(fields.tags).toEqual(["local", "remote"]);
        expect(fields.extra).toEqual(["", "42"]);
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

describe("merge preview", () => {
    test("each differing field says where a merge takes it from, conflicts first", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();

        expect(info!.fields.map((f) => [f.field, f.merge])).toEqual([
            ["title", "conflict"],
            ["publisher", "remote"],
        ]);
        expect(info!.fields[0]).toMatchObject({ baseValue: "Original", mergedValue: "Local title" });
        expect(info!.fields[1]).toMatchObject({ mergedValue: "Remote Press" });
    });

    test("a change made here only is kept and uploaded", async () => {
        await conflictedItem();
        const row = (await db.items.get([LIB, "ARTICLE1"]))!;
        (row.raw.data as unknown as Record<string, unknown>).pages = "5-6";
        await db.items.put(row);

        const [info] = await conflict.getItemConflicts();
        expect(info!.fields.find((f) => f.field === "pages")).toMatchObject({ merge: "local", mergedValue: "5-6" });
    });

    test("tags added on both sides are combined", async () => {
        await seedItem({
            libraryID: LIB,
            key: "ARTICLE1",
            syncStatus: "conflict",
            version: 3,
            raw: { key: "ARTICLE1", version: 3, data: article("ARTICLE1", 3, { title: "Local", tags: [{ tag: "mine" }] }) } as any,
        });
        await db.syncCache.put({ libraryID: LIB, key: "ARTICLE1", version: 3, data: article("ARTICLE1", 3, {}) });
        await addConflict({
            key: "ARTICLE1",
            kind: "changed",
            remote: article("ARTICLE1", 7, { title: "Remote", tags: [{ tag: "theirs" }] }),
            remoteVersion: 7,
            fields: ["title"],
        });

        const [info] = await conflict.getItemConflicts();
        const tags = info!.fields.find((f) => f.field === "tags")!;
        expect(tags.merge).toBe("combined");
        expect(tags.mergedValue).toContain("mine");
        expect(tags.mergedValue).toContain("theirs");
    });

    test("a changed item has no outcomes; the others have both", async () => {
        await conflictedItem();
        await deletedFamily();
        const infos = await conflict.getItemConflicts();

        expect(infos.find((c) => c.key === "ARTICLE1")!.outcomes).toBeUndefined();
        const member = infos.find((c) => c.key === "NOTEAAAA")!;
        expect(member.outcomes!["keep-local"]).toMatchObject({ push: 2, pull: 0 });
        expect(member.outcomes!["accept-remote"]).toMatchObject({ push: 0, pull: 2 });
        expect(member.outcomes!["accept-remote"].loses).toBeTruthy();
    });
});

describe("conflict details", () => {
    test("an edit on both sides names the version both started from", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();

        expect(info!.details).toMatchObject({ label: "Edited on both sides", baseVersion: 3, localVersion: 3, detectedAt: AT });
        expect(info!.details.explanation).toMatch(/only you can say which version is right/);
        expect(info!.details.explanation).toMatch(/one other change merges automatically, unless you overwrite all fields/);
    });

    test("a member of a deletion group names the deleted item above it", async () => {
        await deletedFamily();
        const info = (await conflict.getItemConflicts()).find((c) => c.key === "NOTEAAAA")!;

        expect(info.details.label).toBe("Parent deleted in Zotero");
        expect(info.details.groupRoot).toMatchObject({ key: "PARENT01" });
        expect(info.details.parent).toMatchObject({ key: "PARENT01" });
    });

    test("a refusal carries the server's answer", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", syncStatus: "conflict" });
        await addConflict({ key: "ARTICLE1", kind: "refused", error: "413: Tag too long" });
        const [info] = await conflict.getItemConflicts();

        expect(info!.details).toMatchObject({ label: "Rejected by Zotero", serverError: "413: Tag too long" });
    });

    test("a local deletion lists what Zotero changed since this device's copy", async () => {
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

        const [info] = await conflict.getItemConflicts();
        expect(info!.fields).toEqual([{ field: "annotationComment", remoteValue: "remote", baseValue: "old" }]);
        expect(info!.details.label).toBe("Deleted here");
    });
});

describe("resolving changes that did not conflict", () => {
    test("accept-remote takes the remote value of conflicting fields and keeps local changes that did not conflict", async () => {
        await conflictedItem();
        const row = (await db.items.get([LIB, "ARTICLE1"]))!;
        (row.raw.data as unknown as Record<string, unknown>).pages = "5-6";
        await db.items.put(row);

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.raw.data).toMatchObject({ title: "Remote title", publisher: "Remote Press", pages: "5-6" });
        // The local change is still to be uploaded, as a patch on the server copy.
        expect(stored.syncStatus).toBe("updated");
        expect(stored.version).toBe(7);
        expect((await db.syncCache.get([LIB, "ARTICLE1"]))!.data.title).toBe("Remote title");
        expect(await db.syncConflicts.count()).toBe(0);
    });

    test("tags added on both sides are combined by either resolution", async () => {
        const seed = async () => {
            await resetDb();
            await seedLibrary({ id: LIB, type: "user", name: "My Library" });
            await seedItem({
                libraryID: LIB,
                key: "ARTICLE1",
                syncStatus: "conflict",
                version: 3,
                raw: { key: "ARTICLE1", version: 3, data: article("ARTICLE1", 3, { title: "Local", tags: [{ tag: "mine" }] }) } as any,
            });
            await db.syncCache.put({ libraryID: LIB, key: "ARTICLE1", version: 3, data: article("ARTICLE1", 3, {}) });
            await addConflict({ key: "ARTICLE1", kind: "changed", remote: article("ARTICLE1", 7, { title: "Remote", tags: [{ tag: "theirs" }] }), remoteVersion: 7, fields: ["title"] });
        };
        const tags = async () => ((await db.items.get([LIB, "ARTICLE1"]))!.raw.data.tags as { tag: string }[]).map((t) => t.tag).sort();

        for (const action of ["keep-local", "accept-remote"] as const) {
            await seed();
            await conflict.resolveItemConflict(LIB, "ARTICLE1", action);
            expect(await tags()).toEqual(["mine", "theirs"]);
        }
    });
});

describe("whole-copy resolutions", () => {
    test("keep-local-copy keeps the local data whole, undoing Zotero's other changes", async () => {
        await conflictedItem();

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "keep-local-copy");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.raw.data).toMatchObject({ title: "Local title" });
        expect(stored.raw.data).not.toHaveProperty("publisher");
        // Uploaded as a patch against the server copy, which then drops the publisher.
        expect(stored.syncStatus).toBe("updated");
        expect(stored.version).toBe(7);
        expect((await db.syncCache.get([LIB, "ARTICLE1"]))!.data.publisher).toBe("Remote Press");
        expect(await db.syncConflicts.count()).toBe(0);
    });

    test("accept-remote-copy takes Zotero's copy whole, dropping local changes that did not conflict", async () => {
        await conflictedItem();
        const row = (await db.items.get([LIB, "ARTICLE1"]))!;
        (row.raw.data as unknown as Record<string, unknown>).pages = "5-6";
        await db.items.put(row);

        await conflict.resolveItemConflict(LIB, "ARTICLE1", "accept-remote-copy");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.raw.data).toMatchObject({ title: "Remote title", publisher: "Remote Press", pages: "1-10" });
        expect(stored.syncStatus).toBe("synced");
        expect(stored.version).toBe(7);
        expect(await db.syncCache.count()).toBe(0);
        expect(await db.syncConflicts.count()).toBe(0);
    });

    test("only an item changed on both sides has whole-copy resolutions", async () => {
        await deletedFamily();

        await expect(conflict.resolveItemConflict(LIB, "NOTEAAAA", "accept-remote-copy")).rejects.toThrow(/changed on both sides only/);
        expect(await db.syncConflicts.count()).toBe(2);
    });
});

describe("conflict summary", () => {
    test("an edit on both sides names its conflicting fields and counts the merged ones", async () => {
        await conflictedItem();
        const [info] = await conflict.getItemConflicts();
        expect(info!.summary).toBe("“title” was changed differently here and in Zotero. 1 other change merges automatically.");
    });

    test("a refusal gives Zotero's reason, shortened", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", syncStatus: "conflict" });
        await addConflict({ key: "ARTICLE1", kind: "refused", error: `413: Tag '${"x".repeat(300)}' too long` });
        const [info] = await conflict.getItemConflicts();
        expect(info!.summary).toBe(`Zotero rejected the upload: Tag '${"x".repeat(24)}…' too long.`);
    });

    test("a member of a deletion group names the deleted item and the others resolved with it", async () => {
        await deletedFamily();
        const info = (await conflict.getItemConflicts()).find((c) => c.key === "NOTEAAAA")!;
        expect(info.summary).toMatch(/was deleted in Zotero; this item has changes here that were never uploaded\. 1 other item is resolved with it\.$/);
    });
});

describe("note and comment values as Markdown", () => {
    async function changedNote(local: string, remote: string, base: string) {
        const data = (note: string, version: number) => ({ key: "NOTE0001", version, itemType: "note", note, tags: [] });
        await seedItem({
            libraryID: LIB,
            key: "NOTE0001",
            itemType: "note",
            syncStatus: "conflict",
            version: 3,
            raw: { key: "NOTE0001", version: 3, data: data(local, 3) } as any,
        });
        await db.syncCache.put({ libraryID: LIB, key: "NOTE0001", version: 3, data: data(base, 3) });
        await addConflict({ key: "NOTE0001", kind: "changed", remote: data(remote, 7), remoteVersion: 7, fields: ["note"] });
    }

    test("note HTML is shown as the Markdown the editor shows", async () => {
        await changedNote("<p>Local <strong>bold</strong> text</p>", "<p>Remote text</p>", "<p>Original text</p>");
        const service = new ConflictService(host, undefined, new ConvertService());

        const note = (await service.getItemConflicts())[0]!.fields.find((f) => f.field === "note")!;
        expect(note.localValue).toBe("Local **bold** text");
        expect(note.remoteValue).toBe("Remote text");
        expect(note.baseValue).toBe("Original text");
        expect(note.noDiff).toBeUndefined();
    });

    test("a value that fails to convert stays HTML and is not diffed", async () => {
        await changedNote("<p>Local</p>", "<p>Remote</p>", "<p>Original</p>");
        const convert = new ConvertService();
        vi.spyOn(convert, "html2md").mockRejectedValue(new Error("bad HTML"));
        const service = new ConflictService(host, undefined, convert);

        const note = (await service.getItemConflicts())[0]!.fields.find((f) => f.field === "note")!;
        expect(note.localValue).toBe("<p>Local</p>");
        expect(note.noDiff).toBe(true);
    });
});
