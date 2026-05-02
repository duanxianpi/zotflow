import { db } from "db/db";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

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
    changedCount: number;
}

const DIRTY_STATUSES = ["created", "updated", "deleted", "conflict"] as const;

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
        if (keyInfo.access.user) {
            const u = keyInfo.access.user;
            const canRead = !!u.library;
            const canWrite = !!u.write;
            const hasNotesAccess = !!(u.library && u.notes);
            const { defaultMode, allowed } = getModes(canRead, canWrite);
            const libState = await db.libraries.get(keyInfo.userID);
            const changedCount = await this.countChangedItems(keyInfo.userID);

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
                changedCount,
            });
        }

        // Group libraries
        for (const groupId of keyInfo.joinedGroups) {
            const group = await db.groups.get(groupId);
            if (!group) continue;

            const gAccess = keyInfo.access.groups;
            const specific = gAccess?.[groupId];
            const all = gAccess?.all;
            const canRead = specific?.library ?? all?.library ?? false;
            const canWrite = specific?.write ?? all?.write ?? false;
            // Group libraries don't have a separate notes flag — notes access
            // follows library access.
            const hasNotesAccess = canRead;
            const { defaultMode, allowed } = getModes(canRead, canWrite);
            const libState = await db.libraries.get(group.id);
            const changedCount = await this.countChangedItems(group.id);

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
                changedCount,
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

    // Count items + collections with a non-synced status for a library.
    private async countChangedItems(libraryID: number): Promise<number> {
        let total = 0;
        for (const status of DIRTY_STATUSES) {
            total += await db.items
                .where("[libraryID+syncStatus]")
                .equals([libraryID, status])
                .count();
            total += await db.collections
                .where("[libraryID+syncStatus]")
                .equals([libraryID, status])
                .count();
        }
        return total;
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
