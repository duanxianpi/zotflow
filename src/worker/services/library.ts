import { db } from "db/db";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { IParentProxy } from "bridge/types";
import type { IDBZoteroKey } from "types/db-schema";
import type { LibrarySyncMode, ZotFlowSettings } from "settings/types";

/** Per-library capability + mode snapshot for the main-thread cache mirror. */
export interface LibrarySnapshotEntry {
    libraryID: number;
    mode: LibrarySyncMode | undefined;
    hasNotesAccess: boolean;
    canWrite: boolean;
}

/**
 * Worker-side authoritative service for everything library-scoped:
 *   - sync-mode lookups (`getMode`, `isReadOnly`, `isIgnored`, `isBidirectional`)
 *   - API-key capability lookups (`hasNotesAccess`, `canWrite`)
 *   - composed gates (`canEditNotes`)
 *   - active-library resolution (`getActiveLibraryIDs`)
 *   - snapshot for the main-thread mirror (`getSnapshot`)
 *
 * The main thread keeps a synchronous mirror via `LibraryCache` that calls
 * `getSnapshot()` whenever settings change.
 */
export class LibraryService {
    // Cached key info to avoid repeated `db.keys.get()` calls within one task.
    private keyInfoCache: IDBZoteroKey | undefined | null = null;

    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
    ) {}

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
        // Invalidate the key-info cache: API key may have changed.
        this.keyInfoCache = null;
    }

    /* ================================================================= */
    /*            Sync-mode lookups (synchronous, settings-only)         */
    /* ================================================================= */

    // Resolve the configured sync mode for a library, or `undefined`.
    getMode(libraryID: number): LibrarySyncMode | undefined {
        return this.settings.librariesConfig[libraryID]?.mode;
    }

    isReadOnly(libraryID: number): boolean {
        return this.getMode(libraryID) === "readonly";
    }

    isIgnored(libraryID: number): boolean {
        const mode = this.getMode(libraryID);
        return mode === "ignored" || mode === undefined;
    }

    isBidirectional(libraryID: number): boolean {
        return this.getMode(libraryID) === "bidirectional";
    }

    /* ================================================================= */
    /*            API key capability lookups (asynchronous, DB access)     */
    /* ================================================================= */

    /**
     * Whether the configured API key grants notes-read access for a library.
     * User libraries are gated by the explicit `notes` flag; group libraries
     * inherit notes access from library access.
     */
    async hasNotesAccess(libraryID: number): Promise<boolean> {
        const keyInfo = await this.getKeyInfo();
        if (!keyInfo) return false;

        if (libraryID === keyInfo.userID) {
            const u = keyInfo.access.user;
            return !!(u?.library && u?.notes);
        }

        const gAccess = keyInfo.access.groups;
        const specific = gAccess?.[libraryID];
        const all = gAccess?.all;
        return !!(specific?.library ?? all?.library ?? false);
    }

    /** Whether the configured API key grants write access for a library. */
    async canWrite(libraryID: number): Promise<boolean> {
        const keyInfo = await this.getKeyInfo();
        if (!keyInfo) return false;

        if (libraryID === keyInfo.userID) {
            return !!keyInfo.access.user?.write;
        }

        const gAccess = keyInfo.access.groups;
        const specific = gAccess?.[libraryID];
        const all = gAccess?.all;
        return !!(specific?.write ?? all?.write ?? false);
    }

    /* ================================================================= */
    /*            Composed gates                                         */
    /* ================================================================= */

    /**
     * Whether note + annotation **write** operations are allowed for this
     * library. True only when the configured sync mode is `bidirectional`
     * AND the API key grants notes + write access.
     */
    async canEditNotes(libraryID: number): Promise<boolean> {
        if (!this.isBidirectional(libraryID)) return false;
        const [notes, write] = await Promise.all([
            this.hasNotesAccess(libraryID),
            this.canWrite(libraryID),
        ]);
        return notes && write;
    }

    /* ================================================================= */
    /*            Library set helpers                                    */
    /* ================================================================= */

    /**
     * Return the set of library IDs that are configured for sync (mode is
     * not `ignored`/unset) and visible to the current API key.
     */
    async getActiveLibraryIDs(): Promise<number[]> {
        const keyInfo = await this.getKeyInfo();
        if (!keyInfo) {
            throw new ZotFlowError(
                ZotFlowErrorCode.AUTH_INVALID,
                "LibraryService",
                "Invalid Zotero API key (not found in DB).",
                { api_key: this.settings.zoteroapikey },
            );
        }
        return keyInfo.joinedGroups
            .concat([keyInfo.userID])
            .filter((id) => !this.isIgnored(id));
    }

    /**
     * Build a snapshot of all visible libraries for the main-thread mirror.
     * Returns an empty array when the API key is missing or unknown.
     */
    async getSnapshot(): Promise<LibrarySnapshotEntry[]> {
        const keyInfo = await this.getKeyInfo();
        if (!keyInfo) return [];

        const libraryIDs = keyInfo.joinedGroups.concat([keyInfo.userID]);
        const out: LibrarySnapshotEntry[] = [];
        for (const id of libraryIDs) {
            const [hasNotesAccess, canWrite] = await Promise.all([
                this.hasNotesAccess(id),
                this.canWrite(id),
            ]);
            out.push({
                libraryID: id,
                mode: this.getMode(id),
                hasNotesAccess,
                canWrite,
            });
        }
        return out;
    }

    /* ================================================================= */
    /*            Internal                                               */
    /* ================================================================= */

    private async getKeyInfo(): Promise<IDBZoteroKey | undefined> {
        if (this.keyInfoCache !== null) return this.keyInfoCache;
        const apiKey = this.settings.zoteroapikey;
        if (!apiKey) {
            this.keyInfoCache = undefined;
            return undefined;
        }
        try {
            this.keyInfoCache = await db.keys.get(apiKey);
        } catch (e) {
            this.parentHost.log(
                "warn",
                "Failed to read key info",
                "LibraryService",
                e,
            );
            this.keyInfoCache = undefined;
        }
        return this.keyInfoCache;
    }
}
