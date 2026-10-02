/**
 * The one place that writes sync state.
 *
 * `commitKey` takes the state a decision produced (`decide.ts`) and writes
 * it: the row with its derived columns (index fields from `raw.data`,
 * `syncStatus` from `synced` / `version` / `localOnly` / the conflict),
 * copies of every snapshot, and the merge base, delete log, journal and
 * conflict records.
 *
 * Every function here must run inside a Dexie transaction over
 * `syncTables()`: callers read, decide and commit in one transaction, and
 * await nothing but Dexie inside it.
 */
import { db } from "db/db";
import { deriveIndexFields } from "db/normalize";
import { deriveSyncStatus, treeFingerprint } from "db/sync/model";

import type { KeyState } from "db/sync/model";
import type { Table } from "dexie";
import type {
    AnyIDBZoteroItem,
    IDBSyncConflict,
    IDBSyncGroup,
    IDBSyncQueueEntry,
} from "types/db-schema";

/** The tables a sync transaction spans. */
export function syncTables(): Table[] {
    return [
        db.items,
        db.syncCache,
        db.syncDeleteLog,
        db.syncConflicts,
        db.syncGroups,
        db.syncQueue,
        db.uploadJournal,
        db.libraries,
    ] as Table[];
}

/** Runs `fn` in one read-write transaction over the sync tables. */
export function syncTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return db.transaction("rw", syncTables(), fn);
}

/** Reads everything sync records about one object. */
export async function readKey(libraryID: number, key: string): Promise<KeyState> {
    const id: [number, string] = [libraryID, key];
    const [row, cache, deleteLog, journal, conflict] = await Promise.all([
        db.items.get(id),
        db.syncCache.get(id),
        db.syncDeleteLog.get(id),
        db.uploadJournal.get(id),
        db.syncConflicts.get(id),
    ]);
    return { row, cache, deleteLog, journal, conflict };
}

/** A row as it is stored: derived columns recomputed, legacy fields gone. */
function finalizeRow(row: AnyIDBZoteroItem, conflict: IDBSyncConflict | undefined): AnyIDBZoteroItem {
    const out = structuredClone(row) as AnyIDBZoteroItem & {
        syncError?: unknown;
        serverCopyRaw?: unknown;
    };
    delete out.syncError;
    delete out.serverCopyRaw;
    Object.assign(out, deriveIndexFields(out.raw.data));
    // The row's version is the server version its data is based on; the
    // payload's copies follow it so nothing reads a stale one.
    out.raw.version = out.version;
    (out.raw.data as { version?: number }).version = out.version;
    if (out.raw.data.dateAdded) out.dateAdded = out.raw.data.dateAdded;
    if (out.raw.data.dateModified) out.dateModified = out.raw.data.dateModified;
    out.syncStatus = deriveSyncStatus(out, conflict);
    return out;
}

/**
 * Writes `next` for one key, replacing what `prev` (as read in the same
 * transaction) recorded. Parts that are the same object in both are left
 * alone; everything written is a copy.
 */
async function writeKey(libraryID: number, key: string, prev: KeyState, next: KeyState): Promise<void> {
    const id: [number, string] = [libraryID, key];
    const put = async <T>(table: Table<T, [number, string]>, before: T | undefined, after: T | undefined) => {
        if (before === after) return;
        if (after === undefined) await table.delete(id);
        else await table.put(structuredClone(after));
    };
    await put(db.syncCache, prev.cache, next.cache);
    await put(db.syncDeleteLog, prev.deleteLog, next.deleteLog);
    await put(db.uploadJournal, prev.journal, next.journal);
    await put(db.syncConflicts, prev.conflict, next.conflict);
    // The row's status depends on the conflict, so it is rewritten whenever
    // either changed.
    if (prev.row !== next.row || prev.conflict !== next.conflict) {
        if (next.row) await db.items.put(finalizeRow(next.row, next.conflict));
        else if (prev.row) await db.items.delete(id);
    }
}

/** Writes decisions for one library: `commit` (or `update`) each key. */
export class SyncWriter {
    constructor(readonly libraryID: number) {}

    /** Writes `next` over `prev` for `key`. */
    async commit(key: string, prev: KeyState, next: KeyState): Promise<void> {
        await writeKey(this.libraryID, key, prev, next);
    }

    /** Reads the current state of `key`, applies `decide`, commits the result. */
    async update(key: string, decide: (state: KeyState) => KeyState): Promise<KeyState> {
        const prev = await readKey(this.libraryID, key);
        const next = decide(prev);
        await this.commit(key, prev, next);
        return next;
    }
}

/** Every local descendant of `key` (children, their children, …). */
export async function getDescendants(libraryID: number, key: string): Promise<AnyIDBZoteroItem[]> {
    const out: AnyIDBZoteroItem[] = [];
    const seen = new Set([key]);
    let frontier = [key];
    while (frontier.length > 0) {
        // One query per level (a prefix of the compound parent index).
        const children = await db.items
            .where("[libraryID+parentItem]")
            .anyOf(frontier.map((k): [number, string] => [libraryID, k]))
            .toArray();
        const next: string[] = [];
        for (const c of children) {
            if (seen.has(c.key)) continue;
            seen.add(c.key);
            out.push(c);
            next.push(c.key);
        }
        frontier = next;
    }
    return out;
}

/**
 * The subtree fingerprint of a top-level item (see `treeFingerprint`), or
 * undefined for a child or a missing item. Computed when a source note is
 * checked or rendered, never stored: nothing on the write paths keeps it.
 */
export async function itemTreeFingerprint(libraryID: number, key: string): Promise<string | undefined> {
    const top = await db.items.get([libraryID, key]);
    if (!top || top.parentItem) return undefined;
    return treeFingerprint([top, ...(await getDescendants(libraryID, key))]);
}

/* ------------------------------------------------------------------ */
/*  Groups, queue, library flags                                      */
/* ------------------------------------------------------------------ */

export async function putGroup(group: IDBSyncGroup): Promise<void> {
    if (group.members.length === 0) await db.syncGroups.delete([group.libraryID, group.id]);
    else await db.syncGroups.put(structuredClone(group));
}

export async function deleteGroup(libraryID: number, id: string): Promise<void> {
    await db.syncGroups.delete([libraryID, id]);
}

export async function putQueueEntry(entry: IDBSyncQueueEntry): Promise<void> {
    await db.syncQueue.put({ ...entry });
}

export async function deleteQueueEntry(libraryID: number, key: string): Promise<void> {
    await db.syncQueue.delete([libraryID, key]);
}

export async function setNeedsFullSync(libraryID: number, value: boolean): Promise<void> {
    await db.libraries.update(libraryID, { needsFullSync: value });
}
