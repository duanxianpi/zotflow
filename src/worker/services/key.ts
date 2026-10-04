import Dexie from "dexie";

import { db } from "db/db";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import { groupLibraryAccess, userLibraryAccess } from "utils/key-access";

import type { IParentProxy } from "bridge/types";
import type { ZoteroAPIService } from "./zotero";
import type { IDBZoteroKey } from "types/db-schema";
import type { ZoteroGroup, ZoteroKey } from "types/zotero";
import type { ZotFlowSettings, LibrarySyncMode } from "settings/types";

/** Row data structure for displaying library metadata and sync status in settings UI. */
export interface LibraryRow {
    id: number;
    type: "user" | "group";
    name: string;
    canRead: boolean;
    canWrite: boolean;
    /** Whether the API key grants notes-read access for this library. */
    hasNotesAccess: boolean;
    allowedModes: LibrarySyncMode[];
    defaultMode: LibrarySyncMode;
    /** The currently configured mode from settings (falls back to defaultMode). */
    mode: LibrarySyncMode;
    syncedAt: string;
    /** Changes waiting to be uploaded: created and edited items, deletions (conflicts excluded). */
    pushCount: number;
    /** Conflicts to resolve; a remote deletion's members count once. */
    conflictCount: number;
}

/**
 * Worker-side service for Zotero API key, group, and library metadata.
 * Replaces all direct `db.keys.*`, `db.groups.*`, `db.libraries.*` access
 * that was previously in main-thread settings/UI code.
 */
export class KeyService {
    constructor(
        private zoteroApi: ZoteroAPIService,
        private parentHost: IParentProxy,
    ) {}

    // Get cached key info from IDB.
    async getKeyInfo(apiKey: string): Promise<IDBZoteroKey | undefined> {
        return db.keys.get(apiKey);
    }

    // Delete a key record.
    async deleteKey(apiKey: string): Promise<void> {
        await db.keys.delete(apiKey);
    }

    /**
     * Build a flat list of library rows suitable for settings / SyncView UI.
     * Includes per-library change counts and sync timestamps.
     */
    async getLibraryRows(settings: ZotFlowSettings): Promise<LibraryRow[]> {
        const keyInfo = await db.keys.get(settings.zoteroapikey);
        if (!keyInfo) return [];

        const rows: LibraryRow[] = [];

        // Personal library
        if (keyInfo.access?.user) {
            const u = userLibraryAccess(keyInfo);
            const canRead = u.library;
            const canWrite = u.write;
            const hasNotesAccess = u.notes;
            const { defaultMode, allowed } = getModes(canRead, canWrite);
            const libState = await db.libraries.get(keyInfo.userID);
            const counts = await this.countLocalChanges(keyInfo.userID);

            rows.push({
                id: keyInfo.userID,
                type: "user",
                name: "My Library",
                canRead,
                canWrite,
                hasNotesAccess,
                allowedModes: allowed,
                defaultMode,
                mode:
                    settings.librariesConfig[keyInfo.userID]?.mode ??
                    defaultMode,
                syncedAt: libState?.syncedAt ?? "",
                ...counts,
            });
        }

        // Group libraries
        for (const groupId of keyInfo.joinedGroups) {
            const group = await db.groups.get(groupId);
            if (!group) continue;

            const access = groupLibraryAccess(keyInfo, groupId);
            const canRead = access.library;
            const canWrite = access.write;
            const hasNotesAccess = access.notes;
            const { defaultMode, allowed } = getModes(canRead, canWrite);
            const libState = await db.libraries.get(group.id);
            const counts = await this.countLocalChanges(group.id);

            rows.push({
                id: group.id,
                type: "group",
                name: group.name,
                canRead,
                canWrite,
                hasNotesAccess,
                allowedModes: allowed,
                defaultMode,
                mode: settings.librariesConfig[group.id]?.mode ?? defaultMode,
                syncedAt: libState?.syncedAt ?? "",
                ...counts,
            });
        }

        return rows;
    }

    /**
     * Verify (or refresh) an API key:
     * 1. Call Zotero API to verify key access
     * 2. Fetch groups
     * 3. Persist key, groups, and library records to IDB
     *
     * Returns the verified key info and username so the caller can show a
     * notification without needing `db` access.
     */
    async verifyAndPersistKey(
        apiKey: string,
    ): Promise<{ keyInfo: ZoteroKey; username: string }> {
        const verifiedKeyInfo = await this.zoteroApi.verifyKey(apiKey);
        if (!verifiedKeyInfo) {
            throw new ZotFlowError(
                ZotFlowErrorCode.AUTH_INVALID,
                "KeyService",
                "Invalid API Key",
            );
        }

        const groups: ZoteroGroup[] = await this.zoteroApi.getGroups(
            verifiedKeyInfo.userID,
            apiKey,
        );

        // Persist key + groups
        await db.keys.put({
            joinedGroups: groups.map((g) => g.id),
            ...verifiedKeyInfo,
        });
        await db.groups.bulkPut(groups);

        // Ensure library records exist
        const libState = await db.libraries.get(verifiedKeyInfo.userID);
        if (!libState) {
            await db.libraries.add({
                id: verifiedKeyInfo.userID,
                type: "user",
                name: "My Library",
                collectionVersion: 0,
                itemVersion: 0,
                syncedAt: new Date().toISOString().split(".")[0] + "Z",
            });
        }

        for (const group of groups) {
            const gLibState = await db.libraries.get(group.id);
            if (!gLibState) {
                await db.libraries.add({
                    id: group.id,
                    type: "group",
                    name: group.name,
                    collectionVersion: 0,
                    itemVersion: 0,
                    syncedAt: new Date().toISOString().split(".")[0] + "Z",
                });
            } else if (gLibState.name !== group.name) {
                gLibState.name = group.name;
                await db.libraries.put(gLibState);
            }
        }

        return { keyInfo: verifiedKeyInfo, username: verifiedKeyInfo.username };
    }

    // Count items + collections with a non-synced status for a library,
    // plus local deletes not yet uploaded (their rows are already gone).
    /** What a sync would upload from a library, and what waits on the user. */
    private async countLocalChanges(libraryID: number): Promise<{ pushCount: number; conflictCount: number }> {
        const range: [[number, unknown], [number, unknown]] = [
            [libraryID, Dexie.minKey],
            [libraryID, Dexie.maxKey],
        ];
        const [created, updated, deletes, conflicts] = await Promise.all([
            db.items.where("[libraryID+syncStatus]").equals([libraryID, "created"]).count(),
            db.items.where("[libraryID+syncStatus]").equals([libraryID, "updated"]).count(),
            db.syncDeleteLog.where("[libraryID+key]").between(...range).primaryKeys(),
            db.syncConflicts.where("[libraryID+key]").between(...range).toArray(),
        ]);
        // A pending delete in conflict waits on the user, not on a sync.
        const inConflict = new Set(conflicts.map((c) => c.key));
        const pendingDeletes = deletes.filter(([, key]) => !inConflict.has(key)).length;
        // A remote deletion's members are resolved together: one conflict.
        const conflictCount = new Set(conflicts.map((c) => (c.group ? `group:${c.group}` : c.key))).size;
        return { pushCount: created + updated + pendingDeletes, conflictCount };
    }
}

function getModes(
    canRead: boolean,
    canWrite: boolean,
): { defaultMode: LibrarySyncMode; allowed: LibrarySyncMode[] } {
    if (!canRead) return { defaultMode: "ignored", allowed: ["ignored"] };
    const defaultMode: LibrarySyncMode = canWrite
        ? "bidirectional"
        : "readonly";
    const allowed: LibrarySyncMode[] = canWrite
        ? ["bidirectional", "readonly", "ignored"]
        : ["readonly", "ignored"];
    return { defaultMode, allowed };
}
