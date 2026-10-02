import { db } from "db/db";
import { deriveIndexFields, normalizeItem, toZoteroDate } from "db/normalize";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { AnyIDBZoteroItem, IDBZoteroItem } from "types/db-schema";
import type { AnyZoteroItem, ZoteroItem } from "types/zotero";
import type { ZoteroItemData, ZoteroItemDataTypeMap } from "types/zotero-item";

/**
 * The write side of local item changes: every edit, delete and creation of
 * Zotero data made in ZotFlow goes through here, so the rules below hold
 * whichever service made it.
 *
 * - Index columns (`title`, `searchTags`, `parentItem`, …) are recomputed
 *   from `raw.data` (`deriveIndexFields`), the same way sync builds them.
 * - `dateModified` is stamped on the column and in `raw.data`.
 * - The sync status advances so the next sync pushes the change.
 */

/**
 * The sync status an item moves to after a local edit.
 *
 * Only `synced` changes. `created` must stay so push still creates it;
 * `conflict` must stay so the edit waits for the user's keep-local /
 * accept-remote choice instead of being pushed over the server copy;
 * `ignore` rows are never pushed. `deleted` is queued for a server-side
 * delete, and an edit has nowhere to go — callers must not reach it.
 */
function statusAfterEdit(item: AnyIDBZoteroItem): AnyIDBZoteroItem["syncStatus"] {
    if (item.syncStatus === "deleted") {
        throw new ZotFlowError(
            ZotFlowErrorCode.DB_WRITE_FAILED,
            "applyLocalEdit",
            `Cannot edit item ${item.key}: it is pending deletion`,
        );
    }
    return item.syncStatus === "synced" ? "updated" : item.syncStatus;
}

/** Views a typed row as the union the helpers take. */
function asAny<T extends ZoteroItemData>(item: IDBZoteroItem<T>): AnyIDBZoteroItem {
    return item as unknown as AnyIDBZoteroItem;
}

/**
 * Applies a local edit to an item and returns the new row, leaving the input
 * untouched.
 *
 * `edit` mutates a clone of `raw.data`; it may change any field but `key`,
 * `itemType` and `version`. Afterwards the index columns (including
 * `parentItem` and `collections`) are recomputed from it, the sync status
 * advances, and `dateModified` is stamped on both the column and `raw.data`.
 *
 * `edit` must be synchronous: inside `mutateItem` it runs in a Dexie
 * transaction, which an awaited non-Dexie promise would commit early.
 *
 * @throws {ZotFlowError} if the item is pending deletion, or `edit` changed
 *   its key, item type or version.
 */
export function applyLocalEdit<T extends ZoteroItemData>(
    item: IDBZoteroItem<T>,
    edit: (data: T) => void,
    now: Date = new Date(),
): IDBZoteroItem<T> {
    const syncStatus = statusAfterEdit(asAny(item));
    const next = structuredClone(item);
    edit(next.raw.data);

    // What identifies the item and drives sync is not an edit's to change.
    const { key, itemType, version } = item.raw.data;
    const after = next.raw.data;
    if (after.key !== key || after.itemType !== itemType || after.version !== version) {
        throw new ZotFlowError(
            ZotFlowErrorCode.DB_WRITE_FAILED,
            "applyLocalEdit",
            `An edit of ${item.key} may not change its key, item type or version`,
        );
    }

    const dateModified = toZoteroDate(now);
    next.raw.data.dateModified = dateModified;

    return {
        ...next,
        ...deriveIndexFields(next.raw.data),
        syncStatus,
        dateModified,
    };
}

/**
 * Whether an item exists only locally: it was never pushed, so deleting it
 * means removing its row — there is nothing on the server to delete.
 */
export function isNeverPushed(item: AnyIDBZoteroItem): boolean {
    return item.syncStatus === "created";
}

/**
 * Queues a server-side delete for an item and returns the new row.
 *
 * This is Zotero's hard delete (`DELETE /items/<key>`), which is how
 * annotations go away; notes are trashed instead, which is an edit of
 * `deleted` (`applyLocalEdit`). `raw.data.deleted` is set too, so the derived
 * `trashed` column hides the row until the delete is pushed.
 *
 * How a delete meets a conflict is the sync layer's to decide; here it is
 * queued as a delete, as it always was.
 *
 * @throws {ZotFlowError} if the item was never pushed — callers remove the
 *   row outright instead (`isNeverPushed`).
 */
export function applyLocalDelete<T extends ZoteroItemData>(
    item: IDBZoteroItem<T>,
    now: Date = new Date(),
): IDBZoteroItem<T> {
    if (isNeverPushed(asAny(item))) {
        throw new ZotFlowError(
            ZotFlowErrorCode.DB_WRITE_FAILED,
            "applyLocalDelete",
            `Item ${item.key} was never pushed; delete the row instead`,
        );
    }
    const next = structuredClone(item);
    next.raw.data.deleted = true;

    const dateModified = toZoteroDate(now);
    next.raw.data.dateModified = dateModified;

    return {
        ...next,
        ...deriveIndexFields(next.raw.data),
        syncStatus: "deleted",
        dateModified,
    };
}

/**
 * A row for an item created in ZotFlow, built the way sync builds server
 * rows so its index columns come from `raw` like any other row. `push`
 * queues it for creation on Zotero; `local-only` never syncs (annotations
 * extracted from a PDF).
 */
export function newLocalItem<T extends ZoteroItemData>(
    raw: ZoteroItem<T>,
    libraryID: number,
    scope: "push" | "local-only",
): IDBZoteroItem<T> {
    const row = normalizeItem(raw as unknown as AnyZoteroItem, libraryID);
    return {
        ...row,
        syncStatus: scope === "push" ? "created" : "ignore",
    } as unknown as IDBZoteroItem<T>;
}

/**
 * Reads, edits and writes back one item in a single transaction.
 *
 * With `itemType`, an item of any other type is left alone and treated as
 * absent — callers that edit type-specific fields always check the type, and
 * this makes the check part of the same read as the write.
 *
 * @returns the written row, or `undefined` if there is no such item (of that type).
 * @throws {ZotFlowError} if the item is pending deletion.
 */
export function mutateItem<K extends keyof ZoteroItemDataTypeMap>(
    libraryID: number,
    key: string,
    itemType: K,
    edit: (data: ZoteroItemDataTypeMap[K]) => void,
): Promise<IDBZoteroItem<ZoteroItemDataTypeMap[K]> | undefined>;
export function mutateItem(
    libraryID: number,
    key: string,
    edit: (data: ZoteroItemData) => void,
): Promise<AnyIDBZoteroItem | undefined>;
export async function mutateItem(
    libraryID: number,
    key: string,
    typeOrEdit: string | ((data: ZoteroItemData) => void),
    maybeEdit?: (data: ZoteroItemData) => void,
): Promise<AnyIDBZoteroItem | undefined> {
    const itemType = typeof typeOrEdit === "string" ? typeOrEdit : undefined;
    const edit = typeof typeOrEdit === "function" ? typeOrEdit : maybeEdit;
    if (!edit) return undefined;

    return db.transaction("rw", db.items, async () => {
        const item = await db.items.get([libraryID, key]);
        if (!item || (itemType && item.itemType !== itemType)) {
            return undefined;
        }
        const next = asAny(applyLocalEdit(item as IDBZoteroItem<ZoteroItemData>, edit));
        await db.items.put(next);
        return next;
    });
}
