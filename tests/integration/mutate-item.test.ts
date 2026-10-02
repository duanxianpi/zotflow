/**
 * `applyLocalEdit` / `mutateItem` — the single write path for local edits of
 * Zotero data.
 *
 * The invariants are what the services used to maintain by hand, each slightly
 * differently: derived columns follow `raw.data`, the sync status advances
 * without clobbering `created` or `conflict`, and `dateModified` is stamped.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
    applyLocalDelete,
    applyLocalEdit,
    isNeverPushed,
    mutateItem,
    newLocalItem,
} from "db/mutate";
import { deriveIndexFields, normalizeItem, toZoteroDate } from "db/normalize";
import { ZotFlowError } from "utils/error";
import { TagService } from "worker/services/tag";
import { DEFAULT_SETTINGS } from "settings/types";
import { db, resetDb, seedItem } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";
import type { AnyIDBZoteroItem, IDBZoteroItem } from "types/db-schema";
import type { AnyZoteroItem } from "types/zotero";
import type { ZoteroItemData } from "types/zotero-item";

const LIB = 1;
const OLD = "2020-01-01T00:00:00Z";

/** A stored row built the way sync builds it, so its columns start consistent. */
function storedItem(
    data: Record<string, unknown>,
    syncStatus: AnyIDBZoteroItem["syncStatus"] = "synced",
): IDBZoteroItem<ZoteroItemData> {
    const key = (data.key as string | undefined) ?? "ITEMKEY1";
    const raw = {
        key,
        version: 3,
        library: { type: "user", id: LIB, name: "Library" },
        links: {},
        meta: {},
        data: {
            key,
            version: 3,
            itemType: "journalArticle",
            title: "Original",
            creators: [],
            tags: [],
            collections: [],
            relations: {},
            dateAdded: OLD,
            dateModified: OLD,
            ...data,
        },
    } as unknown as AnyZoteroItem;
    const item = normalizeItem(raw, LIB);
    item.syncStatus = syncStatus;
    return item;
}

/** The derived columns of a row, for comparison against a fresh derivation. */
function columnsOf(item: AnyIDBZoteroItem | IDBZoteroItem<ZoteroItemData>) {
    return {
        title: item.title,
        searchCreators: item.searchCreators,
        searchTags: item.searchTags,
        citationKey: item.citationKey,
        trashed: item.trashed,
        parentItem: item.parentItem,
        collections: item.collections,
    };
}

describe("applyLocalEdit: derived columns", () => {
    const edits: [string, Record<string, unknown>, (d: any) => void][] = [
        ["retitle", {}, (d) => (d.title = "New title")],
        ["add tags", {}, (d) => (d.tags = [{ tag: "a" }, { tag: "b", type: 1 }])],
        ["clear tags", { tags: [{ tag: "old" }] }, (d) => (d.tags = [])],
        [
            "add creators",
            {},
            (d) =>
                (d.creators = [
                    { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
                    { creatorType: "author", name: "ACME Corp" },
                ]),
        ],
        ["citation key in extra", {}, (d) => (d.extra = "Citation Key: smith-2020")],
        ["trash", {}, (d) => (d.deleted = true)],
        ["untrash", { deleted: true }, (d) => (d.deleted = false)],
        [
            "case title lives in caseName",
            { itemType: "case", title: undefined, caseName: "Old v. Case" },
            (d) => (d.caseName = "Roe v. Wade"),
        ],
        [
            "note body",
            { itemType: "note", note: "<p>old</p>", title: undefined },
            (d) => (d.note = "<p>First &amp; line</p><p>Second</p>"),
        ],
    ];

    for (const [name, seed, edit] of edits) {
        test(`after "${name}" every derived column matches raw.data`, () => {
            const next = applyLocalEdit(storedItem(seed), edit);
            expect(columnsOf(next)).toEqual(deriveIndexFields(next.raw.data));
        });
    }

    test("a note title uses the same algorithm as sync", () => {
        // The old item-note copy split on literal newlines only, so a
        // multi-paragraph note got its paragraphs run together.
        const next = applyLocalEdit(
            storedItem({ itemType: "note", note: "", title: undefined }),
            (d: any) => (d.note = "<p>First &amp; line</p><p>Second</p>"),
        );
        expect(next.title).toBe("First & line");
    });

    test("the input row is left untouched", () => {
        const item = storedItem({ tags: [{ tag: "keep" }] });
        const before = structuredClone(item);

        applyLocalEdit(item, (d) => (d.tags = []));

        expect(item).toEqual(before);
    });
});

describe("applyLocalEdit: fields that are not the edit's to change", () => {
    test.each([
        ["key", (d: any) => (d.key = "OTHERKEY")],
        ["item type", (d: any) => (d.itemType = "book")],
        ["version", (d: any) => (d.version = 99)],
    ])("changing the %s is refused", (_name, edit) => {
        expect(() => applyLocalEdit(storedItem({}), edit)).toThrow(ZotFlowError);
    });

    test("moving a note to another parent moves its parentItem column too", () => {
        const next = applyLocalEdit(
            storedItem({ itemType: "note", note: "", title: undefined, parentItem: "PARENT01" }),
            (d: any) => (d.parentItem = "PARENT02"),
        );
        expect(next.parentItem).toBe("PARENT02");
    });

    test("changing collections updates the collections column", () => {
        const next = applyLocalEdit(storedItem({}), (d: any) => (d.collections = ["COLL0001"]));
        expect(next.collections).toEqual(["COLL0001"]);
    });
});

describe("applyLocalEdit: sync status", () => {
    test.each([
        ["synced", "updated"],
        ["updated", "updated"],
        // Never pushed: must still be created on the server.
        ["created", "created"],
        // Waits for keep-local / accept-remote; see the sync test below.
        ["conflict", "conflict"],
        ["ignore", "ignore"],
    ] as const)("%s becomes %s", (from, to) => {
        const next = applyLocalEdit(storedItem({}, from), (d) => (d.title = "x"));
        expect(next.syncStatus).toBe(to);
    });

    test("an item pending deletion refuses the edit", () => {
        expect(() =>
            applyLocalEdit(storedItem({}, "deleted"), (d) => (d.title = "x")),
        ).toThrow(ZotFlowError);
    });

    test("a conflict keeps its reason and the parked server copy", () => {
        const item = storedItem({}, "conflict");
        item.syncError = "Remote update conflict";
        item.serverCopyRaw = structuredClone(item.raw);

        const next = applyLocalEdit(item, (d) => (d.title = "x"));

        expect(next.syncError).toBe("Remote update conflict");
        expect(next.serverCopyRaw).toEqual(item.serverCopyRaw);
    });
});

describe("applyLocalEdit: dateModified", () => {
    test("the column and raw.data get the same Zotero-format timestamp", () => {
        const now = new Date("2026-09-30T12:34:56.789Z");

        const next = applyLocalEdit(storedItem({}), (d) => (d.title = "x"), now);

        expect(next.dateModified).toBe("2026-09-30T12:34:56Z");
        expect(next.raw.data.dateModified).toBe(toZoteroDate(now));
    });
});

describe("applyLocalDelete", () => {
    test.each(["synced", "updated", "deleted", "ignore", "conflict"] as const)(
        "%s is queued for deletion",
        (from) => {
            expect(applyLocalDelete(storedItem({}, from)).syncStatus).toBe("deleted");
        },
    );

    test("records the delete in raw.data and the derived columns", () => {
        const next = applyLocalDelete(storedItem({}));

        expect(next.raw.data.deleted).toBe(true);
        expect(next.trashed).toBe(1);
        expect(columnsOf(next)).toEqual(deriveIndexFields(next.raw.data));
    });

    test("a never-pushed item is refused: its row should just be removed", () => {
        expect(() => applyLocalDelete(storedItem({}, "created"))).toThrow(ZotFlowError);
        expect(isNeverPushed(storedItem({}, "created") as AnyIDBZoteroItem)).toBe(true);
    });
});

describe("newLocalItem", () => {
    const raw = (data: Record<string, unknown>) =>
        ({
            key: "NEWNOTE1",
            version: 0,
            library: { type: "user", id: LIB, name: "Library" },
            links: {},
            meta: {},
            data: { key: "NEWNOTE1", version: 0, tags: [], relations: {}, dateAdded: OLD, dateModified: OLD, ...data },
        }) as never;

    test("builds the index columns the way sync does", () => {
        const row = newLocalItem(
            raw({ itemType: "note", parentItem: "PARENT01", note: "<p>Hello</p><p>world</p>", tags: [{ tag: "t" }] }),
            LIB,
            "push",
        );
        expect(row.syncStatus).toBe("created");
        expect(row.title).toBe("Hello");
        expect(row.searchTags).toEqual(["t"]);
        expect(row.parentItem).toBe("PARENT01");
    });

    test("a local-only row is never pushed", () => {
        expect(newLocalItem(raw({ itemType: "note", note: "" }), LIB, "local-only").syncStatus).toBe("ignore");
    });
});

describe("mutateItem", () => {
    beforeEach(() => resetDb());

    test("writes the edited row back", async () => {
        await db.items.put(storedItem({ key: "ITEMKEY1" }) as AnyIDBZoteroItem);

        const written = await mutateItem(LIB, "ITEMKEY1", (d) => {
            d.tags = [{ tag: "fresh" }];
        });

        const stored = (await db.items.get([LIB, "ITEMKEY1"]))!;
        expect(stored).toEqual(written);
        expect(stored.searchTags).toEqual(["fresh"]);
        expect(stored.syncStatus).toBe("updated");
    });

    test("a missing item yields undefined and writes nothing", async () => {
        expect(await mutateItem(LIB, "NOSUCH01", () => {})).toBeUndefined();
        expect(await db.items.count()).toBe(0);
    });

    test("an item of another type is treated as absent", async () => {
        await db.items.put(storedItem({ key: "ITEMKEY1" }) as AnyIDBZoteroItem);

        const result = await mutateItem(LIB, "ITEMKEY1", "note", (d) => {
            d.note = "<p>should not land</p>";
        });

        expect(result).toBeUndefined();
        expect((await db.items.get([LIB, "ITEMKEY1"]))!.syncStatus).toBe("synced");
    });
});

describe("TagService.setItemTags", () => {
    beforeEach(() => resetDb());

    test("stamps dateModified like every other local edit", async () => {
        await seedItem({ libraryID: LIB, key: "ITEMKEY1", dateModified: OLD });
        const tags = new TagService(DEFAULT_SETTINGS, createFakeParentHost());

        await tags.setItemTags(LIB, "ITEMKEY1", [{ tag: "t" }]);

        expect((await db.items.get([LIB, "ITEMKEY1"]))!.dateModified).not.toBe(OLD);
    });
});

describe("editing a conflicted item, end to end", () => {
    let h: SyncHarness;
    afterEach(() => h?.dispose());

    test("the edit is held until the conflict is resolved", async () => {
        // Pull already advanced the row's version to the server's, so if the
        // edit moved the item to `updated`, the next push would be accepted
        // and silently overwrite the remote change.
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        lib.addItem({ key: "AAAAAAAA", data: { title: "Original" } });
        await h.sync.startSync();

        await db.items.update([USER_ID, "AAAAAAAA"], { syncStatus: "updated" });
        lib.updateItem("AAAAAAAA", { title: "Remote title" });
        await h.sync.startSync();
        expect((await db.items.get([USER_ID, "AAAAAAAA"]))!.syncStatus).toBe(
            "conflict",
        );

        await mutateItem(USER_ID, "AAAAAAAA", (d) => {
            d.tags = [{ tag: "local" }];
        });
        h.server.clearRequests();
        await h.sync.startSync();

        expect(h.server.requests.filter((r) => r.method === "POST")).toEqual([]);
        expect(lib.items.get("AAAAAAAA")!.data.title).toBe("Remote title");
        const stored = (await db.items.get([USER_ID, "AAAAAAAA"]))!;
        expect(stored.syncStatus).toBe("conflict");
        expect(stored.searchTags).toEqual(["local"]);
    });
});
