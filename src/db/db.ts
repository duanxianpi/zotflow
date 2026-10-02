import Dexie from "dexie";

import { itemTitle } from "db/normalize";
import { planV7Migration } from "db/sync/migrate-v7";
import { BASE_FIELD_MAP } from "types/zotero-base-fields";

import type { IndexableTypePart, Table } from "dexie";
import type {
    IDBZoteroFile,
    IDBZoteroCollection,
    IDBZoteroLibrary,
    AnyIDBZoteroItem,
    IDBZoteroKey,
    IDBZoteroGroup,
    IDBCslCacheEntry,
    IDBSyncCache,
    IDBSyncConflict,
    IDBSyncDeleteLog,
    IDBSyncGroup,
    IDBSyncQueueEntry,
    IDBUploadJournal,
} from "types/db-schema";
import type { V6Row } from "db/sync/migrate-v7";

/** Dexie subclass defining the IndexedDB schema for ZotFlow. */
export class ZotFlowDB extends Dexie {
    keys!: Table<IDBZoteroKey, string>;
    groups!: Table<IDBZoteroGroup, number>;
    items!: Table<AnyIDBZoteroItem, [number, string]>;
    collections!: Table<IDBZoteroCollection, [number, string]>;
    libraries!: Table<IDBZoteroLibrary, number>;
    files!: Table<IDBZoteroFile, [number, string]>;
    cslCache!: Table<IDBCslCacheEntry, string>;
    syncCache!: Table<IDBSyncCache, [number, string]>;
    syncDeleteLog!: Table<IDBSyncDeleteLog, [number, string]>;
    syncConflicts!: Table<IDBSyncConflict, [number, string]>;
    syncGroups!: Table<IDBSyncGroup, [number, string]>;
    syncQueue!: Table<IDBSyncQueueEntry, [number, string]>;
    uploadJournal!: Table<IDBUploadJournal, [number, string]>;

    constructor() {
        super("zotflow-dev");

        // Schema Definition
        this.version(1).stores({
            // Zotero Key
            keys: "&key",

            // Zotero Group
            groups: "&id",

            // Zotero Libraries
            libraries: "&id",

            // Zotero Collections
            collections: `
                &[libraryID+key], 
                [libraryID+trashed],
                [libraryID+syncStatus]
            `,

            // Zotero Items
            items: `
                &[libraryID+key], 
                [libraryID+syncStatus],
                [libraryID+itemType+trashed],
                [libraryID+parentItem+itemType+trashed],
                *collections, 
                *searchCreators, 
                *searchTags, 
                dateModified
            `,

            // Zotero Files
            files: "&[libraryID+key], md5, lastAccessedAt",
        });

        // v2: Add [libraryID+parentCollection] index to collections
        this.version(2).stores({
            collections: `
                &[libraryID+key], 
                [libraryID+trashed],
                [libraryID+syncStatus],
                [libraryID+parentCollection]
            `,
        });

        // v3: Add lastAccessedAt index to items
        this.version(3).stores({
            items: `
                &[libraryID+key], 
                [libraryID+syncStatus],
                [libraryID+itemType+trashed],
                [libraryID+parentItem+itemType+trashed],
                *collections, 
                *searchCreators, 
                *searchTags, 
                dateModified,
                lastAccessedAt
            `,
        });

        // v4: Store cached file bytes as ArrayBuffer instead of Blob.
        // WebKit/iPadOS IndexedDB Blob handles detach intermittently, causing
        // spurious read failures and needless re-downloads. The indexes are
        // unchanged, but old records hold a `blob` field the new code no longer
        // reads; the cache is fully regenerable from Zotero, so clear it.
        this.version(4).upgrade(async (tx) => {
            await tx.table("files").clear();
        });

        // v5: Key-value cache for the CSL renderer (styles, locales, index).
        this.version(5).stores({
            cslCache: "&key",
        });

        // v6: Titles are now base-field mapped (case → caseName, statute →
        // nameOfAct, email → subject). Delta sync never refetches unchanged
        // items, so backfill the titles those types were stored without.
        this.version(6).upgrade(async (tx) => {
            const mappedTypes = new Set(
                Object.keys(BASE_FIELD_MAP).filter(
                    (type) => BASE_FIELD_MAP[type]?.title,
                ),
            );
            await tx
                .table<AnyIDBZoteroItem>("items")
                .filter((item) => !item.title && mappedTypes.has(item.itemType))
                .modify((item) => {
                    if (item.raw?.data) item.title = itemTitle(item.raw.data);
                });
        });

        // v7: the sync model of docs/sync-architecture.md. Each sync fact
        // gets its own place: `synced` on the row, the merge base in
        // `syncCache`, pending deletes in `syncDeleteLog`, conflicts (and
        // remote-deletion groups) in their tables, retries in `syncQueue`,
        // writes of unknown outcome in `uploadJournal`. `syncStatus` stays,
        // derived. See src/db/sync/migrate-v7.ts for the mapping.
        this.version(7)
            .stores({
                syncCache: "&[libraryID+key]",
                syncDeleteLog: "&[libraryID+key]",
                syncConflicts: "&[libraryID+key], [libraryID+group]",
                syncGroups: "&[libraryID+id]",
                syncQueue: "&[libraryID+key], [libraryID+lastCheck]",
                uploadJournal: "&[libraryID+key]",
            })
            .upgrade(async (tx) => {
                const items = tx.table<V6Row, [number, string]>("items");
                const plan = planV7Migration(
                    await items.toArray(),
                    new Date().toISOString(),
                );
                await items.bulkDelete(plan.removed);
                await items.bulkPut(plan.rows);
                await tx.table("syncDeleteLog").bulkPut(plan.deleteLog);
                await tx.table("syncConflicts").bulkPut(plan.conflicts);
                await tx.table("syncGroups").bulkPut(plan.groups);
            });
    }
}

/**
 * Generate the Cartesian product of an array of arrays.
 *
 * @param arrays The input array of arrays, e.g. [[1, 2], ['a', 'b']]
 * @returns All possible combinations
 */
export function getCombinations(
    arrays: IndexableTypePart[][],
): IndexableTypePart[][] {
    return arrays.reduce<IndexableTypePart[][]>(
        (acc, currList) => {
            return acc.flatMap((prevCombination) => {
                return currList.map((item) => {
                    return [...prevCombination, item];
                });
            });
        },
        [[]],
    );
}

/** Singleton `ZotFlowDB` instance for worker-only database access. */
export const db = new ZotFlowDB();
