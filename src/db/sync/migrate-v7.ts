/**
 * The v6 → v7 migration, as a pure plan over the stored item rows.
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
 * descendant: the one place membership is inferred from the parent/child
 * structure, and it happens once.
 */
import { reconcile2 } from "db/sync/reconcile";
import { allTreeFingerprints, deriveSyncStatus } from "db/sync/model";

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

export interface V7Plan {
    /** Rows to write back (every row that survives, rewritten). */
    rows: AnyIDBZoteroItem[];
    /** Keys (`[libraryID, key]`) of rows to remove. */
    removed: [number, string][];
    deleteLog: IDBSyncDeleteLog[];
    conflicts: IDBSyncConflict[];
    groups: IDBSyncGroup[];
}

function descendants(byParent: Map<string, V6Row[]>, key: string): V6Row[] {
    const out: V6Row[] = [];
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

export function planV7Migration(v6: V6Row[], now: string): V7Plan {
    const plan: V7Plan = { rows: [], removed: [], deleteLog: [], conflicts: [], groups: [] };
    const libraries = new Map<number, V6Row[]>();
    for (const r of v6) {
        const list = libraries.get(r.libraryID) ?? [];
        list.push(r);
        libraries.set(r.libraryID, list);
    }

    for (const [libraryID, rows] of libraries) {
        const byParent = new Map<string, V6Row[]>();
        for (const r of rows) {
            if (!r.parentItem) continue;
            const list = byParent.get(r.parentItem) ?? [];
            list.push(r);
            byParent.set(r.parentItem, list);
        }

        const conflicts = new Map<string, IDBSyncConflict>();
        const kept: AnyIDBZoteroItem[] = [];

        for (const r of rows) {
            const { syncError, serverCopyRaw, syncStatus, ...rest } = r;
            const row = { ...rest, synced: 1, localRevision: r.localRevision ?? 0 } as AnyIDBZoteroItem;
            const base = { libraryID, key: r.key, fields: [], createdAt: now };

            switch (syncStatus) {
                case "created":
                    row.synced = 0;
                    row.version = 0;
                    break;
                case "updated":
                    row.synced = 0;
                    break;
                case "ignore":
                    row.localOnly = true;
                    break;
                case "deleted":
                    plan.removed.push([libraryID, r.key]);
                    plan.deleteLog.push({
                        libraryID,
                        key: r.key,
                        itemType: r.itemType,
                        parentItem: r.parentItem,
                        version: r.version,
                        dateDeleted: now,
                        snapshot: { ...row, synced: 1 },
                    });
                    continue;
                case "conflict": {
                    row.synced = 0;
                    if (serverCopyRaw?.data) {
                        const local = r.raw.data as unknown as ItemDataJSON;
                        conflicts.set(r.key, {
                            ...base,
                            kind: "changed",
                            remote: serverCopyRaw.data,
                            remoteVersion: serverCopyRaw.version,
                            fields: reconcile2(local, serverCopyRaw.data).conflicts.map(([c]) => c.field),
                        });
                    } else if (syncError?.startsWith("Remote deletion blocked")) {
                        const members = [r.key, ...descendants(byParent, r.key).map((d) => d.key)];
                        plan.groups.push({ libraryID, id: r.key, root: r.key, members });
                        for (const m of members) {
                            conflicts.set(m, { ...base, key: m, kind: "remote-deleted", remoteVersion: 0, group: r.key });
                        }
                    } else if (syncError && /^\d{3}:/.test(syncError)) {
                        conflicts.set(r.key, { ...base, kind: "refused", remoteVersion: 0, error: syncError });
                    }
                    break;
                }
                default:
                    break;
            }
            kept.push(row);
        }

        // Group members found through a root may come later in the list;
        // a member that v6 had as clean keeps `synced = 1` (it is held only
        // to be restored with its descendants).
        const fingerprints = allTreeFingerprints(kept);
        for (const row of kept) {
            const conflict = conflicts.get(row.key);
            row.syncStatus = deriveSyncStatus(row, conflict);
            const fp = fingerprints.get(row.key);
            if (fp !== undefined) row.treeFingerprint = fp;
            plan.rows.push(row);
        }
        plan.conflicts.push(...conflicts.values());
    }
    return plan;
}
