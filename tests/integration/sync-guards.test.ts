/**
 * Guards that `startSync` cannot reach on its own.
 *
 * `upload` is public, so its preconditions have to hold without a preceding
 * startSync. The DB failure path likewise needs the store to break, which no
 * amount of fixture data will do on its own.
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import { db, seedItem } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";

let h: SyncHarness;
afterEach(() => {
    vi.restoreAllMocks();
    h?.dispose();
});

describe("upload called directly", () => {
    test("uploads without a preceding download", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });

        expect(await h.sync.upload("user", USER_ID)).toBe("success");
        expect(h.server.library(USER_ID).items.has("NEWITEM1")).toBe(true);
    });

    test("refuses to upload without an API key", async () => {
        h = await createSyncHarness();
        h.settings.zoteroapikey = "";
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });

        await expect(h.sync.upload("user", USER_ID)).rejects.toThrow(/No API key found for push/i);
        expect(h.server.requests).toHaveLength(0);
    });

    test("reports a library conflict so the caller downloads first", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "NEWITEM1", syncStatus: "created" });
        h.server.failNext({ status: 412, pathIncludes: "/items", method: "POST" });

        expect(await h.sync.upload("user", USER_ID)).toBe("library-conflict");
        // Nothing was applied, so nothing is in flight.
        expect(await db.uploadJournal.count()).toBe(0);
    });

    test("a library with nothing to upload makes no request", async () => {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: "AAAAAAAA", syncStatus: "synced" });

        expect(await h.sync.upload("user", USER_ID)).toBe("nothing");
        expect(h.server.requests).toHaveLength(0);
    });

    test("rows in another library are left alone", async () => {
        h = await createSyncHarness({ groups: [{ id: 777 }] });
        await seedItem({ libraryID: 777, key: "GROUPNEW", syncStatus: "created" });

        await h.sync.upload("user", USER_ID);

        expect(h.server.requests).toHaveLength(0);
        expect((await db.items.get([777, "GROUPNEW"]))!.syncStatus).toBe("created");
    });
});

describe("legacy key rows", () => {
    test("a key row written before joinedGroups existed still syncs the personal library", async () => {
        h = await createSyncHarness();
        const key = (await db.keys.toArray())[0]!;
        delete (key as { joinedGroups?: number[] }).joinedGroups;
        await db.keys.put(key);
        h.server.library(USER_ID).addItem({ key: "AAAAAAAA" });

        const result = await h.sync.startSync();

        expect(result.syncedLibraryIDs).toEqual([USER_ID]);
        expect(await db.items.count()).toBe(1);
    });
});

describe("store failures", () => {
    test("an unreadable key table is reported as a DB failure, not an auth one", async () => {
        h = await createSyncHarness();
        vi.spyOn(db.keys, "get").mockRejectedValue(new Error("IDB exploded"));

        await expect(h.sync.startSync()).rejects.toThrow(/Failed to query Key DB/i);
        expect(h.server.requests).toHaveLength(0);
    });
});

describe("settings updates", () => {
    test("updateSettings swaps the config a later run reads", async () => {
        h = await createSyncHarness({ mode: "bidirectional" });
        await seedItem({
            libraryID: USER_ID,
            key: "NEWITEM1",
            syncStatus: "created",
        });

        h.sync.updateSettings({
            ...h.settings,
            librariesConfig: { [USER_ID]: { mode: "readonly" } },
        });
        await h.sync.startSync();

        // The new mode took effect: readonly libraries never push.
        expect(h.server.requests.filter((r) => r.method === "POST")).toHaveLength(
            0,
        );
        expect((await db.items.get([USER_ID, "NEWITEM1"]))!.syncStatus).toBe(
            "created",
        );
    });
});
