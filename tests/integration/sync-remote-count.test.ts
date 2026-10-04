/**
 * `countRemoteChanges`: what the Activity Center shows as the ↓ count — the
 * changes a sync would download, read without storing anything.
 */
import { describe, test, expect, afterEach } from "vitest";
import { db } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";

let h: SyncHarness;
afterEach(() => h?.dispose());

describe("countRemoteChanges", () => {
    test("counts new, changed and deleted items since the cursor", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        lib.addItem({ key: "BBBBBBBB" });
        lib.addItem({ key: "CCCCCCCC" });
        await h.sync.startSync();

        lib.addItem({ key: "DDDDDDDD" });
        lib.updateItem("AAAAAAAA", { title: "Changed" });
        lib.deleteItem("BBBBBBBB");

        expect(await h.sync.countRemoteChanges("user", USER_ID)).toBe(3);
    });

    test("is zero after a sync", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();

        expect(await h.sync.countRemoteChanges("user", USER_ID)).toBe(0);
    });

    test("stores nothing and leaves the cursor", async () => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA" });
        await h.sync.startSync();
        const cursor = (await db.libraries.get(USER_ID))!.itemVersion;

        lib.addItem({ key: "BBBBBBBB" });
        await h.sync.countRemoteChanges("user", USER_ID);

        expect(await db.items.count()).toBe(1);
        expect((await db.libraries.get(USER_ID))!.itemVersion).toBe(cursor);
    });

    test("a failed request is reported as a network error", async () => {
        h = await createSyncHarness();
        h.server.failNext({ status: 500 });

        await expect(h.sync.countRemoteChanges("user", USER_ID)).rejects.toThrow(/Could not check library/);
    });
});
