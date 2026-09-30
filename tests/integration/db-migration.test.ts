/**
 * Dexie version upgrades that rewrite stored rows.
 *
 * Each test builds a database at the previous schema version by hand, seeds
 * it the way older plugin versions stored rows, then opens the real `db` so
 * the upgrade chain runs exactly as it does for an existing user.
 */
import Dexie from "dexie";
import { describe, test, expect, beforeEach } from "vitest";

import { db } from "db/db";

import type { AnyIDBZoteroItem } from "types/db-schema";

const LIB = 1;

/** Open the database at v5, the schema before titles were base-mapped. */
async function openV5(): Promise<Dexie> {
    const legacy = new Dexie(db.name);
    legacy.version(5).stores({
        keys: "&key",
        groups: "&id",
        libraries: "&id",
        collections: `&[libraryID+key], [libraryID+trashed],
            [libraryID+syncStatus], [libraryID+parentCollection]`,
        items: `&[libraryID+key], [libraryID+syncStatus],
            [libraryID+itemType+trashed],
            [libraryID+parentItem+itemType+trashed],
            *collections, *searchCreators, *searchTags, dateModified,
            lastAccessedAt`,
        files: "&[libraryID+key], md5, lastAccessedAt",
        cslCache: "&key",
    });
    await legacy.open();
    return legacy;
}

/** A row as v5 stored it: `title` computed from `data.title` only. */
function legacyRow(
    key: string,
    itemType: string,
    data: Record<string, unknown>,
    title = "",
) {
    return {
        libraryID: LIB,
        key,
        itemType,
        title,
        parentItem: "",
        trashed: 0,
        collections: [],
        searchCreators: [],
        searchTags: [],
        raw: { key, data: { key, itemType, ...data } },
    };
}

beforeEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
});

describe("v6: base-mapped titles", () => {
    test("backfills the titles v5 stored empty", async () => {
        const legacy = await openV5();
        await legacy
            .table("items")
            .bulkPut([
                legacyRow("CASE0001", "case", { caseName: "Roe v. Wade" }),
                legacyRow("STAT0001", "statute", {
                    nameOfAct: "Clean Air Act",
                }),
                legacyRow("MAIL0001", "email", { subject: "Re: draft" }),
            ]);
        legacy.close();

        await db.open();
        const titles = (await db.items.toArray()).map((i: AnyIDBZoteroItem) => [
            i.key,
            i.title,
        ]);
        expect(Object.fromEntries(titles)).toEqual({
            CASE0001: "Roe v. Wade",
            STAT0001: "Clean Air Act",
            MAIL0001: "Re: draft",
        });
    });

    test("leaves other rows untouched", async () => {
        const legacy = await openV5();
        await legacy
            .table("items")
            .bulkPut([
                legacyRow("ARTICLE1", "journalArticle", {}, ""),
                legacyRow("CASE0002", "case", { caseName: "New" }, "Kept"),
            ]);
        legacy.close();

        await db.open();
        expect((await db.items.get([LIB, "ARTICLE1"]))?.title).toBe("");
        expect((await db.items.get([LIB, "CASE0002"]))?.title).toBe("Kept");
    });
});
