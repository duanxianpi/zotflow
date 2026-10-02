import { db } from "db/db";
import {
    getDescendants,
    putGroup,
    readKey,
    syncTransaction,
    SyncWriter,
} from "db/sync/commit";
import {
    acceptRemote,
    acceptRemoteBlocked,
    groupKeepLocal,
    keepLocal,
} from "db/sync/decide";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { IParentProxy } from "bridge/types";
import type { KeyState } from "db/sync/model";
import type {
    AnyIDBZoteroItem,
    IDBSyncConflict,
    ItemDataJSON,
    SyncConflictKind,
} from "types/db-schema";

/* ================================================================ */
/*  Public types                                                   */
/* ================================================================ */

/** Discriminator for conflict resolution strategy. */
export type ConflictAction = "keep-local" | "accept-remote";

/** A single field-level diff entry */
export interface FieldDiff {
    field: string;
    localValue: string;
    remoteValue: string;
}

/** The kind of conflict as the UI groups it (derived from `kind`). */
export type ItemConflictType =
    | "update" // both sides changed
    | "delete" // deleted on one side, changed on the other
    | "push"; // the server refused the write

/** Full detail of a single item-level sync conflict. */
export interface ConflictItemInfo {
    libraryID: number;
    key: string;
    itemType: string;
    title: string;
    kind: SyncConflictKind;
    conflictType: ItemConflictType;
    /** A sentence on what happened, for the UI. */
    syncError: string;
    fields: FieldDiff[];
    /** The fields changed differently on both sides: Keep Local keeps the local value of these. */
    conflictFields: string[];
    /** The local side (`{ deleted: true }` when deleted here). */
    localData?: ItemDataJSON;
    /** The remote side (`{ deleted: true }` when deleted in Zotero). */
    remoteData?: ItemDataJSON;
    /** The server version the remote side is from (0: none). */
    remoteVersion: number;
    /** The remote-deletion group (its root key); resolving one member resolves them all. */
    group?: string;
    groupSize?: number;
    /** Why Keep Local is unavailable, if it is. */
    keepLocalBlocked?: string;
    /** Why Accept Remote is unavailable, if it is. */
    acceptRemoteBlocked?: string;
}

const CONFLICT_TYPE: Record<SyncConflictKind, ItemConflictType> = {
    changed: "update",
    "local-deleted": "delete",
    "remote-deleted": "delete",
    refused: "push",
};

/* ================================================================ */
/*  Service                                                        */
/* ================================================================ */

/** Worker-side service for listing and resolving sync conflicts. */
export class ConflictService {
    constructor(private parentHost: IParentProxy) {}

    /* ================================================================ */
    /*  Queries                                                        */
    /* ================================================================ */

    /** All item conflicts, across libraries; members of a group are listed together. */
    async getItemConflicts(): Promise<ConflictItemInfo[]> {
        try {
            const conflicts = await db.syncConflicts.toArray();
            const results: ConflictItemInfo[] = [];
            const groupSizes = new Map<string, number>();
            for (const c of conflicts) {
                if (c.group) groupSizes.set(`${c.libraryID}/${c.group}`, (groupSizes.get(`${c.libraryID}/${c.group}`) ?? 0) + 1);
            }
            for (const c of conflicts) {
                const state = await readKey(c.libraryID, c.key);
                results.push(this.buildInfo(c, state, groupSizes.get(`${c.libraryID}/${c.group}`)));
            }
            results.sort(
                (a, b) =>
                    a.libraryID - b.libraryID ||
                    (a.group ?? a.key).localeCompare(b.group ?? b.key) ||
                    (a.key === a.group ? -1 : b.key === b.group ? 1 : a.key.localeCompare(b.key)),
            );
            return results;
        } catch (e) {
            throw ZotFlowError.wrap(e, ZotFlowErrorCode.DB_OPEN_FAILED, "ConflictService", "Failed to query item conflicts");
        }
    }

    /* ================================================================ */
    /*  Resolution                                                     */
    /* ================================================================ */

    /**
     * Resolves one conflict — or, for a member of a remote-deletion group,
     * the whole group. `merged` (Keep Local only) is the data to keep when
     * the user chose per field; by default the local side is kept as it is.
     */
    async resolveItemConflict(
        libraryID: number,
        key: string,
        action: ConflictAction,
        merged?: ItemDataJSON,
    ): Promise<void> {
        try {
            const conflict = await db.syncConflicts.get([libraryID, key]);
            if (!conflict) {
                const row = await db.items.get([libraryID, key]);
                if (!row) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "ConflictService",
                        `Item not found: ${libraryID}/${key}`,
                    );
                }
                this.parentHost.log(
                    "warn",
                    `Item ${key} is not in conflict (status=${row.syncStatus}), skipping.`,
                    "ConflictService",
                );
                return;
            }

            if (conflict.kind === "remote-deleted" && conflict.group) {
                await this.resolveGroup(libraryID, conflict.group, action);
            } else {
                await syncTransaction(async () => {
                    const writer = new SyncWriter(libraryID);
                    await writer.update(key, (state) => {
                        if (action === "keep-local") return keepLocal(state, merged);
                        const blocked = acceptRemoteBlocked(state);
                        if (blocked) {
                            throw new ZotFlowError(ZotFlowErrorCode.UNKNOWN, "ConflictService", blocked);
                        }
                        return acceptRemote(state);
                    });
                });
            }

            this.parentHost.log("info", `Resolved item conflict ${key} → ${action}`, "ConflictService");
            this.parentHost.emit("treeChanged");
        } catch (e) {
            throw ZotFlowError.wrap(e, ZotFlowErrorCode.DB_WRITE_FAILED, "ConflictService", `Failed to resolve item conflict ${key}`);
        }
    }

    /**
     * Resolves a remote-deletion group: Keep Local recreates every member
     * (uploaded parents first); Accept Remote removes every member and what
     * is under it. Only the recorded members are touched.
     */
    private async resolveGroup(libraryID: number, id: string, action: ConflictAction): Promise<void> {
        await syncTransaction(async () => {
            const writer = new SyncWriter(libraryID);
            const record = await db.syncGroups.get([libraryID, id]);
            const members = new Set(record?.members ?? []);
            for (const c of await db.syncConflicts.where("[libraryID+group]").equals([libraryID, id]).toArray()) {
                members.add(c.key);
            }

            for (const key of members) {
                const state = await readKey(libraryID, key);
                if (state.conflict?.group !== id) continue;
                if (action === "keep-local") {
                    await writer.commit(key, state, groupKeepLocal(state));
                    continue;
                }
                const under: AnyIDBZoteroItem[] = state.row ? await getDescendants(libraryID, key) : [];
                await writer.commit(key, state, {});
                for (const d of under) {
                    const dState: KeyState = await readKey(libraryID, d.key);
                    if (dState.conflict?.group && dState.conflict.group !== id) continue;
                    await writer.commit(d.key, dState, {});
                }
            }
            if (record) await putGroup({ ...record, members: [] });
        });
    }

    async resolveAllItemConflicts(action: ConflictAction): Promise<number> {
        const conflicts = await this.getItemConflicts();
        let resolved = 0;
        const doneGroups = new Set<string>();

        for (const c of conflicts) {
            if (c.group) {
                const id = `${c.libraryID}/${c.group}`;
                if (doneGroups.has(id)) continue;
                doneGroups.add(id);
            }
            if (!(await db.syncConflicts.get([c.libraryID, c.key]))) continue;
            if (action === "accept-remote" && c.acceptRemoteBlocked) continue;
            await this.resolveItemConflict(c.libraryID, c.key, action);
            resolved++;
        }

        this.parentHost.log("info", `Batch-resolved ${resolved} item conflicts → ${action}`, "ConflictService");
        return resolved;
    }

    /* ================================================================ */
    /*  Private — listing helpers                                      */
    /* ================================================================ */

    private buildInfo(c: IDBSyncConflict, state: KeyState, groupSize?: number): ConflictItemInfo {
        const row = state.row ?? state.deleteLog?.snapshot;
        const localData: ItemDataJSON | undefined =
            c.kind === "local-deleted" ? { deleted: true } : (state.row?.raw.data as unknown as ItemDataJSON | undefined);
        const remoteData: ItemDataJSON | undefined = c.kind === "remote-deleted" ? undefined : c.remote;
        const remoteType = c.remote?.itemType;
        const itemType = row?.itemType ?? (typeof remoteType === "string" ? remoteType : "item");

        let syncError: string;
        switch (c.kind) {
            case "changed":
                syncError = "Changed both here and in Zotero.";
                break;
            case "local-deleted":
                syncError = "Deleted here, changed in Zotero.";
                break;
            case "remote-deleted":
                syncError =
                    c.group && c.group !== c.key
                        ? `An item above it (${c.group}) was deleted in Zotero.`
                        : "Deleted in Zotero, changed here.";
                break;
            case "refused":
                syncError = c.error ?? "Zotero refused the change.";
                break;
        }

        return {
            libraryID: c.libraryID,
            key: c.key,
            itemType,
            title: row?.title || `${itemType} (${c.key})`,
            kind: c.kind,
            conflictType: CONFLICT_TYPE[c.kind],
            syncError,
            fields: this.diffFields(localData, remoteData, c.kind),
            conflictFields: [...c.fields],
            localData,
            remoteData: remoteData ?? { deleted: true },
            remoteVersion: c.remoteVersion,
            ...(c.group ? { group: c.group, groupSize } : {}),
            ...(acceptRemoteBlocked(state) ? { acceptRemoteBlocked: acceptRemoteBlocked(state) } : {}),
        };
    }

    private diffFields(
        local: ItemDataJSON | undefined,
        remote: ItemDataJSON | undefined,
        kind: SyncConflictKind,
    ): FieldDiff[] {
        if (kind === "local-deleted") {
            return [{ field: "(entire item)", localValue: "(deleted here)", remoteValue: JSON.stringify(remote ?? {}, null, 2) }];
        }
        if (!remote) {
            if (!local) return [];
            return [{ field: "(entire item)", localValue: JSON.stringify(local, null, 2), remoteValue: "(deleted on server)" }];
        }
        if (!local) {
            return [{ field: "(entire item)", localValue: "(no local data)", remoteValue: JSON.stringify(remote, null, 2) }];
        }
        const skip = new Set(["key", "version", "dateModified"]);
        const diffs: FieldDiff[] = [];
        for (const field of new Set([...Object.keys(local), ...Object.keys(remote)])) {
            if (skip.has(field)) continue;
            const ls = this.stringify(local[field]);
            const rs = this.stringify(remote[field]);
            if (ls !== rs) diffs.push({ field, localValue: ls, remoteValue: rs });
        }
        return diffs;
    }

    /** Stringify a value for display (handles arrays/objects). */
    private stringify(value: unknown): string {
        if (value === undefined) return "(undefined)";
        if (value === null) return "(null)";
        if (typeof value === "string") return value;
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        return JSON.stringify(value, null, 2);
    }
}
