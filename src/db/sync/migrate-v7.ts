/**
 * The v6 → v7 migration: a pure plan made from a light index of the item
 * rows (plus the few rows it needs whole), then a pure rewrite of each row.
 * The upgrade streams the table through both, so a large library is never
 * held in memory at once.
 *
 * v6 kept every piece of sync state in one `syncStatus` column (plus
 * `serverCopyRaw` and a free-text `syncError`); v7 records each fact in its
 * own place (`synced`, the delete log, the conflict table). This maps one to
 * the other:
 *
 * | v6 `syncStatus` | v7                                                   |
 * | --------------- | ---------------------------------------------------- |
 * | `synced`        | `synced = 1`                                         |
 * | `created`       | `synced = 0`, `version = 0`                          |
 * | `updated`       | `synced = 0`, no merge base (the merge falls back to `reconcile2`) |
 * | `deleted`       | row removed, delete log written (snapshot = the row); also an annotation whose data still holds the boolean `deleted: true` 1.6.6 wrote, under any status (`isLocalDelete`), with a `local-deleted` conflict if v6 held a server copy |
 * | `conflict`      | by its evidence: a server copy → `changed`; "Remote deletion blocked" → `remote-deleted`; `NNN:` → `refused`; anything else → plain unsynced |
 * | `ignore`        | `localOnly`                                          |
 *
 * A blocked remote deletion becomes a group of its topmost marked row and
 * every descendant not itself pending deletion: the one place membership is
 * inferred from the parent/child structure, and it happens once. A group
 * whose only local changes were deletes is no conflict: its rows are
 * removed, as the remote deletion would have.
 */
import { reconcile2 } from "db/sync/reconcile";
import { deriveSyncStatus } from "db/sync/model";

import type {
    AnyIDBZoteroItem,
    IDBSyncConflict,
    IDBSyncDeleteLog,
    IDBSyncGroup,
    ItemDataJSON,
} from "types/db-schema";

/** A row as v6 stored it: the v7 row plus the fields v7 dropped. */
export type V6Row = Omit<AnyIDBZoteroItem, "synced" | "syncStatus"> & {
    syncStatus: string;
    synced?: 0 | 1;
    syncError?: string;
    serverCopyRaw?: { version: number; data: ItemDataJSON };
};

/** What the plan needs of every v6 row (the rest is read only for the few rows below). */
export type V6Index = Pick<V6Row, "libraryID" | "key" | "parentItem" | "syncStatus" | "syncError"> & {
    /** Deleted on this device and not yet deleted on the server (see `isLocalDelete`). */
    localDelete: boolean;
};

const REMOTE_DELETION_BLOCKED = "Remote deletion blocked";

const isBlockedV6 = (row: Pick<V6Row, "syncStatus" | "syncError">): boolean =>
    row.syncStatus === "conflict" && !!row.syncError?.startsWith(REMOTE_DELETION_BLOCKED);

/**
 * Whether v6 held this row as a delete still to be sent.
 *
 * v6 deleted an annotation by marking it: `syncStatus: "deleted"` and the
 * boolean `deleted: true` in its data (`deleteAnnotations`, the only place
 * 1.3.0–1.6.6 write `true` on an annotation; notes write it to go to the
 * trash). A conflict, a 412 on the DELETE, or Keep Local (which uploaded
 * the row as an edit) then replaced the status, leaving only that value.
 *
 * The value tells the two kinds of flagged annotation apart: the server
 * always answers the number `1` (an annotation in Zotero's trash, which
 * the API accepts), v6 stored server JSON as it came and replaced a row
 * with the server's echo after an upload, and IndexedDB keeps booleans and
 * numbers distinct. So `true` is a delete made here, whatever the status;
 * `1` is the server's trash, kept as it is.
 */
export function isLocalDelete(row: Pick<V6Row, "syncStatus" | "itemType" | "raw">): boolean {
    if (row.syncStatus === "deleted") return true;
    return row.itemType === "annotation" && (row.raw?.data as { deleted?: unknown } | undefined)?.deleted === true;
}

/** The index entry of a v6 row. */
export function toV6Index(row: V6Row): V6Index {
    return {
        libraryID: row.libraryID,
        key: row.key,
        parentItem: row.parentItem,
        syncStatus: row.syncStatus,
        syncError: row.syncError,
        localDelete: isLocalDelete(row),
    };
}

/**
 * Whether the plan needs the whole row: a pending delete keeps it as its
 * snapshot, and a conflict compares its data with the server copy.
 */
export function needsWholeRow(row: V6Index): boolean {
    return row.localDelete || row.syncStatus === "conflict";
}

export interface V7Plan {
    /** Keys (`[libraryID, key]`) of rows to remove. */
    removed: [number, string][];
    deleteLog: IDBSyncDeleteLog[];
    conflicts: IDBSyncConflict[];
    groups: IDBSyncGroup[];
}

function descendants(byParent: Map<string, V6Index[]>, key: string): V6Index[] {
    const out: V6Index[] = [];
    const seen = new Set([key]);
    const stack = [...(byParent.get(key) ?? [])];
    while (stack.length > 0) {
        const r = stack.pop()!;
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        out.push(r);
        stack.push(...(byParent.get(r.key) ?? []));
    }
    return out;
}

/**
 * Rewrites one row as v7 stores it, in place (it runs inside Dexie's
 * `modify`, row by row). `conflict` is the row's planned conflict, if any.
 */
export function migrateRowV7(row: V6Row, conflict: IDBSyncConflict | undefined): AnyIDBZoteroItem {
    const out = row as unknown as AnyIDBZoteroItem & { syncError?: unknown; serverCopyRaw?: unknown };
    const status = row.syncStatus;
    delete out.syncError;
    delete out.serverCopyRaw;
    out.synced = 1;
    out.localRevision = row.localRevision ?? 0;
    switch (status) {
        case "created":
            out.synced = 0;
            out.version = 0;
            break;
        case "updated":
        case "conflict":
            out.synced = 0;
            break;
        case "ignore":
            out.localOnly = true;
            break;
        default:
            break;
    }
    // A group member that v6 had as clean keeps `synced = 1` (it is held
    // only to be restored with its descendants).
    out.syncStatus = deriveSyncStatus(out, conflict);
    return out;
}

/**
 * Plans the migration from a light index of every row plus the whole rows
 * `needsWholeRow` asks for, so the migration never holds the whole table.
 */
export function planV7Migration(index: V6Index[], whole: V6Row[], now: string): V7Plan {
    const plan: V7Plan = { removed: [], deleteLog: [], conflicts: [], groups: [] };
    const wholeOf = new Map(whole.map((r) => [`${r.libraryID}/${r.key}`, r]));
    const libraries = new Map<number, V6Index[]>();
    for (const r of index) {
        const list = libraries.get(r.libraryID) ?? [];
        list.push(r);
        libraries.set(r.libraryID, list);
    }

    for (const [libraryID, rows] of libraries) {
        const byKey = new Map(rows.map((r) => [r.key, r]));
        const byParent = new Map<string, V6Index[]>();
        for (const r of rows) {
            // A row pending deletion leaves with its delete log; it is no
            // one's member.
            if (!r.parentItem || r.localDelete) continue;
            const list = byParent.get(r.parentItem) ?? [];
            list.push(r);
            byParent.set(r.parentItem, list);
        }

        // v6 marked every deleted key whose subtree held local changes, so
        // one remote deletion (a parent, its attachment, its annotations)
        // left a mark on each of them. They are one group: the topmost
        // marked ancestor's.
        const blocked = new Set(rows.filter((r) => !r.localDelete && isBlockedV6(r)).map((r) => r.key));
        const groupRoot = (key: string): string => {
            let root = key;
            const seen = new Set([key]);
            for (let p = byKey.get(key)?.parentItem; p && !seen.has(p); p = byKey.get(p)?.parentItem) {
                seen.add(p);
                if (blocked.has(p)) root = p;
            }
            return root;
        };

        // Whether a group holds a change made here. v6's mark replaced a
        // row's own status, so a marked row counts as changed itself
        // unless something under it explains the mark: a change, a
        // local delete, or another mark. A local delete is no change to
        // keep: the server deleted that row as well.
        const allChildren = new Map<string, V6Index[]>();
        for (const r of rows) {
            if (!r.parentItem) continue;
            const list = allChildren.get(r.parentItem) ?? [];
            list.push(r);
            allChildren.set(r.parentItem, list);
        }
        const ownChange = (r: V6Index) =>
            !r.localDelete && !blocked.has(r.key) && r.syncStatus !== "synced" && r.syncStatus !== "ignore";
        const explainedBelow = (key: string) =>
            descendants(allChildren, key).some((d) => d.localDelete || blocked.has(d.key) || ownChange(d));
        const holdsChange = (members: string[]) =>
            members.some((k) => {
                const r = byKey.get(k);
                return !!r && (ownChange(r) || (blocked.has(k) && !explainedBelow(k)));
            });

        const conflicts = new Map<string, IDBSyncConflict>();
        for (const root of new Set([...blocked].map(groupRoot))) {
            const members = [root, ...descendants(byParent, root).map((d) => d.key)];
            if (!holdsChange(members)) {
                // Only local deletes under it (each handled below): the
                // remote deletion applies, nothing to ask about.
                for (const m of members) plan.removed.push([libraryID, m]);
                continue;
            }
            plan.groups.push({ libraryID, id: root, root, members });
            for (const m of members) {
                conflicts.set(m, { libraryID, key: m, fields: [], createdAt: now, kind: "remote-deleted", remoteVersion: 0, group: root });
            }
        }

        for (const r of rows) {
            const base = { libraryID, key: r.key, fields: [], createdAt: now };
            const full = wholeOf.get(`${libraryID}/${r.key}`);

            if (r.localDelete && full) {
                plan.removed.push([libraryID, r.key]);
                // Deleted on the server too: nothing left to send.
                if (isBlockedV6(r)) continue;
                const snapshot = migrateRowV7(structuredClone(full), undefined);
                snapshot.synced = 1;
                plan.deleteLog.push({
                    libraryID,
                    key: r.key,
                    itemType: full.itemType,
                    parentItem: full.parentItem,
                    version: full.version,
                    dateDeleted: now,
                    snapshot,
                });
                // Changed on the server since: deleted here, changed there.
                const remote = full.serverCopyRaw;
                if (r.syncStatus === "conflict" && remote?.data) {
                    conflicts.set(r.key, { ...base, kind: "local-deleted", remote: remote.data, remoteVersion: remote.version });
                }
                continue;
            }
            if (r.syncStatus !== "conflict" || blocked.has(r.key)) continue;

            const serverCopyRaw = full?.serverCopyRaw;
            if (serverCopyRaw?.data && full) {
                const local = full.raw.data as unknown as ItemDataJSON;
                conflicts.set(r.key, {
                    ...base,
                    kind: "changed",
                    remote: serverCopyRaw.data,
                    remoteVersion: serverCopyRaw.version,
                    fields: reconcile2(local, serverCopyRaw.data).conflicts.map(([c]) => c.field),
                });
            } else if (r.syncError && /^\d{3}:/.test(r.syncError)) {
                conflicts.set(r.key, { ...base, kind: "refused", remoteVersion: 0, error: r.syncError });
            }
        }
        plan.conflicts.push(...conflicts.values());
    }
    return plan;
}
