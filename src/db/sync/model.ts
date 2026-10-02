/**
 * The sync model's types and the pure rules derived from them.
 *
 * Everything sync knows about one object is a `KeyState`: its row, the
 * merge base (`cache`), a pending delete (`deleteLog`), a write in flight
 * (`journal`) and a conflict. Decisions (`decide.ts`) map a state and an
 * event to the next state; `commit.ts` writes it. Nothing here touches the
 * database, so the migration and the tests can use it too.
 */
import type {
    AnyIDBZoteroItem,
    IDBSyncCache,
    IDBSyncConflict,
    IDBSyncDeleteLog,
    IDBUploadJournal,
    ItemSyncStatus,
} from "types/db-schema";

/** Everything sync records about one object. */
export interface KeyState {
    row?: AnyIDBZoteroItem;
    cache?: IDBSyncCache;
    deleteLog?: IDBSyncDeleteLog;
    journal?: IDBUploadJournal;
    conflict?: IDBSyncConflict;
}

/**
 * The derived `syncStatus` column: what the tree view shows and what the
 * `[libraryID+syncStatus]` index finds.
 */
export function deriveSyncStatus(
    row: Pick<AnyIDBZoteroItem, "synced" | "version" | "localOnly">,
    conflict: IDBSyncConflict | undefined,
): ItemSyncStatus {
    if (row.localOnly) return "ignore";
    if (conflict) return "conflict";
    if (row.synced === 1) return "synced";
    return row.version === 0 ? "created" : "updated";
}

/** Device-local row fields that a row rebuilt from server JSON keeps. */
export const LOCAL_FIELDS = [
    "lastAccessedAt",
    "primaryViewState",
    "secondaryViewState",
    "annotationImageVersion",
    "externalAnnotationExtractionFileMD5",
    "localRevision",
    "treeFingerprint",
] as const;

/** Copies the device-local fields of `from` onto `to` (a fresh object). */
export function withLocalFields<T extends AnyIDBZoteroItem>(to: T, from: AnyIDBZoteroItem | undefined): T {
    if (!from) return to;
    const out = { ...to } as Record<string, unknown>;
    for (const field of LOCAL_FIELDS) {
        if (from[field] !== undefined) out[field] = from[field];
    }
    return out as T;
}

/* ------------------------------------------------------------------ */
/*  Subtree fingerprint                                               */
/* ------------------------------------------------------------------ */

/** FNV-1a, 32 bit, as 8 hex digits. */
function fnv1a(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

/** The rows a fingerprint counts: server versions only. */
function counts(row: Pick<AnyIDBZoteroItem, "version" | "localOnly">): boolean {
    return !row.localOnly && row.version > 0;
}

/**
 * The fingerprint of a top-level item's subtree: a hash of the sorted
 * `(key, version)` pairs of the item and every descendant it has on the
 * server. Server versions only, so it is the same on every device after a
 * sync; changes not yet uploaded do not count (they force their own update).
 */
export function treeFingerprint(rows: Pick<AnyIDBZoteroItem, "key" | "version" | "localOnly">[]): string {
    const parts = rows
        .filter(counts)
        .map((r) => `${r.key}:${r.version}`)
        .sort();
    return fnv1a(parts.join(";"));
}

/**
 * Fingerprints for every top-level item among `rows` (one library), keyed by
 * item key. Used by the migration and by tests as the reference the
 * incrementally maintained column must match.
 */
export function allTreeFingerprints(
    rows: Pick<AnyIDBZoteroItem, "key" | "version" | "localOnly" | "parentItem">[],
): Map<string, string> {
    const children = new Map<string, typeof rows>();
    for (const r of rows) {
        if (!r.parentItem) continue;
        const list = children.get(r.parentItem) ?? [];
        list.push(r);
        children.set(r.parentItem, list);
    }
    const out = new Map<string, string>();
    for (const top of rows) {
        if (top.parentItem) continue;
        const subtree: typeof rows = [];
        const seen = new Set<string>();
        const stack = [top];
        while (stack.length > 0) {
            const r = stack.pop()!;
            if (seen.has(r.key)) continue;
            seen.add(r.key);
            subtree.push(r);
            stack.push(...(children.get(r.key) ?? []));
        }
        out.set(top.key, treeFingerprint(subtree));
    }
    return out;
}
