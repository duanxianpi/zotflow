/**
 * Sync interrupted partway, and sync racing another client.
 *
 * "Lost response" is the server applying a write whose answer never arrives
 * — a dropped connection, or Obsidian closed mid-sync. The upload journal
 * still holds the write; the next sync must recognise the server already has
 * it rather than turn it into a conflict or send it twice. "Not sent" is the
 * request failing before it reaches the server. (Scenarios from the v6
 * hardening, on the v7 model.)
 */
import { describe, test, expect, afterEach } from "vitest";
import { deleteLocalItems, mutateItem } from "db/mutate";
import { ConflictService } from "worker/services/conflict";
import { db, seedItem } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";

let h: SyncHarness;
let restore: (() => void) | undefined;
afterEach(() => {
    restore?.();
    restore = undefined;
    h?.dispose();
});

type Mode = "lost-response" | "not-sent";

/** Fail the first request with `method` (any method if omitted). */
function failFirst(mode: Mode, method?: string) {
    const real = globalThis.fetch;
    let fired = false;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const matches = !method || (init?.method ?? "GET") === method;
        if (fired || !matches) return real(input, init);
        fired = true;
        if (mode === "not-sent") throw new TypeError("Failed to fetch");
        await real(input, init);
        throw new TypeError("Failed to fetch");
    };
    restore = () => (globalThis.fetch = real);
}

async function row(key: string) {
    return db.items.get([USER_ID, key]);
}

async function syncedItem() {
    h = await createSyncHarness();
    const lib = h.server.library(USER_ID);
    lib.addItem({ key: "AAAAAAAA", data: { title: "t", tags: [] } });
    lib.addItem({ key: "PARENT01", data: { title: "p" } });
    lib.addItem({
        key: "NOTEKEY1",
        data: { itemType: "note", parentItem: "PARENT01", note: "<p>n</p>" },
    });
    lib.addItem({ key: "DELETEME", data: { title: "to delete" } });
    await h.sync.startSync();
    return lib;
}

async function conflictKind(key: string) {
    return (await new ConflictService(h.host).getItemConflicts()).find((c) => c.key === key)?.kind;
}

async function syncCleanly() {
    restore?.();
    restore = undefined;
    await h.sync.startSync();
}

describe("a push whose response is lost", () => {
    test("an update is recognised as already applied, not a conflict", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "mine" }];
        });
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        expect((await row("AAAAAAAA"))!.syncStatus).toBe("updated");

        await syncCleanly();

        const stored = (await row("AAAAAAAA"))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.version).toBe(lib.items.get("AAAAAAAA")!.version);
        expect(lib.items.get("AAAAAAAA")!.data.tags).toEqual([{ tag: "mine" }]);
    });

    test("a create is recognised as already applied, not created twice", async () => {
        const lib = await syncedItem();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
        });
        failFirst("lost-response", "POST");
        await h.sync.startSync();

        await syncCleanly();

        expect((await row("NEWITEM1"))!.syncStatus).toBe("synced");
        expect((await row("NEWITEM1"))!.version).toBe(
            lib.items.get("NEWITEM1")!.version,
        );
    });

    test("a delete is completed by the next sync", async () => {
        const lib = await syncedItem();
        await deleteLocalItems(USER_ID, ["DELETEME"]);
        failFirst("lost-response", "DELETE");
        await h.sync.startSync();
        expect(lib.items.has("DELETEME")).toBe(false);

        await syncCleanly();

        expect(await row("DELETEME")).toBeUndefined();
        expect(await db.syncDeleteLog.count()).toBe(0);
        expect(await new ConflictService(h.host).getItemConflicts()).toEqual([]);
    });
});

describe("a lost answer followed by more local work", () => {
    test("deleting the lost create deletes it on the server", async () => {
        // Its create may have landed, so it is no longer a local-only row
        // that can simply be dropped.
        const lib = await syncedItem();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
        });
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        expect(lib.items.has("NEWITEM1")).toBe(true);

        await deleteLocalItems(USER_ID, ["NEWITEM1"]);
        expect(await db.syncDeleteLog.get([USER_ID, "NEWITEM1"])).toBeDefined();
        await syncCleanly();

        expect(lib.items.has("NEWITEM1")).toBe(false);
        expect(await row("NEWITEM1")).toBeUndefined();
    });

    test("deleting a create that never went out just drops the row", async () => {
        const lib = await syncedItem();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
        });
        failFirst("not-sent", "POST");
        await h.sync.startSync();

        await deleteLocalItems(USER_ID, ["NEWITEM1"]);
        await syncCleanly();

        expect(lib.items.has("NEWITEM1")).toBe(false);
        expect(await row("NEWITEM1")).toBeUndefined();
        expect(await db.syncDeleteLog.count()).toBe(0);
    });

    test("trashing a note whose create never went out leaves nothing on the server", async () => {
        // The send was recorded, so for now it might have landed; the next
        // pull shows it did not, and the trashed draft is simply dropped.
        const lib = await syncedItem();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWNOTE1",
            itemType: "note",
            parentItem: "PARENT01",
            syncStatus: "created",
            version: 0,
        });
        failFirst("not-sent", "POST");
        await h.sync.startSync();
        await deleteLocalItems(USER_ID, ["NEWNOTE1"]);

        await syncCleanly();

        expect(lib.items.has("NEWNOTE1")).toBe(false);
        expect(await row("NEWNOTE1")).toBeUndefined();
    });

    test("a sent create that another client then deleted is still a conflict", async () => {
        // Unlike a create that was never sent, this deletion is news: the
        // create landed and someone removed it.
        const lib = await syncedItem();
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
            version: 0,
        });
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        await mutateItem(USER_ID, "NEWITEM1", (d) => {
            d.tags = [{ tag: "edited after" }];
        });
        lib.deleteItem("NEWITEM1");

        await syncCleanly();

        expect(await conflictKind("NEWITEM1")).toBe("remote-deleted");
    });

    test("an edit after a lost create is an update of the created item, not a conflict", async () => {
        // The create landed; the server copy equals what was sent, so it is
        // recognised as ours and the later edit goes on top of it.
        const lib = await syncedItem();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created", version: 0 });
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        await mutateItem(USER_ID, "NEWITEM1", (d) => {
            d.tags = [{ tag: "after the lost create" }];
        });

        await syncCleanly();

        expect(await conflictKind("NEWITEM1")).toBeUndefined();
        expect((await row("NEWITEM1"))!.syncStatus).toBe("synced");
        expect(lib.items.get("NEWITEM1")!.data.tags).toEqual([{ tag: "after the lost create" }]);
    });

    test("after a second lost answer, a remote edit of the same field is a conflict, not a silent win", async () => {
        // Found by the depth-3 checker. The second send (B) landed but its
        // answer was lost, so the merge base on record is the copy before
        // it (A). The user then set A again and another client changed the
        // field: against A alone the user made no change and the remote edit
        // would win; against what was sent (B) both changed it.
        const lib = await syncedItem();
        const setNote = (text: string) =>
            mutateItem(USER_ID, "NOTEKEY1", "note", (d) => {
                d.note = `<p>${text}</p>`;
            });
        await setNote("A");
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        await setNote("B");
        restore?.();
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        expect(lib.items.get("NOTEKEY1")!.data.note).toBe("<p>B</p>");
        await setNote("A");
        lib.updateItem("NOTEKEY1", { note: "<p>theirs</p>" });

        await syncCleanly();

        expect(await conflictKind("NOTEKEY1")).toBe("changed");
        expect(lib.items.get("NOTEKEY1")!.data.note).toBe("<p>theirs</p>");
    });

    test("a further edit is pushed as an update, not a conflict", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "first" }];
        });
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "second" }];
        });

        await syncCleanly();

        expect((await row("AAAAAAAA"))!.syncStatus).toBe("synced");
        expect(lib.items.get("AAAAAAAA")!.data.tags).toEqual([{ tag: "second" }]);
    });

    test("a remote edit of another field after it merges", async () => {
        // The server copy is not what was sent, so it is merged against the
        // base the edit started from: ours is on both sides, theirs only there.
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "first" }];
        });
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        lib.updateItem("AAAAAAAA", { title: "another client" });

        await syncCleanly();

        expect((await row("AAAAAAAA"))!).toMatchObject({ syncStatus: "synced", title: "another client", searchTags: ["first"] });
    });

    test("a remote edit of the same field after it is a conflict", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "first" }];
        });
        failFirst("lost-response", "POST");
        await h.sync.startSync();
        lib.updateItem("AAAAAAAA", { tags: [{ tag: "theirs" }] });
        await mutateItem(USER_ID, "AAAAAAAA", (d: any) => {
            d.title = "mine";
        });
        lib.updateItem("AAAAAAAA", { title: "theirs" });

        await syncCleanly();

        expect(await conflictKind("AAAAAAAA")).toBe("changed");
    });
});

describe("a push that never reaches the server", () => {
    test("stays pending and goes out on the next sync", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "mine" }];
        });
        failFirst("not-sent", "POST");
        await h.sync.startSync();
        expect((await row("AAAAAAAA"))!.syncStatus).toBe("updated");

        await syncCleanly();

        expect((await row("AAAAAAAA"))!.syncStatus).toBe("synced");
        expect(lib.items.get("AAAAAAAA")!.data.tags).toEqual([{ tag: "mine" }]);
        expect(await db.uploadJournal.count()).toBe(0);
    });
});

describe("a pull interrupted partway", () => {
    test("does not advance the library version, so nothing is skipped", async () => {
        const lib = await syncedItem();
        const before = (await db.libraries.get(USER_ID))!.itemVersion;
        lib.updateItem("AAAAAAAA", { title: "remote" });
        lib.updateItem("PARENT01", { title: "remote too" });
        // The versions listing succeeds; fetching the items does not.
        let calls = 0;
        const real = globalThis.fetch;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url;
            if (url.includes("itemKey=") && calls++ === 0) {
                throw new TypeError("Failed to fetch");
            }
            return real(input, init);
        };
        restore = () => (globalThis.fetch = real);
        await h.sync.startSync();
        expect((await db.libraries.get(USER_ID))!.itemVersion).toBe(before);

        await syncCleanly();

        expect((await row("AAAAAAAA"))!.title).toBe("remote");
        expect((await row("PARENT01"))!.title).toBe("remote too");
    });
});

describe("another client writing while we push", () => {
    test("its edit is not skipped by the version our DELETE returns", async () => {
        // The DELETE carries the library version as its precondition, so
        // another client's edit landing first refuses it (412); the edit is
        // downloaded, never skipped.
        const lib = await syncedItem();
        await deleteLocalItems(USER_ID, ["DELETEME"]);
        const real = globalThis.fetch;
        let fired = false;
        globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            if (!fired && init?.method === "DELETE") {
                fired = true;
                lib.updateItem("AAAAAAAA", { title: "by another client" });
            }
            return real(input, init);
        };
        restore = () => (globalThis.fetch = real);
        await h.sync.startSync();

        await syncCleanly();

        expect((await row("AAAAAAAA"))!.title).toBe("by another client");
    });

    test("a multi-item push, which moves the library by one per item, is still ours", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "one" }];
        });
        await mutateItem(USER_ID, "PARENT01", (d) => {
            d.tags = [{ tag: "two" }];
        });
        await h.sync.startSync();

        expect((await db.libraries.get(USER_ID))!.itemVersion).toBe(lib.version);
    });

    test("with no one else writing, our own writes are not pulled back", async () => {
        const lib = await syncedItem();
        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "mine" }];
        });
        await h.sync.startSync();

        expect((await db.libraries.get(USER_ID))!.itemVersion).toBe(lib.version);
    });
});
