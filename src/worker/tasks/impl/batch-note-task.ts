import { BaseTask } from "../base";
import { db } from "db/db";

import type { IParentProxy } from "bridge/types";
import type {
    LibraryNoteService,
    UpdateOptions,
} from "worker/services/library-note";
import type { TaskType, TaskStatus } from "types/tasks";
import type { ItemIdentifier } from "./batch-extract-images-task";

/**
 * Input descriptor for batch note operations.
 * Items are queried from IDB at task start to ensure freshness.
 */
export interface BatchNoteInput {
    /**
     * Items to process. Callers are responsible for resolving the desired
     * scope (e.g. all top-level items across active libraries) before
     * scheduling the task — an empty/missing `items` list is a no-op.
     */
    items?: ItemIdentifier[];
}

/**
 * BatchNoteTask — handles both batch-create and batch-update note flows.
 *
 * - `batch-create-notes`: creates/updates notes without forcing content refresh.
 * - `batch-update-notes`: forces content refresh (template re-render) for every item.
 */
export class BatchNoteTask extends BaseTask {
    constructor(
        parentHost: IParentProxy,
        private noteService: LibraryNoteService,
        private input: BatchNoteInput,
        private options: UpdateOptions,
        type: TaskType = "batch-create-notes",
    ) {
        super(type, parentHost);
        const action = type === "batch-update-notes" ? "Updating" : "Creating";
        this.displayText = `${action} Notes`;
        this.taskInput = {};
        if (input.items?.length) {
            this.taskInput.items = input.items.length;
        }
    }

    protected async run(signal: AbortSignal): Promise<void> {
        // Resolve items to process
        const items = await this.resolveItems();

        if (items.length === 0) {
            this.reportProgress(0, 0, "No items to process");
            return;
        }

        const total = items.length;
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < items.length; i++) {
            if (signal.aborted) throw new Error("Aborted");

            const item = items[i]!;
            const label = item.title || item.key;

            this.reportProgress(
                i,
                total,
                `Processing ${i + 1}/${total}: ${label}`,
            );

            try {
                await this.noteService.triggerUpdate(
                    item.libraryID,
                    item.key,
                    this.options,
                    false, // no debounce for batch operations
                );
                successCount++;
            } catch (e) {
                failCount++;
                // Log but don't abort — continue with remaining items
                this.log(
                    "error",
                    `Failed to update note for item ${item.key}: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                    "BatchNoteTask",
                    { itemKey: item.key, libraryID: item.libraryID },
                );
            }
        }

        // Store result summary
        this.result = {
            successCount,
            failCount,
            details: {
                processed: total,
                succeeded: successCount,
                failed: failCount,
            },
        };

        if (failCount > 0) {
            this.reportProgress(
                total,
                total,
                `Finished: ${successCount} success, ${failCount} failed`,
            );
        } else {
            this.reportProgress(total, total, "All notes processed");
        }
    }

    protected getTerminalDisplayText(status: TaskStatus): string {
        const action =
            this.type === "batch-update-notes" ? "Updated" : "Created";
        if (status === "cancelled") return `${action} Notes — Cancelled`;
        if (status === "failed") return `${action} Notes — Failed`;
        const r = this.result;
        if (r && r.failCount > 0) {
            return `${action} ${r.successCount} notes (${r.failCount} failed)`;
        }
        return `${action} ${r?.successCount ?? 0} notes`;
    }

    /**
     * Resolve the item list from the input descriptor.
     * Callers must supply `input.items` — an empty/missing list yields
     * an empty result (the task is a no-op rather than implicitly
     * targeting every synced item).
     */
    private async resolveItems() {
        if (!this.input.items || this.input.items.length === 0) return [];

        const items = [];
        for (const { libraryID, itemKey } of this.input.items) {
            const item = await db.items.get([libraryID, itemKey]);
            // Batch note operations must never create or refresh source notes
            // for top-level items that have moved to the Zotero trash.
            if (item && !item.trashed) {
                items.push(item);
            }
        }
        return items;
    }
}
