import type { LogService } from "./log-service";
import type { LibrarySyncMode, ZotFlowSettings } from "settings/types";
import type { LibrarySnapshotEntry } from "worker/services/library";

/** Snapshot entry stored in the local cache. */
interface LibraryEntry {
    mode: LibrarySyncMode | undefined;
    hasNotesAccess: boolean;
    canWrite: boolean;
}

/**
 * Main-thread mirror of the worker's `LibraryService`.
 *
 * Holds a synchronous snapshot of every visible library so render-path code
 * (CodeMirror filters, React renders, reader bootstrap, etc.) can decide
 * gating without awaiting a Comlink round-trip.
 *
 * The snapshot is rebuilt via `refresh()` after every settings save and
 * after worker initialisation. The worker remains the source of truth.
 */
export class LibraryCache {
    private entries = new Map<number, LibraryEntry>();

    constructor(
        private getSettings: () => ZotFlowSettings,
        private logService: LogService,
    ) {}

    /**
     * Pull a fresh snapshot from the worker. Failures are logged but never
     * thrown; callers fall back to "no access" defaults.
     */
    async refresh(): Promise<void> {
        try {
            // Late import to avoid a circular dep with bridge -> services.
            const { workerBridge } = await import("bridge");
            const snapshot: LibrarySnapshotEntry[] =
                await workerBridge.library.getSnapshot();
            this.entries.clear();
            for (const entry of snapshot) {
                this.entries.set(entry.libraryID, {
                    mode: entry.mode,
                    hasNotesAccess: entry.hasNotesAccess,
                    canWrite: entry.canWrite,
                });
            }
        } catch (e) {
            this.logService.error(
                "Failed to refresh library cache",
                "LibraryCache",
                e,
            );
        }
    }

    /* ================================================================= */
    /*            Sync-mode lookups (synchronous, settings-only)         */
    /* ================================================================= */

    // Read live from settings rather than the cached entry so mode changes
    // are reflected immediately without waiting for a refresh round-trip.
    getMode(libraryID: number): LibrarySyncMode | undefined {
        return this.getSettings().librariesConfig[libraryID]?.mode;
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
    /*            Capability lookups (from cache)                        */
    /* ================================================================= */

    hasNotesAccess(libraryID: number): boolean {
        return this.entries.get(libraryID)?.hasNotesAccess ?? false;
    }

    canWrite(libraryID: number): boolean {
        return this.entries.get(libraryID)?.canWrite ?? false;
    }

    /* ================================================================= */
    /*            Composed gates                                         */
    /* ================================================================= */

    canEditNotes(libraryID: number): boolean {
        return (
            this.isBidirectional(libraryID) &&
            this.hasNotesAccess(libraryID) &&
            this.canWrite(libraryID)
        );
    }
}
