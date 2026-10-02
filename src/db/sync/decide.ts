/**
 * Every sync decision, as a pure function of an object's recorded state and
 * an event: a remote object or deletion arriving, a write's result, a
 * complete download proving an in-flight write never landed, a local edit or
 * delete, and the user's resolutions.
 *
 * Rules (docs/sync-architecture.md §9):
 * - a user's change ends in one of two ways: it reaches the server, or the
 *   user gives it up in a conflict;
 * - only the user ends a conflict (unless both sides came to hold the same
 *   thing);
 * - decisions use recorded facts only, never the current tree shape;
 * - nothing here modifies its input; unchanged parts of a state are passed
 *   through by reference (so `commit.ts` can skip them) and changed parts
 *   are new objects.
 */
import { normalizeItem, toZoteroDate } from "db/normalize";
import { withLocalFields } from "db/sync/model";
import { applyChanges, patch, reconcile2, reconcile3, sameContent } from "db/sync/reconcile";

import type { KeyState } from "db/sync/model";
import type {
    AnyIDBZoteroItem,
    IDBSyncConflict,
    IDBSyncDeleteLog,
    ItemDataJSON,
} from "types/db-schema";
import type { AnyZoteroItem } from "types/zotero";

/** Fields that exist only in ZotFlow and are never sent. */
const LOCAL_ONLY_DATA_FIELDS = ["annotationIsExternal"];

function dataOf(row: AnyIDBZoteroItem): ItemDataJSON {
    return row.raw.data as unknown as ItemDataJSON;
}

/** A clean row built from server JSON, keeping the device-local fields. */
export function fromServer(remote: AnyZoteroItem, libraryID: number, prev?: AnyIDBZoteroItem): AnyIDBZoteroItem {
    const row = withLocalFields(normalizeItem(structuredClone(remote), libraryID), prev);
    row.synced = 1;
    delete row.localOnly;
    if (prev?.csljson && !row.csljson) row.csljson = prev.csljson;
    return row;
}

/** `row` with its data replaced, keeping the envelope and local fields. */
function withData(row: AnyIDBZoteroItem, data: ItemDataJSON, version: number, synced: 0 | 1): AnyIDBZoteroItem {
    return {
        ...row,
        version,
        synced,
        raw: { ...row.raw, version, data: structuredClone(data) },
    } as unknown as AnyIDBZoteroItem;
}

function conflictFields(conflicts: ReturnType<typeof reconcile3>["conflicts"]): string[] {
    return [...new Set(conflicts.map(([c]) => c.field))];
}

/** The fields that differ between two versions, for a conflict listing. */
export function differingFields(local: ItemDataJSON, remote: ItemDataJSON, base?: ItemDataJSON): string[] {
    const r = base ? reconcile3(base, local, remote) : reconcile2(local, remote);
    return conflictFields(r.conflicts);
}

/* ------------------------------------------------------------------ */
/*  Download                                                          */
/* ------------------------------------------------------------------ */

export type RemoteOutcome =
    /** A version this device already has; nothing changed. */
    | "ignored"
    /** A new object stored. */
    | "inserted"
    /** A clean row replaced by the server copy. */
    | "replaced"
    /** Remote changes merged into an unsynced row (or the two agreed). */
    | "merged"
    /** A conflict recorded or refreshed. */
    | "conflict"
    /** Our own earlier write, recognised; a pending delete stays pending. */
    | "own-write"
    /** The parent is not here yet: retry later. */
    | "queue";

export interface RemoteResult {
    next: KeyState;
    outcome: RemoteOutcome;
    /** The remote-deletion group this key left, if any. */
    leftGroup?: string;
}

export interface RemoteContext {
    libraryID: number;
    /** Whether the object's parent (if it has one) exists locally. */
    parentExists: boolean;
    now: string;
}

/** Processes one object from a download (§4.3). */
export function onRemoteObject(state: KeyState, remote: AnyZoteroItem, ctx: RemoteContext): RemoteResult {
    const { row, cache, deleteLog, journal, conflict } = state;
    const data = remote.data as unknown as ItemDataJSON;
    const ignored: RemoteResult = { next: state, outcome: "ignored" };

    // 1. A version already known. A refused push leaves the library cursor
    //    behind, so the same change is pulled again.
    if (conflict) {
        if (remote.version <= conflict.remoteVersion) return ignored;
    } else if (row) {
        if (remote.version <= row.version) return ignored;
    } else if (deleteLog && remote.version <= deleteLog.version) {
        return ignored;
    }

    // The object came back, so the question a journal asks — did the write
    // land? — is answered by its content either way.
    const ownWrite = !!journal && sameContent(data, journal.sent);
    const next: KeyState = { ...state, journal: undefined };

    // 2. Deleted here.
    if (!row && deleteLog) {
        if (ownWrite) {
            // Our create (or edit) landed before the user deleted it: the
            // delete is still to be sent, now against this version.
            next.deleteLog = { ...deleteLog, version: remote.version };
            return { next, outcome: "own-write" };
        }
        next.conflict = {
            libraryID: ctx.libraryID,
            key: remote.key,
            kind: "local-deleted",
            remote: structuredClone(data),
            remoteVersion: remote.version,
            fields: [],
            createdAt: conflict?.createdAt ?? ctx.now,
        };
        return { next, outcome: "conflict" };
    }

    // 3. New here.
    if (!row) {
        if (!ctx.parentExists) return { next: state, outcome: "queue" };
        return {
            next: { row: fromServer(remote, ctx.libraryID) },
            outcome: "inserted",
        };
    }

    // 4. Clean here: the server copy wins.
    if (!conflict && (row.synced === 1 || row.localOnly)) {
        next.row = fromServer(remote, ctx.libraryID, row);
        next.cache = undefined;
        return { next, outcome: "replaced" };
    }

    const local = dataOf(row);

    // In conflict already: refresh it with the newer remote version.
    if (conflict) {
        const leftGroup = conflict.group;
        if (conflict.kind === "remote-deleted" && row.synced === 1) {
            // Held only to be restored with its descendants; the server has
            // it again, so there is nothing of ours to keep.
            next.row = fromServer(remote, ctx.libraryID, row);
            next.cache = undefined;
            next.conflict = undefined;
            return { next, outcome: "replaced", leftGroup };
        }
        if (sameContent(local, data)) {
            next.row = fromServer(remote, ctx.libraryID, row);
            next.cache = undefined;
            next.conflict = undefined;
            return { next, outcome: "merged", leftGroup };
        }
        next.conflict = {
            ...conflict,
            kind: conflict.kind === "refused" ? "refused" : "changed",
            remote: structuredClone(data),
            remoteVersion: remote.version,
            // A field stays listed until the user resolves the conflict.
            fields: [
                ...new Set([
                    ...conflict.fields,
                    // A re-created object shares no base with the local
                    // copy; neither does a row not yet on the server.
                    ...differingFields(
                        local,
                        data,
                        row.version === 0 || conflict.kind === "remote-deleted" ? undefined : cache?.data,
                    ),
                ]),
            ],
            group: undefined,
        };
        return { next, outcome: "conflict", leftGroup };
    }

    // 5./6. Unsynced here: merge against the base the local changes started
    //       from. Our own write landing makes the server copy that base.
    // A row not yet created on the server (a Keep Local re-creation meeting
    // the key again) has no common base with what is there now: every
    // differing field is the user's to choose.
    let base = row.version === 0 ? undefined : cache?.data;
    if (ownWrite) {
        base = data;
        next.cache = { libraryID: ctx.libraryID, key: remote.key, version: remote.version, data: structuredClone(data) };
    }
    const r = base ? reconcile3(base, local, data) : reconcile2(local, data);

    // A write of unknown outcome that the server copy does not match: had it
    // landed, the base would be what was sent, and a field changed since on
    // both sides would be a conflict the pre-send base cannot show. Fields
    // that conflict under either base are conflicts.
    if (journal && !ownWrite) {
        const fromSent = reconcile3(journal.sent, local, data);
        const listed = new Set(r.conflicts.map(([c]) => c.field));
        for (const pair of fromSent.conflicts) {
            if (!listed.has(pair[0].field)) r.conflicts.push(pair);
        }
    }

    if (r.conflicts.length > 0) {
        next.conflict = {
            libraryID: ctx.libraryID,
            key: remote.key,
            kind: "changed",
            remote: structuredClone(data),
            remoteVersion: remote.version,
            fields: conflictFields(r.conflicts),
            createdAt: ctx.now,
        };
        return { next, outcome: "conflict" };
    }

    const merged = applyChanges(local, r.changes);
    if (sameContent(merged, data)) {
        next.row = fromServer(remote, ctx.libraryID, row);
        next.cache = undefined;
        return { next, outcome: ownWrite ? "own-write" : "merged" };
    }
    // Local changes remain: keep them on top of the server copy, which
    // becomes the base the next patch is computed against.
    next.row = withData(row, merged, remote.version, 0);
    if (remote.csljson) next.row.csljson = remote.csljson;
    next.cache = { libraryID: ctx.libraryID, key: remote.key, version: remote.version, data: structuredClone(data) };
    return { next, outcome: ownWrite ? "own-write" : "merged" };
}

/**
 * Whether a deleted row is ours to ignore: a local create reusing the key
 * (Keep Local after a remote deletion) that has not been sent.
 */
export function isLocalRecreation(state: KeyState): boolean {
    // In conflict, the server's object under this key has been seen: its
    // deletion is news.
    return !!state.row && state.row.version === 0 && !state.journal && !state.conflict;
}

/** Whether a row holds something of the user's that a remote deletion must not drop. */
export function hasPendingChanges(state: KeyState): boolean {
    const { row, conflict } = state;
    if (!row || row.localOnly) return false;
    return row.synced === 0 || !!conflict;
}

/** A member of a remote-deletion group (§5.4). */
export function joinGroup(state: KeyState, libraryID: number, key: string, group: string, now: string): KeyState {
    return {
        ...state,
        journal: undefined,
        conflict: {
            libraryID,
            key,
            kind: "remote-deleted",
            remoteVersion: 0,
            fields: [],
            group,
            createdAt: state.conflict?.createdAt ?? now,
        },
    };
}

/** The result of settling a journal a complete download did not return (§4.5). */
export function settleJournal(state: KeyState): KeyState {
    const next: KeyState = { ...state, journal: undefined };
    const { row, deleteLog } = state;
    // A create that never landed and was trashed or deleted since: there is
    // nothing left to send.
    if (row && row.version === 0 && dataOf(row).deleted && !state.conflict) {
        next.row = undefined;
        next.cache = undefined;
    }
    if (!row && deleteLog && deleteLog.version === 0 && !state.conflict) next.deleteLog = undefined;
    return next;
}

/* ------------------------------------------------------------------ */
/*  Upload                                                            */
/* ------------------------------------------------------------------ */

/** The flat JSON object sent for one item. */
export type WriteObject = ItemDataJSON & { key: string; version: number };

/**
 * Builds what to send for an unsynced row and records it in the journal
 * (§4.6). A create carries `version: 0` so that a key the server already has
 * is refused (412) instead of silently merged into that item; a row with a
 * merge base sends only the fields that differ from it.
 */
export function beforeSend(state: KeyState, key: string, now: string): { next: KeyState; payload: WriteObject } {
    const row = state.row!;
    const data = dataOf(row);
    let body: ItemDataJSON;
    if (row.version === 0) body = structuredClone(data);
    else if (state.cache) body = patch(state.cache.data, data);
    else body = structuredClone(data);
    for (const f of LOCAL_ONLY_DATA_FIELDS) delete body[f];
    // The API takes `YYYY-MM-DDTHH:MM:SSZ` only; rows written before every
    // path stamped that format may hold milliseconds.
    for (const f of ["dateAdded", "dateModified"]) {
        const v = body[f];
        if (typeof v === "string" && v) {
            try {
                body[f] = toZoteroDate(v);
            } catch {
                delete body[f];
            }
        }
    }
    const payload: WriteObject = { ...body, key, version: row.version };

    return {
        payload,
        next: {
            ...state,
            journal: {
                libraryID: row.libraryID,
                key,
                sent: structuredClone(data),
                baseVersion: row.version,
                revision: row.localRevision ?? 0,
                sentAt: now,
            },
        },
    };
}

export type WriteResult =
    | { type: "success"; echo: AnyZoteroItem }
    | { type: "unchanged" }
    | { type: "failed"; code: number; message: string };

/** What the sync loop must do after a write's result. */
export type FollowUp = "none" | "full-sync" | "missing-parent" | "refused" | "retry-later";

/** Applies one object's write result (§4.6). `sent` is the state as it was sent. */
export function afterWrite(
    state: KeyState,
    sent: { revision: number; data: ItemDataJSON },
    result: WriteResult,
    libraryID: number,
    now: string,
): { next: KeyState; followUp: FollowUp } {
    const next: KeyState = { ...state, journal: undefined };
    const { row } = state;

    if (result.type === "failed") {
        const { code, message } = result;
        if (code === 404 || code === 412) return { next, followUp: "full-sync" };
        if ((code === 400 || code === 409) && /parent|collection/i.test(message)) {
            return { next, followUp: "missing-parent" };
        }
        if (code >= 400 && code < 500 && row) {
            next.conflict = {
                libraryID,
                key: row.key,
                kind: "refused",
                remoteVersion: 0,
                fields: [],
                error: `${code}: ${message}`,
                createdAt: now,
            };
            return { next, followUp: "refused" };
        }
        return { next, followUp: "retry-later" };
    }

    if (!row) {
        // Deleted while the write was in flight: the delete is still to be
        // sent, against the version the write produced.
        if (state.deleteLog && result.type === "success") {
            next.deleteLog = { ...state.deleteLog, version: result.echo.version };
        }
        return { next, followUp: "none" };
    }

    const unchangedSince = (row.localRevision ?? 0) === sent.revision && !state.conflict;
    if (result.type === "unchanged") {
        if (row.synced === 1) return { next, followUp: "none" };
        if (unchangedSince) {
            next.row = { ...row, synced: 1 };
            next.cache = undefined;
        } else if (row.version > 0) {
            // The server holds what was sent; later edits go on top of it.
            next.cache = { libraryID, key: row.key, version: row.version, data: structuredClone(sent.data) };
        }
        return { next, followUp: "none" };
    }

    const { echo } = result;
    if (unchangedSince) {
        next.row = fromServer(echo, libraryID, row);
        next.cache = undefined;
    } else {
        // Edited (or trashed) while the write was in flight: keep the edit,
        // based on what the server now holds.
        next.row = { ...row, version: echo.version, synced: 0 };
        next.cache = { libraryID, key: row.key, version: echo.version, data: structuredClone(echo.data as unknown as ItemDataJSON) };
    }
    return { next, followUp: "none" };
}

/** A row whose upload failed because the server lacks its parent: recreate the parent. */
export function markForRecreation(state: KeyState): KeyState {
    if (!state.row) return state;
    return {
        ...state,
        cache: undefined,
        row: { ...state.row, version: 0, synced: 0 },
    };
}

/* ------------------------------------------------------------------ */
/*  Local writes                                                      */
/* ------------------------------------------------------------------ */

/**
 * A local edit (`edited` from `applyLocalEdit`) over the recorded state:
 * the first edit of a clean row keeps the server copy it started from as
 * the merge base.
 */
export function afterLocalEdit(state: KeyState, edited: AnyIDBZoteroItem): KeyState {
    const { row } = state;
    const next: KeyState = { ...state, row: edited };
    if (row && row.synced === 1 && !row.localOnly && row.version > 0 && !state.cache) {
        next.cache = { libraryID: row.libraryID, key: row.key, version: row.version, data: structuredClone(dataOf(row)) };
    }
    return next;
}

/**
 * A hard delete (annotations; Zotero's `DELETE`) over the recorded state.
 * The row goes at once; what the server still has to learn goes to the
 * delete log.
 */
export function afterLocalDelete(state: KeyState, now: string): { next: KeyState; leftGroup?: string } {
    const { row, journal, conflict } = state;
    if (!row) return { next: state };
    if (row.localOnly) return { next: {} };

    const leftGroup = conflict?.kind === "remote-deleted" ? conflict.group : undefined;
    // Never sent and nothing of the server's under this key: nothing to
    // delete there. (A refused write is answered by the delete.)
    // A merge base on a new row means the key existed on the server (a
    // Keep Local re-creation): the server may have it again, so log it.
    if (row.version === 0 && !journal && !state.cache && conflict?.kind !== "changed") {
        return { next: {}, leftGroup };
    }

    // The DELETE goes against the version this device knows. If the server
    // deleted it too, the DELETE is a no-op; if it has a newer version
    // (changed, or re-created after a deletion this device saw), the
    // download raises a conflict instead.
    const deleteLog: IDBSyncDeleteLog = {
        libraryID: row.libraryID,
        key: row.key,
        itemType: row.itemType,
        parentItem: row.parentItem,
        version: row.version || (state.cache?.version ?? 0),
        dateDeleted: now,
        snapshot: structuredClone(row),
    };
    // Still in conflict with a remote copy: now with the local side deleted.
    const nextConflict: IDBSyncConflict | undefined =
        conflict?.kind === "changed" && conflict.remote ? { ...conflict, kind: "local-deleted", fields: [] } : undefined;
    return { next: { deleteLog, journal, conflict: nextConflict }, leftGroup };
}

/* ------------------------------------------------------------------ */
/*  Resolution (§5.2)                                                 */
/* ------------------------------------------------------------------ */

/** Why a resolution is not available for a conflict, or nothing. */
export function acceptRemoteBlocked(state: KeyState): string | undefined {
    const c = state.conflict;
    if (c?.kind === "refused" && !c.remote && (state.row?.version ?? 0) > 0) {
        return "The server's copy could not be fetched; retry the sync first.";
    }
    return undefined;
}

/**
 * Local data with the remote changes that did not conflict applied. The
 * fields the conflict listed keep their local value even if a later local
 * edit set one back to the base value (the user saw local vs remote there).
 */
function keptLocal(local: ItemDataJSON, remote: ItemDataJSON, base: ItemDataJSON | undefined, listed: string[]): ItemDataJSON {
    const r = base ? reconcile3(base, local, remote) : reconcile2(local, remote);
    const own = new Set([...listed, ...r.conflicts.map(([c]) => c.field)]);
    return applyChanges(local, r.changes.filter((c) => !own.has(c.field)));
}

/**
 * Keep the local side. `merged`, when given, is the data to keep (a
 * per-field choice); by default the local data as it is.
 */
export function keepLocal(state: KeyState, merged?: ItemDataJSON): KeyState {
    const { row, conflict } = state;
    if (!conflict) return state;
    const next: KeyState = { ...state, conflict: undefined };

    switch (conflict.kind) {
        case "changed": {
            const remote = conflict.remote;
            if (!row || !remote) return next;
            // By default: the local side of every conflicting field, plus
            // the remote changes that did not conflict.
            const data = merged ?? keptLocal(dataOf(row), remote, row.version === 0 ? undefined : state.cache?.data, conflict.fields);
            if (sameContent(data, remote)) {
                next.row = withData(row, remote, conflict.remoteVersion, 1);
                next.cache = undefined;
                return next;
            }
            // Uploaded as a patch against the remote copy: only the fields
            // where the kept data differs from it are sent, so remote
            // changes nobody chose against survive.
            next.row = {
                ...withData(row, data, conflict.remoteVersion, 0),
                localRevision: (row.localRevision ?? 0) + 1,
            };
            next.cache = {
                libraryID: conflict.libraryID,
                key: conflict.key,
                version: conflict.remoteVersion,
                data: structuredClone(remote),
            };
            return next;
        }
        case "local-deleted":
            if (next.deleteLog) next.deleteLog = { ...next.deleteLog, version: conflict.remoteVersion };
            return next;
        case "refused":
            if (row && merged) next.row = withData(row, merged, row.version, 0);
            return next;
        case "remote-deleted":
            return groupKeepLocal(state);
    }
}

/** Keep the remote side. Throws for a conflict whose remote side is unavailable (`acceptRemoteBlocked`). */
export function acceptRemote(state: KeyState): KeyState {
    const { row, conflict } = state;
    if (!conflict) return state;
    const next: KeyState = { ...state, conflict: undefined };

    switch (conflict.kind) {
        case "changed":
        case "refused": {
            if (!row) return next;
            if (conflict.remote) {
                next.row = withData(row, conflict.remote, conflict.remoteVersion || row.version, 1);
                next.cache = undefined;
                return next;
            }
            if (row.version === 0) return {};
            throw new Error(acceptRemoteBlocked(state) ?? "No remote copy to accept");
        }
        case "local-deleted": {
            const snapshot = state.deleteLog?.snapshot;
            next.deleteLog = undefined;
            if (snapshot && conflict.remote) {
                next.row = withData({ ...snapshot, synced: 1 }, conflict.remote, conflict.remoteVersion, 1);
                next.cache = undefined;
            }
            return next;
        }
        case "remote-deleted":
            return {};
    }
}

/**
 * Keep Local for a remote-deletion member: recreate it on the server. The
 * last server copy this device knew is kept as a record that the key
 * existed there (a later local delete is then logged, so a re-creation made
 * elsewhere meanwhile still surfaces); it is not used as a merge base for a
 * row that is not on the server.
 */
export function groupKeepLocal(state: KeyState): KeyState {
    const { row } = state;
    if (!row) return { ...state, conflict: undefined };
    const base =
        state.cache ??
        (row.synced === 1 && row.version > 0
            ? { libraryID: row.libraryID, key: row.key, version: row.version, data: structuredClone(dataOf(row)) }
            : undefined);
    return {
        ...state,
        conflict: undefined,
        journal: undefined,
        cache: base,
        row: { ...row, version: 0, synced: 0 },
    };
}
