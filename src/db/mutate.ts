import { db } from "db/db";
import { deriveIndexFields, normalizeItem, toZoteroDate } from "db/normalize";
import { putGroup, readKey, syncTransaction, SyncWriter } from "db/sync/commit";
import { afterLocalDelete, afterLocalEdit, joinGroup } from "db/sync/decide";
import { deriveSyncStatus } from "db/sync/model";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { KeyState } from "db/sync/model";
import type { AnyIDBZoteroItem, IDBZoteroItem } from "types/db-schema";
import type { AnyZoteroItem, ZoteroItem } from "types/zotero";
import type { ZoteroItemData, ZoteroItemDataTypeMap } from "types/zotero-item";

/**
 * The write side of local item changes: every edit, delete and creation of
 * Zotero data made in ZotFlow goes through here, so the rules below hold
 * whichever service made it.
 *
 * - Index columns (`title`, `searchTags`, `parentItem`, …) are recomputed
 *   from `raw.data` when the row is committed, the same way sync builds them.
 * - `dateModified` is stamped on the column and in `raw.data`.
 * - The row becomes unsynced (`synced = 0`) and `localRevision` advances, so
 *   the next sync uploads it and a sync already under way notices it.
 * - The first edit of a clean row keeps the server copy it started from as
 *   the merge base (`syncCache`).
 * - A row created or edited under an item the server deleted joins that
 *   deletion's conflict group at once.
 * - A row in conflict stays in conflict: only the user ends one.
 */

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
 * `parentItem` and `collections`) are recomputed from it, the row is marked
 * unsynced, and `dateModified` is stamped on both the column and `raw.data`.
 *
 * `edit` must be synchronous: inside `mutateItem` it runs in a Dexie
 * transaction, which an awaited non-Dexie promise would commit early.
 *
 * @throws {ZotFlowError} if `edit` changed the key, item type or version.
 */
export function applyLocalEdit<T extends ZoteroItemData>(
    item: IDBZoteroItem<T>,
    edit: (data: T) => void,
    now: Date = new Date(),
): IDBZoteroItem<T> {
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

    const row = asAny(next);
    Object.assign(row, deriveIndexFields(row.raw.data));
    row.dateModified = dateModified;
    row.synced = row.localOnly ? 1 : 0;
    row.localRevision = (item.localRevision ?? 0) + 1;
    row.syncStatus = item.syncStatus === "conflict" ? "conflict" : deriveSyncStatus(row, undefined);
    return next;
}

/**
 * A row for an item created in ZotFlow, built the way sync builds server
 * rows so its index columns come from `raw` like any other row. `push`
 * queues it for creation on Zotero; `local-only` never syncs (annotations
 * extracted from a PDF). Store it with `createLocalItems`.
 */
export function newLocalItem<T extends ZoteroItemData>(
    raw: ZoteroItem<T>,
    libraryID: number,
    scope: "push" | "local-only",
): IDBZoteroItem<T> {
    const row = normalizeItem(raw as unknown as AnyZoteroItem, libraryID);
    row.version = 0;
    row.localRevision = 0;
    if (scope === "push") {
        row.synced = 0;
    } else {
        row.synced = 1;
        row.localOnly = true;
    }
    row.syncStatus = deriveSyncStatus(row, undefined);
    return row as unknown as IDBZoteroItem<T>;
}

/** The remote-deletion group an ancestor of `parentKey` (or itself) belongs to. */
async function groupAbove(libraryID: number, parentKey: string): Promise<string | undefined> {
    const seen = new Set<string>();
    let key = parentKey;
    while (key && !seen.has(key)) {
        seen.add(key);
        const conflict = await db.syncConflicts.get([libraryID, key]);
        if (conflict?.kind === "remote-deleted" && conflict.group) return conflict.group;
        const row = await db.items.get([libraryID, key]);
        key = row?.parentItem ?? "";
    }
    return undefined;
}

/**
 * Joins `next` to the remote deletion of an ancestor, if there is one and it
 * is not in a conflict of its own already.
 */
async function joinDeletionAbove(libraryID: number, key: string, next: KeyState): Promise<KeyState> {
    const row = next.row;
    if (!row || row.localOnly || next.conflict || !row.parentItem) return next;
    const group = await groupAbove(libraryID, row.parentItem);
    if (!group) return next;
    const record = await db.syncGroups.get([libraryID, group]);
    if (record && !record.members.includes(key)) {
        await putGroup({ ...record, members: [...record.members, key] });
    }
    return joinGroup(next, libraryID, key, group, new Date().toISOString());
}

/** One edit for `mutateItems`. */
export interface LocalEdit {
    key: string;
    /** Only edit an item of this type; any other is treated as absent. */
    itemType?: string;
    edit: (data: ZoteroItemData) => void;
}

/**
 * Reads, edits and writes back several items in one transaction.
 *
 * @returns the written rows, in order; `undefined` where there was no such
 *   item (of that type) — e.g. one the server deleted meanwhile. Callers
 *   must treat that as "the item is gone", never drop the edit silently.
 */
export async function mutateItems(libraryID: number, edits: LocalEdit[]): Promise<(AnyIDBZoteroItem | undefined)[]> {
    if (edits.length === 0) return [];
    return syncTransaction(async () => {
        const writer = new SyncWriter(libraryID);
        const written: boolean[] = [];
        for (const { key, itemType, edit } of edits) {
            const state = await readKey(libraryID, key);
            const row = state.row;
            if (!row || (itemType && row.itemType !== itemType)) {
                written.push(false);
                continue;
            }
            const edited = asAny(applyLocalEdit(row as IDBZoteroItem<ZoteroItemData>, edit));
            const next = await joinDeletionAbove(libraryID, key, afterLocalEdit(state, edited));
            await writer.commit(key, state, next);
            written.push(true);
        }
        const out: (AnyIDBZoteroItem | undefined)[] = [];
        for (let i = 0; i < edits.length; i++) {
            out.push(written[i] ? await db.items.get([libraryID, edits[i]!.key]) : undefined);
        }
        return out;
    });
}

/**
 * Reads, edits and writes back one item in a single transaction.
 *
 * With `itemType`, an item of any other type is left alone and treated as
 * absent — callers that edit type-specific fields always check the type, and
 * this makes the check part of the same read as the write.
 *
 * @returns the written row, or `undefined` if there is no such item (of that
 *   type): the item is gone (deleted in Zotero, or by the user elsewhere).
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
    const [row] = await mutateItems(libraryID, [{ key, itemType, edit }]);
    return row;
}

/**
 * A new row for a key whose delete is still waiting to be uploaded: the
 * delete is taken back and the row becomes an edit of the item Zotero has
 * (a create would be refused — the key exists there).
 */
function recreated(state: KeyState, row: AnyIDBZoteroItem): KeyState {
    const log = state.deleteLog;
    if (!log || state.conflict) return { row };
    const next: KeyState = {
        row: { ...row, version: log.version, synced: row.localOnly ? 1 : 0 },
        journal: state.journal,
    };
    if (log.version > 0) {
        next.cache = {
            libraryID: log.libraryID,
            key: log.key,
            version: log.version,
            data: structuredClone(log.snapshot.raw.data as unknown as Record<string, unknown>),
        };
    }
    return next;
}

/**
 * Stores rows made by `newLocalItem` (replacing any row with the same key).
 * A row created under an item the server deleted joins that conflict.
 */
export async function createLocalItems(libraryID: number, rows: AnyIDBZoteroItem[]): Promise<void> {
    if (rows.length === 0) return;
    await syncTransaction(async () => {
        const writer = new SyncWriter(libraryID);
        for (const row of rows) {
            const state = await readKey(libraryID, row.key);
            const next = await joinDeletionAbove(libraryID, row.key, recreated(state, row));
            await writer.commit(row.key, state, next);
        }
    });
}

export interface LocalDeleteResult {
    /** Keys whose rows are gone (hard deleted, or never pushed). */
    removed: string[];
    /** Notes moved to Zotero's trash (an edit of `deleted`). */
    trashed: string[];
}

/**
 * Deletes items locally, the way Zotero does: notes go to the trash (an
 * edit, uploaded as a patch); annotations and anything else are hard-deleted
 * — the row goes at once and the delete log carries the DELETE to the
 * server. An item that never reached the server is simply removed.
 *
 * Only the rows named are touched, never their children: callers pass
 * leaves (annotations, notes). Hard-deleting an item with children here
 * (an attachment with annotations) would orphan them; delete the children
 * first, or extend this to do so.
 */
export async function deleteLocalItems(libraryID: number, keys: string[]): Promise<LocalDeleteResult> {
    const result: LocalDeleteResult = { removed: [], trashed: [] };
    if (keys.length === 0) return result;
    const now = new Date();
    await syncTransaction(async () => {
        const writer = new SyncWriter(libraryID);
        for (const key of keys) {
            const state = await readKey(libraryID, key);
            const row = state.row;
            if (!row) continue;

            // Zotero has never had it: not sent, never there (no merge base),
            // and no conflict showing a server object under this key. (A
            // remote-deletion group does not: it says the parent is gone.)
            const neverPushed =
                row.version === 0 && !state.journal && !state.cache && state.conflict?.kind !== "changed";
            if (row.itemType === "note" && !neverPushed && !row.localOnly) {
                const edited = asAny(
                    applyLocalEdit(row as IDBZoteroItem<ZoteroItemData>, (d) => {
                        d.deleted = true;
                    }, now),
                );
                await writer.commit(key, state, afterLocalEdit(state, edited));
                result.trashed.push(key);
                continue;
            }

            const { next, leftGroup } = afterLocalDelete(state, now.toISOString());
            await writer.commit(key, state, next);
            if (leftGroup) {
                const record = await db.syncGroups.get([libraryID, leftGroup]);
                if (record) await putGroup({ ...record, members: record.members.filter((m) => m !== key) });
            }
            result.removed.push(key);
        }
    });
    return result;
}
