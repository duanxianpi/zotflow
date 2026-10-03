/**
 * How each kind of conflict arises in a real sync run, and what resolving it
 * sends to the server (scenarios from the v6 hardening, on the v7 model).
 *
 * Asserted through what the user and the server see — the conflict list,
 * row statuses, the server's items and the writes a sync makes — not the
 * tables behind them.
 */
import { describe, test, expect, afterEach } from "vitest";
import { deleteLocalItems, mutateItem } from "db/mutate";
import { ConflictService } from "worker/services/conflict";
import { db } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";
import type { ConflictAction } from "worker/services/conflict";

let h: SyncHarness;
afterEach(() => h?.dispose());

async function row(key: string) {
    return db.items.get([USER_ID, key]);
}

async function conflict(key: string) {
    return (await new ConflictService(h.host).getItemConflicts()).find((c) => c.key === key);
}

function resolve(key: string, action: ConflictAction) {
    return new ConflictService(h.host).resolveItemConflict(USER_ID, key, action);
}

function tag(key: string, value: string) {
    return mutateItem(USER_ID, key, (d) => {
        d.tags = [{ tag: value }];
    });
}

/** Sync and return the writes it made, as `METHOD keys`. */
async function syncWrites(): Promise<string[]> {
    h.server.clearRequests();
    await h.sync.startSync();
    return h.server.requests
        .filter((r) => r.method !== "GET")
        .map((r) =>
            r.method === "POST"
                ? `POST ${(r.body as { key: string }[]).map((i) => i.key).join(",")}`
                : `${r.method} ${r.query.get("itemKey") ?? ""}`,
        );
}

async function harness() {
    h = await createSyncHarness();
    return h.server.library(USER_ID);
}

describe("a write the server refuses", () => {
    async function refused() {
        const lib = await harness();
        lib.addItem({ key: "AAAAAAAA", data: { title: "server title" } });
        await h.sync.startSync();
        await tag("AAAAAAAA", "mine");
        lib.rejectWrite("AAAAAAAA", { code: 400, message: "Invalid field" });
        await h.sync.startSync();
        return lib;
    }

    test("is a refused conflict with the server copy downloaded", async () => {
        await refused();

        const c = (await conflict("AAAAAAAA"))!;
        expect(c).toMatchObject({ kind: "refused", syncError: "400: Invalid field" });
        expect(c.remoteData!.title).toBe("server title");
    });

    test("accept-remote restores the server's version instead of deleting it", async () => {
        const lib = await refused();

        await resolve("AAAAAAAA", "accept-remote");

        const stored = (await row("AAAAAAAA"))!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.searchTags).toEqual([]);
        expect(lib.items.has("AAAAAAAA")).toBe(true);
        expect(await syncWrites()).toEqual([]);
    });

    test("keep-local retries it", async () => {
        const lib = await refused();

        await resolve("AAAAAAAA", "keep-local");
        await syncWrites();

        expect(lib.items.get("AAAAAAAA")!.data.tags).toEqual([{ tag: "mine" }]);
    });
});

describe("a local edit to an item the server deleted", () => {
    async function remoteDeleted() {
        const lib = await harness();
        lib.addItem({ key: "AAAAAAAA", data: { title: "t" } });
        await h.sync.startSync();
        await tag("AAAAAAAA", "mine");
        lib.deleteItem("AAAAAAAA");
        await h.sync.startSync();
        return lib;
    }

    test("is a remote-deleted conflict, a group of one", async () => {
        await remoteDeleted();

        expect(await conflict("AAAAAAAA")).toMatchObject({ kind: "remote-deleted", group: "AAAAAAAA", groupSize: 1 });
    });

    test("keep-local creates it again rather than updating it", async () => {
        const lib = await remoteDeleted();

        await resolve("AAAAAAAA", "keep-local");
        const writes = await syncWrites();

        expect(writes).toEqual(["POST AAAAAAAA"]);
        expect(lib.items.get("AAAAAAAA")!.data.tags).toEqual([{ tag: "mine" }]);
        expect((await row("AAAAAAAA"))!.syncStatus).toBe("synced");
    });

    test("an edit whose item the server deleted without a trace is created again after the 404", async () => {
        // The deletion log the server keeps can expire; the write then meets
        // a 404, a full sync finds the item gone, and the unsynced row is
        // created again (§4.7).
        const lib = await harness();
        lib.addItem({ key: "AAAAAAAA", data: { title: "t" } });
        await h.sync.startSync();
        await tag("AAAAAAAA", "mine");
        lib.deleteItem("AAAAAAAA");
        const saved = h.server.saveState() as { id: number; deletedItems: Map<string, number>; version: number }[];
        const state = saved.find((l) => l.id === USER_ID)!;
        state.deletedItems.delete("AAAAAAAA");
        // The cursor must not lag either, or the library precondition would
        // catch it first.
        h.server.loadState(saved);
        await db.libraries.update(USER_ID, { itemVersion: lib.version });

        await h.sync.startSync();

        expect(lib.items.get("AAAAAAAA")!.data.tags).toEqual([{ tag: "mine" }]);
        expect((await row("AAAAAAAA"))!.syncStatus).toBe("synced");
    });
});

describe("a remote deletion of a parent whose child has local changes", () => {
    /** Parent with an edited child note and an untouched one; all deleted remotely. */
    async function familyDeleted() {
        const lib = await harness();
        lib.addItem({ key: "PARENT01", data: { title: "p" } });
        lib.addItem({ key: "EDITED01", data: { itemType: "note", parentItem: "PARENT01", note: "<p>a</p>" } });
        lib.addItem({ key: "UNTOUCH1", data: { itemType: "note", parentItem: "PARENT01", note: "<p>b</p>" } });
        await h.sync.startSync();
        await mutateItem(USER_ID, "EDITED01", "note", (d) => {
            d.note = "<p>local edit</p>";
        });
        for (const key of ["PARENT01", "EDITED01", "UNTOUCH1"]) lib.deleteItem(key);
        await h.sync.startSync();
        return lib;
    }

    test("is one conflict group rooted at the parent; the untouched child is deleted", async () => {
        await familyDeleted();

        expect(await conflict("PARENT01")).toMatchObject({ kind: "remote-deleted", group: "PARENT01", groupSize: 2 });
        expect(await conflict("EDITED01")).toMatchObject({ kind: "remote-deleted", group: "PARENT01" });
        expect(await row("UNTOUCH1")).toBeUndefined();
    });

    test("accept-remote on either member removes the whole family", async () => {
        await familyDeleted();

        await resolve("EDITED01", "accept-remote");

        expect(await row("PARENT01")).toBeUndefined();
        expect(await row("EDITED01")).toBeUndefined();
        expect(await new ConflictService(h.host).getItemConflicts()).toEqual([]);
    });

    test("keep-local recreates parent then child, in one push", async () => {
        const lib = await familyDeleted();

        await resolve("PARENT01", "keep-local");

        expect(await syncWrites()).toEqual(["POST PARENT01,EDITED01"]);
        expect(lib.items.get("EDITED01")!.data.note).toBe("<p>local edit</p>");
        expect((await row("PARENT01"))!.syncStatus).toBe("synced");
        expect((await row("EDITED01"))!.syncStatus).toBe("synced");
    });

    test("a note created under the deleted parent afterwards joins the group at once", async () => {
        await familyDeleted();
        await db.items.put({
            ...(await row("EDITED01"))!,
        });
        const { ItemNoteService } = await import("worker/services/item-note");
        const { ConvertService } = await import("worker/services/convert");
        const notes = new ItemNoteService(h.settings, h.host, new ConvertService(), {
            triggerUpdate: () => Promise.resolve(),
        } as never);
        const key = await notes.createChildNote(USER_ID, "PARENT01");

        expect(await conflict(key)).toMatchObject({ kind: "remote-deleted", group: "PARENT01" });
        expect((await conflict("PARENT01"))!.groupSize).toBe(3);
        // Nothing of the group is uploaded until the user decides.
        expect((await syncWrites()).filter((w) => w.startsWith("POST"))).toEqual([]);
    });
});

describe("a draft note under a parent deleted remotely", () => {
    test("deleted by the user, it never reaches the server, even after Keep Local", async () => {
        // Found by the depth-3 checker: the draft joined the deletion group,
        // and its delete trashed it instead of dropping it, so Keep Local
        // created a trashed note on a server that never had it.
        const lib = await harness();
        lib.addItem({ key: "PARENT01", data: { title: "p" } });
        await h.sync.startSync();
        const { ItemNoteService } = await import("worker/services/item-note");
        const { ConvertService } = await import("worker/services/convert");
        const notes = new ItemNoteService(h.settings, h.host, new ConvertService(), {
            triggerUpdate: () => Promise.resolve(),
        } as never);
        const draft = await notes.createChildNote(USER_ID, "PARENT01");
        lib.deleteItem("PARENT01");
        await h.sync.startSync();
        expect(await conflict(draft)).toMatchObject({ kind: "remote-deleted", group: "PARENT01" });

        await notes.deleteNote(USER_ID, draft);
        expect(await row(draft)).toBeUndefined();
        await new ConflictService(h.host).resolveAllItemConflicts("keep-local");
        await h.sync.startSync();

        expect(lib.items.has(draft)).toBe(false);
        expect(lib.items.has("PARENT01")).toBe(true);
    });
});

describe("a remote deletion resolved after the server moved on", () => {
    /** Parent and an edited child note, both deleted remotely. */
    async function deletedFamily() {
        const lib = await harness();
        lib.addItem({ key: "PARENT01", data: { title: "parent" } });
        lib.addItem({ key: "EDITED01", data: { itemType: "note", parentItem: "PARENT01", note: "<p>old</p>" } });
        await h.sync.startSync();
        await mutateItem(USER_ID, "EDITED01", "note", (d) => {
            d.note = "<p>mine</p>";
        });
        lib.deleteItem("PARENT01");
        lib.deleteItem("EDITED01");
        await h.sync.startSync();
        return lib;
    }

    test("resolving all conflicts handles a group once, without tripping on its members", async () => {
        await deletedFamily();

        const resolved = await new ConflictService(h.host).resolveAllItemConflicts("accept-remote");

        expect(resolved).toBe(1);
        expect(await row("PARENT01")).toBeUndefined();
        expect(await row("EDITED01")).toBeUndefined();
    });

    test("a parent recreated remotely is simply clean again; the edited child stays in conflict", async () => {
        // The parent had nothing pending, so there is nothing to choose for it.
        const lib = await deletedFamily();
        lib.addItem({ key: "PARENT01", data: { title: "recreated" } });
        await h.sync.startSync();

        expect((await row("PARENT01"))!.syncStatus).toBe("synced");
        expect(await conflict("EDITED01")).toMatchObject({ kind: "remote-deleted" });
    });

    test("keep-local then leaves notes the server added since alone", async () => {
        // Only recorded members are touched: a note under the recreated
        // parent is live on the server, whatever the old deletion said.
        const lib = await deletedFamily();
        lib.addItem({ key: "PARENT01", data: { title: "recreated" } });
        lib.addItem({ key: "NEWNOTE1", data: { itemType: "note", parentItem: "PARENT01", note: "<p>new remote work</p>" } });
        await h.sync.startSync();

        await resolve("EDITED01", "keep-local");
        await h.sync.startSync();

        expect(await row("NEWNOTE1")).toBeDefined();
        expect(lib.items.get("EDITED01")!.data.note).toBe("<p>mine</p>");
    });
});

describe("accepting a remote deletion", () => {
    test("leaves a row that has a conflict of its own, with its local change", async () => {
        // The edited note left the group when the server had it again (here
        // re-created standalone under the same key); locally it is still
        // under the deleted parent, until the user resolves its conflict.
        const lib = await harness();
        lib.addItem({ key: "PARENT01", data: { title: "p" } });
        lib.addItem({ key: "EDITED01", data: { itemType: "note", parentItem: "PARENT01", note: "<p>a</p>" } });
        await h.sync.startSync();
        await mutateItem(USER_ID, "EDITED01", "note", (d) => {
            d.note = "<p>local edit</p>";
        });
        lib.deleteItem("PARENT01");
        lib.deleteItem("EDITED01");
        await h.sync.startSync();
        lib.addItem({ key: "EDITED01", data: { itemType: "note", note: "<p>restored</p>" } });
        await h.sync.startSync();
        expect(await conflict("EDITED01")).toMatchObject({ kind: "changed" });
        expect((await conflict("EDITED01"))!.group).toBeUndefined();

        await resolve("PARENT01", "accept-remote");

        expect(await row("PARENT01")).toBeUndefined();
        expect(((await row("EDITED01"))!.raw.data as { note: string }).note).toBe("<p>local edit</p>");
        expect(await conflict("EDITED01")).toMatchObject({ kind: "changed" });
    });

    test("deletes the rendered image of an image annotation it removes", async () => {
        const lib = await harness();
        lib.addItem({ key: "PARENT01", data: { title: "p" } });
        lib.addItem({ key: "ATTACH01", data: { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "application/pdf" } });
        lib.addItem({
            key: "IMAGE001",
            data: { itemType: "annotation", parentItem: "ATTACH01", annotationType: "image", annotationComment: "" },
        });
        await h.sync.startSync();
        await mutateItem(USER_ID, "IMAGE001", "annotation", (d) => {
            d.annotationComment = "mine";
        });
        for (const key of ["PARENT01", "ATTACH01", "IMAGE001"]) lib.deleteItem(key);
        await h.sync.startSync();
        const png = `${h.settings.annotationImageFolder.replace(/\/$/, "")}/IMAGE001.png`;
        h.host.binaryVault.set(png, new ArrayBuffer(1));

        await new ConflictService(h.host, h.settings).resolveItemConflict(USER_ID, "IMAGE001", "accept-remote");

        expect(await row("IMAGE001")).toBeUndefined();
        expect(h.host.binaryVault.has(png)).toBe(false);
    });
});

describe("local and remote agree", () => {
    test("a local delete meeting a remote delete is just removed", async () => {
        const lib = await harness();
        lib.addItem({ key: "AAAAAAAA", data: { title: "t" } });
        await h.sync.startSync();
        await deleteLocalItems(USER_ID, ["AAAAAAAA"]);
        lib.deleteItem("AAAAAAAA");

        await h.sync.startSync();

        expect(await row("AAAAAAAA")).toBeUndefined();
        expect(await new ConflictService(h.host).getItemConflicts()).toEqual([]);
        expect(await db.syncDeleteLog.count()).toBe(0);
    });

    test("the same change on both sides is no conflict", async () => {
        const lib = await harness();
        lib.addItem({ key: "AAAAAAAA", data: { title: "t" } });
        await h.sync.startSync();
        await tag("AAAAAAAA", "same");
        lib.updateItem("AAAAAAAA", { tags: [{ tag: "same" }] });

        await h.sync.startSync();

        expect((await row("AAAAAAAA"))!.syncStatus).toBe("synced");
        expect(await new ConflictService(h.host).getItemConflicts()).toEqual([]);
    });
});

describe("a delete the library precondition refuses", () => {
    async function deleted() {
        const lib = await harness();
        lib.addItem({ key: "AAAAAAAA", data: { title: "t" } });
        await h.sync.startSync();
        await deleteLocalItems(USER_ID, ["AAAAAAAA"]);
        return lib;
    }

    test("a 412 with nothing changed for it downloads and deletes on the retry", async () => {
        const lib = await deleted();
        h.server.failNext({ status: 412, method: "DELETE" });

        await h.sync.startSync();

        expect(lib.items.has("AAAAAAAA")).toBe(false);
    });

    test("a real remote edit meanwhile becomes a conflict; keep-local still deletes it", async () => {
        const lib = await deleted();
        const real = globalThis.fetch;
        let fired = false;
        globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            if (!fired && init?.method === "DELETE") {
                fired = true;
                lib.updateItem("AAAAAAAA", { title: "edited meanwhile" });
            }
            return real(input, init);
        };
        try {
            await h.sync.startSync();
        } finally {
            globalThis.fetch = real;
        }
        expect(await conflict("AAAAAAAA")).toMatchObject({ kind: "local-deleted" });

        await resolve("AAAAAAAA", "keep-local");

        expect(await syncWrites()).toEqual(["DELETE AAAAAAAA"]);
        expect(lib.items.has("AAAAAAAA")).toBe(false);
    });

    test("accept-remote brings the edited item back", async () => {
        const lib = await deleted();
        lib.updateItem("AAAAAAAA", { title: "edited meanwhile" });
        await h.sync.startSync();

        await resolve("AAAAAAAA", "accept-remote");

        expect((await row("AAAAAAAA"))!).toMatchObject({ syncStatus: "synced", title: "edited meanwhile" });
        expect(await syncWrites()).toEqual([]);
    });
});
