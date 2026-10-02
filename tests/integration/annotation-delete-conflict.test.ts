/**
 * Deleting an annotation while it is, or later becomes, in conflict
 * (scenarios from the v6 hardening, on the v7 model).
 *
 * Annotations are hard-deleted on Zotero (`DELETE`): locally the row goes at
 * once and the delete log carries the DELETE. A delete meeting a remote edit
 * — before or after the conflict arose — is a `local-deleted` conflict:
 * nothing is sent until the user chooses, Keep Local sends the DELETE, and
 * Accept Remote brings the annotation back with the remote edit.
 *
 * Everything here runs through the real sync, annotation and conflict
 * services against the fake Zotero server.
 */
import { describe, test, expect, afterEach } from "vitest";
import { mutateItem } from "db/mutate";
import { AnnotationService } from "worker/services/annotation";
import { ConflictService } from "worker/services/conflict";
import { db } from "../fakes/db";
import { API_KEY, createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";
import type { LibraryNoteService } from "worker/services/library-note";
import type { ConvertService } from "worker/services/convert";
import type { AnyIDBZoteroItem, IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";

const ANNO = "ANNO0001";
const ATTACH = "ATTACH01";

let h: SyncHarness;
let annotations: AnnotationService;
let conflicts: ConflictService;
afterEach(() => h?.dispose());

/** A synced PDF attachment with one highlight whose comment is `orig`. */
async function setup() {
    h = await createSyncHarness();
    const lib = h.server.library(USER_ID);
    lib.addItem({
        key: ATTACH,
        data: { itemType: "attachment", title: "paper.pdf", parentItem: "" },
    });
    lib.addItem({
        key: ANNO,
        data: {
            itemType: "annotation",
            parentItem: ATTACH,
            annotationType: "highlight",
            annotationText: "highlighted text",
            annotationComment: "orig",
            annotationColor: "#ffd400",
            annotationPageLabel: "1",
            annotationSortIndex: "00000|000100|00200",
            annotationPosition: JSON.stringify({
                pageIndex: 0,
                rects: [[10, 10, 100, 20]],
            }),
            tags: [],
        },
    });
    await h.sync.startSync();

    const noteService = {
        triggerUpdate: () => Promise.resolve(),
        deleteAnnotationImage: () => Promise.resolve(),
    } as unknown as LibraryNoteService;
    annotations = new AnnotationService(
        noteService,
        h.host,
        {} as ConvertService,
    );
    conflicts = new ConflictService(h.host);
    return lib;
}

async function attachment() {
    return (await db.items.get([USER_ID, ATTACH])) as IDBZoteroItem<AttachmentData>;
}

async function row(): Promise<AnyIDBZoteroItem | undefined> {
    return db.items.get([USER_ID, ANNO]);
}

/** The annotation keys the reader would be given. */
async function visibleInReader(): Promise<string[]> {
    const json = await annotations.getAnnotations(await attachment(), API_KEY);
    return json.map((a) => a.id);
}

/** Sync again and return the writes it sent, as `METHOD key-or-items`. */
async function syncWrites(): Promise<string[]> {
    h.server.clearRequests();
    await h.sync.startSync();
    return h.server.requests
        .filter((r) => r.method !== "GET")
        .map((r) => `${r.method} ${r.url.includes(ANNO) ? ANNO : "items"}`);
}

async function conflictKind(key = ANNO) {
    return (await conflicts.getItemConflicts()).find((c) => c.key === key)?.kind;
}

describe("deleting an annotation that is already in conflict", () => {
    /** Local edit + remote edit → conflict, then delete it in the reader. */
    async function deleteDuringConflict() {
        const lib = await setup();
        await mutateItem(USER_ID, ANNO, "annotation", (d) => {
            d.annotationComment = "local";
        });
        lib.updateItem(ANNO, { annotationComment: "remote" });
        await h.sync.startSync();
        expect((await row())!.syncStatus).toBe("conflict");

        await annotations.deleteAnnotations(await attachment(), [ANNO]);
        return lib;
    }

    test("the conflict is kept, now with the local side deleted, and nothing is pushed", async () => {
        const lib = await deleteDuringConflict();

        expect(await conflictKind()).toBe("local-deleted");
        expect(await syncWrites()).toEqual([]);
        expect(lib.items.get(ANNO)!.data.annotationComment).toBe("remote");
    });

    test("the annotation is hidden while the conflict is pending", async () => {
        await deleteDuringConflict();

        expect(await visibleInReader()).toEqual([]);
    });

    test("keep-local deletes it on the server", async () => {
        const lib = await deleteDuringConflict();

        await conflicts.resolveItemConflict(USER_ID, ANNO, "keep-local");

        expect(await syncWrites()).toEqual([`DELETE ${ANNO}`]);
        expect(lib.items.has(ANNO)).toBe(false);
        expect(await row()).toBeUndefined();
    });

    test("accept-remote brings it back with the remote edit", async () => {
        await deleteDuringConflict();

        await conflicts.resolveItemConflict(USER_ID, ANNO, "accept-remote");

        const stored = (await row())!;
        expect(stored.syncStatus).toBe("synced");
        expect((stored.raw.data as any).annotationComment).toBe("remote");
        expect(await visibleInReader()).toEqual([ANNO]);
    });
});

describe("a deleted annotation that the remote edits before it is pushed", () => {
    /** Delete in the reader, remote edit → the pull flags the conflict. */
    async function conflictAfterDelete() {
        const lib = await setup();
        await annotations.deleteAnnotations(await attachment(), [ANNO]);
        lib.updateItem(ANNO, { annotationComment: "remote" });
        await h.sync.startSync();
        expect(await conflictKind()).toBe("local-deleted");
        return lib;
    }

    test("the annotation stays hidden while the conflict is pending", async () => {
        await conflictAfterDelete();

        expect(await visibleInReader()).toEqual([]);
    });

    test("keep-local sends a DELETE, not an upsert", async () => {
        const lib = await conflictAfterDelete();

        await conflicts.resolveItemConflict(USER_ID, ANNO, "keep-local");

        expect(await syncWrites()).toEqual([`DELETE ${ANNO}`]);
        expect(lib.items.has(ANNO)).toBe(false);
        expect(await row()).toBeUndefined();
    });

    test("accept-remote brings it back with the remote edit", async () => {
        await conflictAfterDelete();

        await conflicts.resolveItemConflict(USER_ID, ANNO, "accept-remote");

        expect((await row())!.syncStatus).toBe("synced");
        expect(await visibleInReader()).toEqual([ANNO]);
    });
});

describe("a trashed note meeting a remote edit", () => {
    test("merges: trashing and the remote text are different fields", async () => {
        const lib = await setup();
        lib.addItem({ key: "NOTEKEY1", data: { itemType: "note", parentItem: ATTACH, note: "<p>n</p>" } });
        await h.sync.startSync();
        await mutateItem(USER_ID, "NOTEKEY1", "note", (d) => {
            d.deleted = true;
        });
        lib.updateItem("NOTEKEY1", { note: "<p>remote</p>" });

        await h.sync.startSync();

        expect(lib.items.get("NOTEKEY1")!.data).toMatchObject({ deleted: true, note: "<p>remote</p>" });
        expect((await db.items.get([USER_ID, "NOTEKEY1"]))!.syncStatus).toBe("synced");
    });
});
