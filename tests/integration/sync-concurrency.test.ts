/**
 * Local writes that land while a sync step is waiting on the network
 * (scenarios from the v6 hardening, on the v7 model).
 *
 * Each upload batch is built in a transaction and its results folded back
 * in another; an edit between them bumps `localRevision`, so the result
 * keeps the edit and re-bases it on the server's answer, and the next round
 * of the same sync uploads it. These tests make the change from inside the
 * fetch, i.e. while the request is on the wire.
 *
 * Also here: fields that exist only on this device must survive a row being
 * replaced by its remote version.
 */
import { describe, test, expect, afterEach } from "vitest";
import { deleteLocalItems, mutateItem } from "db/mutate";
import { ConflictService } from "worker/services/conflict";
import { db, seedItem } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";

const KEY = "AAAAAAAA";

let h: SyncHarness;
let restoreFetch: (() => void) | undefined;
afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.dispose();
});

/** Run `during` once, while the first request with `method` is in flight. */
function onceDuring(method: string, during: () => Promise<unknown>) {
    const real = globalThis.fetch;
    let fired = false;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await real(input, init);
        if (!fired && init?.method === method) {
            fired = true;
            await during();
        }
        return response;
    };
    restoreFetch = () => (globalThis.fetch = real);
}

async function row(key = KEY) {
    return db.items.get([USER_ID, key]);
}

function setTags(tag: string) {
    return mutateItem(USER_ID, KEY, (d) => {
        d.tags = [{ tag }];
    });
}

/** A synced item on both sides. */
async function syncedItem() {
    h = await createSyncHarness();
    const lib = h.server.library(USER_ID);
    lib.addItem({ key: KEY, data: { title: "t", tags: [] } });
    await h.sync.startSync();
    return lib;
}

describe("an edit made while its upload is in flight", () => {
    test("is kept and goes up in the same sync", async () => {
        const lib = await syncedItem();
        await setTags("first");
        onceDuring("POST", () => setTags("second"));

        await h.sync.startSync();

        const stored = (await row())!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.searchTags).toEqual(["second"]);
        expect(stored.version).toBe(lib.items.get(KEY)!.version);
        expect(lib.items.get(KEY)!.data.tags).toEqual([{ tag: "second" }]);
    });

    test("the second upload is a patch of the edit alone", async () => {
        const lib = await syncedItem();
        await setTags("first");
        onceDuring("POST", () =>
            mutateItem(USER_ID, KEY, (d: any) => {
                d.extra = "second";
            }),
        );
        h.server.clearRequests();

        await h.sync.startSync();

        const posts = h.server.requests.filter((r) => r.method === "POST");
        expect(posts).toHaveLength(2);
        const second = (posts[1]!.body as Record<string, unknown>[])[0]!;
        expect(second).toHaveProperty("extra", "second");
        expect(second).not.toHaveProperty("tags");
        expect(lib.items.get(KEY)!.data).toMatchObject({ tags: [{ tag: "first" }], extra: "second" });
    });

    test("an unedited item is simply marked synced", async () => {
        const lib = await syncedItem();
        await setTags("first");

        await h.sync.startSync();

        const stored = (await row())!;
        expect(stored.syncStatus).toBe("synced");
        expect(stored.version).toBe(lib.items.get(KEY)!.version);
    });
});

describe("a created item changed while its create is in flight", () => {
    async function createdItem() {
        h = await createSyncHarness();
        await seedItem({ libraryID: USER_ID, key: KEY, syncStatus: "created", version: 0 });
        return h.server.library(USER_ID);
    }

    test("an edit becomes an update of the new server item", async () => {
        const lib = await createdItem();
        onceDuring("POST", () => setTags("second"));

        await h.sync.startSync();

        expect((await row())!.syncStatus).toBe("synced");
        expect(lib.items.get(KEY)!.data.tags).toEqual([{ tag: "second" }]);
    });

    test("deleting it sends a delete for the copy the server now has", async () => {
        const lib = await createdItem();
        onceDuring("POST", () => deleteLocalItems(USER_ID, [KEY]));

        await h.sync.startSync();

        expect(lib.items.has(KEY)).toBe(false);
        expect(await row()).toBeUndefined();
        expect(await db.syncDeleteLog.count()).toBe(0);
    });
});

describe("a later batch, after rows changed while an earlier batch was sent", () => {
    /** 51 new notes: two batches (50 + 1). Returns the key of the last. */
    async function twoBatches() {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "PARENT01", data: { title: "parent" } });
        await h.sync.startSync();
        const keys: string[] = [];
        for (let i = 0; i < 51; i++) {
            const key = `NOTE${String(i).padStart(4, "0")}`;
            keys.push(key);
            await seedItem({ libraryID: USER_ID, key, itemType: "note", parentItem: "PARENT01", syncStatus: "created", version: 0 });
        }
        return { lib, last: keys.at(-1)! };
    }

    /** Run `during` after the first POST's answer, and lose the second POST's answer if asked. */
    function onPosts(during: () => Promise<unknown>, loseSecond: boolean) {
        const real = globalThis.fetch;
        let posts = 0;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await real(input, init);
            if (init?.method === "POST") {
                posts++;
                if (posts === 1) await during();
                if (posts === 2 && loseSecond) throw new TypeError("answer lost");
            }
            return response;
        };
        restoreFetch = () => (globalThis.fetch = real);
    }

    test("a draft deleted meanwhile is not sent", async () => {
        const { lib, last } = await twoBatches();
        onPosts(() => deleteLocalItems(USER_ID, [last]), false);

        await h.sync.startSync();

        expect(lib.items.has(last)).toBe(false);
        expect(lib.items.size).toBe(51); // the parent and the 50 kept drafts
    });

    test("nor resurrected when that batch's answer is lost", async () => {
        const { lib, last } = await twoBatches();
        onPosts(() => deleteLocalItems(USER_ID, [last]), true);
        await h.sync.startSync();
        restoreFetch?.();

        await h.sync.startSync();

        expect(lib.items.has(last)).toBe(false);
        expect(await row(last)).toBeUndefined();
    });

    test("an edit made meanwhile goes out in the later batch", async () => {
        const { lib, last } = await twoBatches();
        onPosts(
            () =>
                mutateItem(USER_ID, last, "note", (d) => {
                    d.note = "<p>edited before its batch</p>";
                }),
            false,
        );

        await h.sync.startSync();

        expect(lib.items.get(last)!.data.note).toBe("<p>edited before its batch</p>");
        expect((await row(last))!.syncStatus).toBe("synced");
    });
});

describe("a delete made while an update is in flight", () => {
    test("is sent against the new version, in the same sync", async () => {
        const lib = await syncedItem();
        await setTags("first");
        onceDuring("POST", () => deleteLocalItems(USER_ID, [KEY]));

        await h.sync.startSync();

        expect(lib.items.has(KEY)).toBe(false);
        expect(await db.syncDeleteLog.count()).toBe(0);
    });
});

describe("a refused write", () => {
    test("keeps an edit made while it was in flight", async () => {
        const lib = await syncedItem();
        await setTags("first");
        lib.rejectWrite(KEY, { code: 400, message: "Invalid" });
        onceDuring("POST", () => setTags("second"));

        await h.sync.startSync();

        const stored = (await row())!;
        expect(stored.syncStatus).toBe("conflict");
        expect(stored.searchTags).toEqual(["second"]);
    });
});

describe("local-only fields", () => {
    const local = {
        lastAccessedAt: "2026-09-01T00:00:00.000Z",
        primaryViewState: { pageIndex: 7 },
    };

    test("survive a remote update being pulled", async () => {
        const lib = await syncedItem();
        await db.items.update([USER_ID, KEY], local);
        lib.updateItem(KEY, { title: "remote" });

        await h.sync.startSync();

        const stored = (await row())!;
        expect(stored.title).toBe("remote");
        expect(stored).toMatchObject(local);
    });

    test("survive accept-remote", async () => {
        const lib = await syncedItem();
        // Tags would merge as a set; a scalar field changed on both sides
        // is a real conflict.
        await mutateItem(USER_ID, KEY, (d: any) => (d.title = "mine"));
        lib.updateItem(KEY, { title: "theirs" });
        await h.sync.startSync();
        expect((await row())!.syncStatus).toBe("conflict");
        await db.items.update([USER_ID, KEY], local);

        await new ConflictService(h.host).resolveItemConflict(USER_ID, KEY, "accept-remote");

        expect(await row()).toMatchObject({ title: "theirs", ...local });
    });
});

describe("overlapping syncs", () => {
    test("a library is synced by one sync at a time", async () => {
        h = await createSyncHarness();
        h.server.library(USER_ID).addItem({ key: KEY });
        const spans: string[] = [];
        const real = h.sync.syncLibrary.bind(h.sync);
        h.sync.syncLibrary = async (...args: Parameters<typeof real>) => {
            spans.push("start");
            // Long enough for the other sync to reach the library.
            await new Promise((r) => setTimeout(r, 20));
            try {
                return await real(...args);
            } finally {
                spans.push("end");
            }
        };

        // "Sync all" and "sync this library" started together.
        const results = await Promise.all([h.sync.startSync(), h.sync.startSync(undefined, undefined, USER_ID)]);

        expect(results.map((r) => r.failCount)).toEqual([0, 0]);
        expect(spans).toEqual(["start", "end", "start", "end"]);
        expect(h.host.logsAt("info").some((l) => /already syncing; waiting/.test(l.message))).toBe(true);
    });
});
