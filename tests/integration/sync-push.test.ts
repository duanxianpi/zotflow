/**
 * The upload half of a sync (docs/sync-architecture.md §4.6): which local
 * rows are eligible, what each object sent looks like (a create with
 * `version: 0`, an edit as a patch against the merge base), how each bucket of
 * the write response (`successful` / `unchanged` / `failed`) is folded back,
 * and pending deletes sent as batch DELETEs.
 */
import { describe, test, expect, afterEach } from "vitest";
import { deleteLocalItems, mutateItem } from "db/mutate";
import { db, seedItem } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";

let h: SyncHarness;
afterEach(() => h?.dispose());

/** The objects of the single POST the run made. */
function postedPayload(harness: SyncHarness): Record<string, any>[] {
    const posts = harness.server.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    return posts[0]!.body as Record<string, any>[];
}

/** A library with one synced item, ready for a local change. */
async function syncedItem(data: Record<string, unknown> = {}) {
    h = await createSyncHarness();
    const lib = h.server.library(USER_ID);
    lib.addItem({ key: "AAAAAAAA", data: { title: "Original", extra: "", ...data } });
    await h.sync.startSync();
    h.server.clearRequests();
    return lib;
}

describe("eligibility", () => {
    test("a clean library posts nothing", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });

        await h.sync.startSync();

        expect(h.server.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    });

    test("only created and updated rows are pushed", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "CREATED1", syncStatus: "created" });
        await seedItem({ libraryID: USER_ID, key: "UPDATED1", syncStatus: "updated" });
        await seedItem({ libraryID: USER_ID, key: "SYNCED01", syncStatus: "synced" });
        await seedItem({ libraryID: USER_ID, key: "IGNORED1", syncStatus: "ignore" });
        await seedItem({ libraryID: USER_ID, key: "CONFLIC1", syncStatus: "conflict" });

        await h.sync.startSync();

        const keys = h.server.requests
            .filter((r) => r.method === "POST")
            .flatMap((r) => (r.body as { key: string }[]).map((o) => o.key));
        expect(keys).toContain("CREATED1");
        expect(keys).toContain("UPDATED1");
        expect(keys).not.toContain("SYNCED01");
        expect(keys).not.toContain("IGNORED1");
        expect(keys).not.toContain("CONFLIC1");
    });

    test("notes are held back when the key lacks notes permission", async () => {
        h = await createSyncHarness({
            access: { user: { library: true, files: true, notes: false, write: true } },
        });
        await seedItem({ libraryID: USER_ID, key: "NOTEITEM", itemType: "note", syncStatus: "created" });
        await seedItem({ libraryID: USER_ID, key: "ARTICLE1", syncStatus: "created" });

        await h.sync.startSync();

        expect(postedPayload(h).map((i) => i.key)).toEqual(["ARTICLE1"]);
        expect(h.host.logsAt("warn").some((l) => /Skipping 1 dirty note item/.test(l.message))).toBe(true);
        // Held back, not dropped: it can sync once permissions change.
        expect((await db.items.get([USER_ID, "NOTEITEM"]))!.syncStatus).toBe("created");
    });

    test("writes are chunked at 50 objects", async () => {
        h = await createSyncHarness();
        for (let i = 0; i < 51; i++) {
            await seedItem({ libraryID: USER_ID, key: `NEW${String(i).padStart(5, "0")}`, syncStatus: "created" });
        }

        await h.sync.startSync();

        const posts = h.server.requests.filter((r) => r.method === "POST");
        expect(posts).toHaveLength(2);
        expect(posts[0]!.body as unknown[]).toHaveLength(50);
        expect(posts[1]!.body as unknown[]).toHaveLength(1);
        expect(h.server.library(USER_ID).items.size).toBe(51);
    });

    test("a new parent is sent before its new children", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "ZZPARENT", syncStatus: "created" });
        await seedItem({ libraryID: USER_ID, key: "AACHILD1", itemType: "note", parentItem: "ZZPARENT", syncStatus: "created" });

        await h.sync.startSync();

        expect(postedPayload(h).map((i) => i.key)).toEqual(["ZZPARENT", "AACHILD1"]);
        expect(h.server.library(USER_ID).items.has("AACHILD1")).toBe(true);
    });

    test("a child waits while its new parent cannot be sent", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "PARENT01", syncStatus: "conflict", version: 0 });
        await seedItem({ libraryID: USER_ID, key: "CHILD001", itemType: "note", parentItem: "PARENT01", syncStatus: "created" });

        await h.sync.startSync();

        expect(h.server.requests.filter((r) => r.method === "POST")).toHaveLength(0);
        expect((await db.items.get([USER_ID, "CHILD001"]))!.syncStatus).toBe("created");
    });
});

describe("request payload", () => {
    test("a create carries version 0, so a key the server already has is refused, not merged into", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });

        await h.sync.startSync();

        const [sent] = postedPayload(h);
        expect(sent).toMatchObject({ key: "NEWITEM1", version: 0, itemType: "journalArticle" });
    });

    test("an edit is sent as a patch: only the fields that changed, at the base version", async () => {
        const lib = await syncedItem();
        const version = lib.items.get("AAAAAAAA")!.version;

        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.extra = "local"));
        await h.sync.startSync();

        const [sent] = postedPayload(h);
        expect(sent).toMatchObject({ key: "AAAAAAAA", version, extra: "local" });
        expect(sent).not.toHaveProperty("title");
        expect(lib.items.get("AAAAAAAA")!.data).toMatchObject({ title: "Original", extra: "local" });
    });

    test("an edit without a merge base sends the whole object, at the stored version", async () => {
        // The row's `version` column is authoritative — it is what the server
        // checks; a stale copy inside `raw` must not be sent. (A cursor is
        // set: local data without one would start with a full sync.)
        h = await createSyncHarness({ versions: { itemVersion: 50 } });
        await seedItem({
            libraryID: USER_ID,
            key: "AAAAAAAA",
            syncStatus: "updated",
            version: 42,
            raw: {
                key: "AAAAAAAA",
                version: 7,
                library: { type: "user", id: USER_ID, name: "Library" },
                data: { key: "AAAAAAAA", version: 7, itemType: "journalArticle", title: "Item AAAAAAAA", tags: [] },
            } as never,
        });

        await h.sync.startSync();

        const [sent] = h.server.requests.filter((r) => r.method === "POST")[0]!.body as Record<string, any>[];
        expect(sent).toMatchObject({ version: 42, title: "Item AAAAAAAA" });
    });

    test("dates are sent in Zotero's format", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            raw: {
                key: "NEWITEM1",
                data: {
                    key: "NEWITEM1",
                    itemType: "journalArticle",
                    dateAdded: "2020-03-04T05:06:07.891Z",
                    dateModified: "2020-03-04T05:06:07.891Z",
                },
            } as any,
        });

        await h.sync.startSync();

        const [sent] = postedPayload(h);
        expect(sent!.dateAdded).toBe("2020-03-04T05:06:07Z");
        expect(sent!.dateModified).toBe("2020-03-04T05:06:07Z");
    });

    test("annotationIsExternal is stripped — it is a local-only flag", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "ANNOTAT1",
            itemType: "annotation",
            syncStatus: "created",
            raw: { key: "ANNOTAT1", data: { key: "ANNOTAT1", itemType: "annotation", annotationType: "highlight", annotationIsExternal: true } } as any,
        });

        await h.sync.startSync();

        const [sent] = postedPayload(h);
        expect(sent).not.toHaveProperty("annotationIsExternal");
        expect(sent!.annotationType).toBe("highlight");
    });

    test("what is sent is journaled until its answer arrives", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });
        let journaled: unknown;
        const real = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            if (init?.method === "POST") journaled = await db.uploadJournal.get([USER_ID, "NEWITEM1"]);
            return real(input, init);
        };
        try {
            await h.sync.startSync();
        } finally {
            globalThis.fetch = real;
        }

        expect(journaled).toMatchObject({ key: "NEWITEM1", baseVersion: 0 });
        expect(await db.uploadJournal.count()).toBe(0);
    });
});

describe("write response handling", () => {
    test("a successful create is marked synced and adopts the server version", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created", title: "Drafted locally" });

        await h.sync.startSync();

        expect(h.server.library(USER_ID).items.has("NEWITEM1")).toBe(true);
        const stored = (await db.items.get([USER_ID, "NEWITEM1"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.version).toBe(h.server.library(USER_ID).version);
    });

    test("a successful update is marked synced, adopts the server version and drops its base", async () => {
        const lib = await syncedItem();
        const before = (await db.items.get([USER_ID, "AAAAAAAA"]))!.version;

        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "Edited"));
        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.version).toBe(lib.version);
        expect(stored.version).not.toBe(before);
        expect(await db.syncCache.count()).toBe(0);
    });

    test("the server's echoed payload replaces the stored raw", async () => {
        const lib = await syncedItem();

        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "Edited"));
        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.raw.version).toBe(lib.version);
        expect(stored.raw.data.version).toBe(lib.version);
    });

    test("an edit made while the write was in flight survives, and goes up next", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "First"));
        const real = globalThis.fetch;
        let edited = false;
        globalThis.fetch = async (input, init) => {
            if (init?.method === "POST" && !edited) {
                edited = true;
                await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.extra = "second"));
            }
            return real(input, init);
        };
        try {
            await h.sync.startSync();
        } finally {
            globalThis.fetch = real;
        }

        expect(lib.items.get("AAAAAAAA")!.data).toMatchObject({ title: "First", extra: "second" });
        expect((await db.items.get([USER_ID, "AAAAAAAA"]))!.syncStatus).toBe("synced");
    });

    test("a rejected write leaves the stored raw untouched", async () => {
        h = await createSyncHarness();
        await seedItem({
            libraryID: USER_ID,
            key: "ANNO0001",
            syncStatus: "updated",
            itemType: "annotation",
            raw: {
                key: "ANNO0001",
                version: 1,
                library: { type: "user", id: USER_ID, name: "Library" },
                data: {
                    key: "ANNO0001",
                    version: 1,
                    itemType: "annotation",
                    dateAdded: "2020-01-01T00:00:00.000Z",
                    dateModified: "2020-01-01T00:00:00.000Z",
                    annotationIsExternal: true,
                    tags: [],
                    relations: {},
                },
            } as never,
        });
        h.server.library(USER_ID).rejectWrite("ANNO0001", { code: 400, message: "nope" });

        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "ANNO0001"]))!;
        expect(stored.syncStatus).toBe("conflict");
        const data = stored.raw.data as unknown as Record<string, unknown>;
        expect(data.annotationIsExternal).toBe(true);
        expect(data.dateModified).toBe("2020-01-01T00:00:00.000Z");
    });

    test("an item the server reports unchanged is synced at its version", async () => {
        const lib = await syncedItem();
        const before = (await db.items.get([USER_ID, "AAAAAAAA"]))!.version;

        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "Edited"));
        lib.treatAsUnchanged("AAAAAAAA");
        await h.sync.startSync();

        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.version).toBe(before);
    });

    test("a refusal becomes a conflict carrying the server's reason", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });
        h.server.library(USER_ID).rejectWrite("NEWITEM1", { code: 400, message: "Invalid field" });

        await h.sync.startSync();

        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe("conflict");
        expect(await db.syncConflicts.get([USER_ID, "NEWITEM1"])).toMatchObject({ kind: "refused", error: "400: Invalid field" });
        expect(h.host.logsAt("warn").some((l) => /Item failed NEWITEM1/.test(l.message))).toBe(true);
    });

    test("a refused edit keeps the server's copy for Accept Remote", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "x".repeat(10)));
        lib.rejectWrite("AAAAAAAA", { code: 413, message: "Too long" });

        await h.sync.startSync();

        const conflict = (await db.syncConflicts.get([USER_ID, "AAAAAAAA"]))!;
        expect(conflict).toMatchObject({ kind: "refused", remoteVersion: lib.items.get("AAAAAAAA")!.version });
        expect(conflict.remote!.title).toBe("Original");
    });

    test("a server copy is taken only for the requested key", async () => {
        // Measured live: an itemKey the server cannot parse is ignored, and
        // the answer lists other items. None of them is this item's copy.
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "OTHER001", data: { title: "someone else" } });
        await h.sync.startSync();
        await seedItem({ libraryID: USER_ID, key: "BADKEY01", syncStatus: "created" });
        lib.rejectWrite("BADKEY01", { code: 400, message: "Invalid key" });
        const real = globalThis.fetch;
        globalThis.fetch = (input, init) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            return real(url.replace(/itemKey=BADKEY01/, "itemKey=OTHER001"), init);
        };
        try {
            await h.sync.startSync();
        } finally {
            globalThis.fetch = real;
        }

        const conflict = (await db.syncConflicts.get([USER_ID, "BADKEY01"]))!;
        expect(conflict.kind).toBe("refused");
        expect(conflict.remote).toBeUndefined();
    });

    test("a per-item 412 means local versions cannot be trusted: a full sync, then the retry lands", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "Edited"));
        lib.rejectWrite("AAAAAAAA", { code: 412, message: "Version mismatch" });

        await h.sync.startSync();

        const fullListing = h.server.requests.find(
            (r) => r.method === "GET" && r.query.get("format") === "versions" && r.path.endsWith("/items") && !r.query.has("since"),
        );
        expect(fullListing).toBeDefined();
        expect(lib.items.get("AAAAAAAA")!.data.title).toBe("Edited");
        expect((await db.libraries.get(USER_ID))!.needsFullSync).toBe(false);
        expect((await db.items.get([USER_ID, "AAAAAAAA"]))!.syncStatus).toBe("synced");
    });

    test("one failure does not spoil the rest of its batch", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "GOODITEM", syncStatus: "created" });
        await seedItem({ libraryID: USER_ID, key: "BADITEM1", syncStatus: "created" });
        h.server.library(USER_ID).rejectWrite("BADITEM1", { code: 400, message: "nope" });

        await h.sync.startSync();

        expect((await db.items.get([USER_ID, "GOODITEM"]))!.syncStatus).toBe("synced");
        expect((await db.items.get([USER_ID, "BADITEM1"]))!.syncStatus).toBe("conflict");
    });

    test("a server-assigned key replaces the local row rather than duplicating it", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "LOCALKEY", syncStatus: "created", title: "Drafted locally" });
        h.server.library(USER_ID).remapKey("LOCALKEY", "SERVERKY");

        await h.sync.startSync();

        expect(await db.items.get([USER_ID, "LOCALKEY"])).toBeUndefined();
        const stored = (await db.items.get([USER_ID, "SERVERKY"]))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.raw.key).toBe("SERVERKY");
        expect(await db.items.count()).toBe(1);
    });

    test("the library version advances to the write's version", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });

        await h.sync.startSync();

        expect((await db.libraries.get(USER_ID))!.itemVersion).toBe(h.server.library(USER_ID).version);
    });

    test("a dropped connection mid-write fails the library and keeps the question in the journal", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });
        h.server.failNext({ networkError: true, pathIncludes: "/items", method: "POST" });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(1);
        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe("created");
        // Whether the create landed is unknown until a download says so.
        expect(await db.uploadJournal.get([USER_ID, "NEWITEM1"])).toBeDefined();
        expect(h.server.requests.filter((r) => r.method === "POST")).toHaveLength(1);

        // It did not land: the next sync's download proves it, and it is sent.
        await h.sync.startSync();
        expect(h.server.library(USER_ID).items.has("NEWITEM1")).toBe(true);
        expect(await db.uploadJournal.count()).toBe(0);
    });

    test("an error answer fails the library; nothing was applied, so nothing is journaled", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });
        h.server.failNext({ status: 500, pathIncludes: "/items", method: "POST" });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(1);
        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe("created");
        expect(await db.uploadJournal.count()).toBe(0);
    });
});

describe("deletions", () => {
    async function syncedAnnotation() {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "PARENT01" });
        lib.addItem({ key: "ATTACH01", data: { itemType: "attachment", parentItem: "PARENT01", linkMode: "linked_url" } });
        lib.addItem({ key: "ANNOAAAA", data: { itemType: "annotation", parentItem: "ATTACH01", annotationComment: "c" } });
        lib.addItem({ key: "ANNOBBBB", data: { itemType: "annotation", parentItem: "ATTACH01", annotationComment: "c" } });
        await h.sync.startSync();
        h.server.clearRequests();
        return lib;
    }

    test("a local delete is sent as one batch DELETE and then forgotten", async () => {
        const lib = await syncedAnnotation();
        await deleteLocalItems(USER_ID, ["ANNOAAAA", "ANNOBBBB"]);

        await h.sync.startSync();

        const deletes = h.server.requests.filter((r) => r.method === "DELETE");
        expect(deletes).toHaveLength(1);
        expect(deletes[0]!.query.get("itemKey")!.split(",").sort()).toEqual(["ANNOAAAA", "ANNOBBBB"]);
        expect(lib.items.has("ANNOAAAA")).toBe(false);
        expect(await db.syncDeleteLog.count()).toBe(0);
    });

    test("the DELETE carries the library's version as its precondition", async () => {
        await syncedAnnotation();
        const cursor = (await db.libraries.get(USER_ID))!.itemVersion;
        await deleteLocalItems(USER_ID, ["ANNOAAAA"]);

        await h.sync.startSync();

        const del = h.server.requests.find((r) => r.method === "DELETE")!;
        expect(del.headers.get("If-Unmodified-Since-Version")).toBe(String(cursor));
    });

    test("a 412 on DELETE downloads first, then deletes", async () => {
        const lib = await syncedAnnotation();
        await deleteLocalItems(USER_ID, ["ANNOAAAA"]);
        lib.updateItem("PARENT01", { title: "Remote edit elsewhere" });

        await h.sync.startSync();

        expect(h.server.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
        expect(lib.items.has("ANNOAAAA")).toBe(false);
        expect((await db.items.get([USER_ID, "PARENT01"]))!.title).toBe("Remote edit elsewhere");
    });

    test("a remote edit to a locally deleted item becomes a conflict; no DELETE is sent", async () => {
        const lib = await syncedAnnotation();
        await deleteLocalItems(USER_ID, ["ANNOAAAA"]);
        lib.updateItem("ANNOAAAA", { annotationComment: "Remote edit" });

        await h.sync.startSync();

        expect(await db.syncConflicts.get([USER_ID, "ANNOAAAA"])).toMatchObject({ kind: "local-deleted" });
        // The first DELETE was refused (412) as a whole; none followed.
        expect(lib.items.has("ANNOAAAA")).toBe(true);
    });

    test("an item the server deleted too is simply forgotten", async () => {
        const lib = await syncedAnnotation();
        await deleteLocalItems(USER_ID, ["ANNOAAAA"]);
        lib.deleteItem("ANNOAAAA");

        await h.sync.startSync();

        expect(await db.syncDeleteLog.count()).toBe(0);
        expect(await db.syncConflicts.count()).toBe(0);
    });

    test("an error answer fails the library and keeps the delete pending", async () => {
        await syncedAnnotation();
        await deleteLocalItems(USER_ID, ["ANNOAAAA"]);
        h.server.failNext({ status: 500, method: "DELETE" });

        const result = await h.sync.startSync();

        expect(result.failCount).toBe(1);
        expect(await db.syncDeleteLog.get([USER_ID, "ANNOAAAA"])).toBeDefined();
    });

    test("a dropped connection mid-delete keeps it pending; the next sync settles it", async () => {
        const lib = await syncedAnnotation();
        await deleteLocalItems(USER_ID, ["ANNOAAAA"]);
        h.server.failNext({ networkError: true, method: "DELETE" });

        expect((await h.sync.startSync()).failCount).toBe(1);
        expect(await db.syncDeleteLog.get([USER_ID, "ANNOAAAA"])).toBeDefined();

        await h.sync.startSync();
        expect(lib.items.has("ANNOAAAA")).toBe(false);
        expect(await db.syncDeleteLog.count()).toBe(0);
    });

    test("deletions and writes travel in the same run", async () => {
        const lib = await syncedAnnotation();
        await deleteLocalItems(USER_ID, ["ANNOAAAA"]);
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });

        await h.sync.startSync();

        expect(lib.items.has("ANNOAAAA")).toBe(false);
        expect(lib.items.has("NEWITEM1")).toBe(true);
    });
});

describe("retry queue", () => {
    test("a write that succeeds on retry clears its retry entry", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => (d.title = "Edited"));
        lib.rejectWrite("AAAAAAAA", { code: 500, message: "Server error" });

        await h.sync.startSync();
        expect(await db.syncQueue.get([USER_ID, "AAAAAAAA"])).toMatchObject({ reason: "server-error", tries: 1 });

        // The retry is due.
        await db.syncQueue.update([USER_ID, "AAAAAAAA"], { lastCheck: 0 });
        await h.sync.startSync();

        expect((await db.items.get([USER_ID, "AAAAAAAA"]))!.syncStatus).toBe("synced");
        // Otherwise its `tries` would carry over into the next, unrelated failure.
        expect(await db.syncQueue.get([USER_ID, "AAAAAAAA"])).toBeUndefined();
    });
});
