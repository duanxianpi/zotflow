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
 * | `deleted`       | row removed, delete log written (snapshot = the row) |
 * | `conflict`      | by its evidence: a server copy → `changed`; "Remote deletion blocked" → `remote-deleted`; `NNN:` → `refused`; anything else → plain unsynced |
 * | `ignore`        | `localOnly`                                          |
 *
 * A blocked remote deletion becomes a group of its root and every
 * descendant not itself pending deletion: the one place membership is
 * inferred from the parent/child structure, and it happens once.
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
export type V6Index = Pick<V6Row, "libraryID" | "key" | "parentItem" | "syncStatus" | "syncError">;

/**
 * Whether the plan needs the whole row: a pending delete keeps it as its
 * snapshot, and a conflict compares its data with the server copy.
 */
export function needsWholeRow(row: V6Index): boolean {
    return row.syncStatus === "deleted" || row.syncStatus === "conflict";
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
        const byParent = new Map<string, V6Index[]>();
        for (const r of rows) {
            // A row pending deletion leaves with its delete log; it is no
            // one's member.
            if (!r.parentItem || r.syncStatus === "deleted") continue;
            const list = byParent.get(r.parentItem) ?? [];
            list.push(r);
            byParent.set(r.parentItem, list);
        }

        const conflicts = new Map<string, IDBSyncConflict>();
        for (const r of rows) {
            const base = { libraryID, key: r.key, fields: [], createdAt: now };
            const full = wholeOf.get(`${libraryID}/${r.key}`);

            if (r.syncStatus === "deleted" && full) {
                plan.removed.push([libraryID, r.key]);
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
                continue;
            }
            if (r.syncStatus !== "conflict") continue;

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
            } else if (r.syncError?.startsWith("Remote deletion blocked")) {
                const members = [r.key, ...descendants(byParent, r.key).map((d) => d.key)];
                plan.groups.push({ libraryID, id: r.key, root: r.key, members });
                for (const m of members) {
                    conflicts.set(m, { ...base, key: m, kind: "remote-deleted", remoteVersion: 0, group: r.key });
                }
            } else if (r.syncError && /^\d{3}:/.test(r.syncError)) {
                conflicts.set(r.key, { ...base, kind: "refused", remoteVersion: 0, error: r.syncError });
            }
        }
        plan.conflicts.push(...conflicts.values());
    }
    return plan;
}
