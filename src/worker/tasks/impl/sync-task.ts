import { BaseTask } from "../base";
import { db } from "db/db";
import type { IParentProxy } from "bridge/types";
import type { SyncService } from "worker/services/sync";
import type { LibraryNoteService } from "worker/services/library-note";
import type { TaskManager } from "../manager";
import type { ZotFlowSettings } from "settings/types";
import type { TaskStatus } from "types/tasks";
import type { ItemIdentifier } from "./batch-extract-images-task";

/** Tracked background task that runs a full or library-scoped sync cycle. */
export class SyncTask extends BaseTask {
    constructor(
        parentHost: IParentProxy,
        private syncService: SyncService,
        private libraryId?: number,
        private taskManager?: TaskManager,
        private libraryNoteService?: LibraryNoteService,
        private settings?: ZotFlowSettings,
    ) {
        super("sync", parentHost);
        this.displayText = libraryId
            ? `Syncing Library ${libraryId}`
            : "Syncing Libraries";
    }

    protected async run(signal: AbortSignal): Promise<void> {
        // Populate input context for Activity Center display
        if (this.libraryId !== undefined) {
            const lib = await db.libraries.get(this.libraryId);
            this.taskInput = {
                library: lib?.name ?? String(this.libraryId),
                libraryId: this.libraryId,
            };
            if (lib) {
                this.displayText = `Syncing: ${lib.name}`;
            }
        } else {
            this.taskInput = { scope: "all" };
        }

        this.reportProgress(0, 1, "Starting sync...");

        const { successCount, failCount, changedItems, syncedLibraryIDs } =
            await this.syncService.startSync(
                signal,
                (completed, total, message) => {
                    this.reportProgress(completed, total, message);
                },
                this.libraryId,
            );

        this.result = {
            successCount,
            failCount,
            details: {
                libraries: successCount + failCount,
                synced: successCount,
                failed: failCount,
                changedItems: changedItems.length,
            },
        };

        // Auto-update source notes for changed items, if enabled.
        if (
            !signal.aborted &&
            this.settings?.autoUpdateSourceNotesAfterSync &&
            this.taskManager &&
            this.libraryNoteService &&
            changedItems.length > 0
        ) {
            try {
                const resolved =
                    await this.resolveNoteBearingItems(changedItems);
                if (resolved.length > 0) {
                    // Fire-and-forget: spawned task is independently tracked.
                    // Force content refresh: annotation/note changes do not
                    // bump the parent item's version, so the version-equality
                    // short-circuit in performUpdate would otherwise skip them.
                    //
                    // The catch is not optional: `void` on a promise attaches
                    // no rejection handler, so a failure here would escape the
                    // surrounding try/catch as an unhandled rejection rather
                    // than being swallowed as intended.
                    this.taskManager
                        .createBatchNoteTask(
                            this.libraryNoteService,
                            { items: resolved },
                            { forceUpdateContent: true },
                            true,
                        )
                        .catch((spawnErr) =>
                            this.log(
                                "error",
                                "Failed to spawn the post-sync source-note refresh",
                                "SyncTask",
                                spawnErr,
                            ),
                        );
                }
            } catch (e) {
                // Never let post-sync chaining fail the sync task itself.
                // (Logging is best-effort; the SyncService already logs sync issues.)
                void e;
            }
        }

        // Auto-purge source notes for items moved to the Zotero trash, if enabled.
        if (
            !signal.aborted &&
            this.settings?.autoPurgeTrashedSourceNotes &&
            this.libraryNoteService &&
            syncedLibraryIDs.length > 0
        ) {
            try {
                await this.libraryNoteService.purgeTrashedSourceNotes(
                    syncedLibraryIDs,
                );
            } catch (e) {
                // Best-effort: a purge failure must not fail the sync task.
                void e;
            }
        }
    }

    /**
     * Resolve a list of changed item identifiers to the set of items whose
     * source notes should be refreshed. Walks parent links upward so that
     * annotations (parent = attachment), attachments (parent = top-level item),
     * and child notes are all resolved to their top-level item. Items without
     * a top-level ancestor are dropped. Result is deduplicated.
     */
    private async resolveNoteBearingItems(
        changed: ItemIdentifier[],
    ): Promise<ItemIdentifier[]> {
        const CHILD_TYPES = new Set(["annotation", "attachment", "note"]);
        const MAX_DEPTH = 5; // safety bound — annotation -> attachment -> item

        const seen = new Set<string>();
        const out: ItemIdentifier[] = [];

        for (const { libraryID, itemKey } of changed) {
            let item = await db.items.get([libraryID, itemKey]);
            if (!item) continue;

            // Walk up while the item is a child type with a parentItem.
            let depth = 0;
            while (
                item &&
                CHILD_TYPES.has(item.itemType) &&
                item.parentItem &&
                depth < MAX_DEPTH
            ) {
                item = await db.items.get([libraryID, item.parentItem]);
                depth++;
            }

            // Skip if we still have a child-type item (orphan or cycle), or if
            // the resolved top-level item itself is in the Zotero trash. A
            // trashed child may still resolve to a live parent, which should be
            // refreshed so the removed child disappears from its source note.
            if (!item || CHILD_TYPES.has(item.itemType) || item.trashed) continue;

            const dedupKey = `${libraryID}:${item.key}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            out.push({ libraryID, itemKey: item.key });
        }

        return out;
    }

    protected getTerminalDisplayText(status: TaskStatus): string {
        if (status === "cancelled") return "Sync — Cancelled";
        if (status === "failed") return "Sync — Failed";
        const r = this.result;
        if (r && r.failCount > 0) {
            return `Synced ${r.successCount} libraries (${r.failCount} failed)`;
        }
        return `Synced ${r?.successCount ?? 0} libraries`;
    }
}
