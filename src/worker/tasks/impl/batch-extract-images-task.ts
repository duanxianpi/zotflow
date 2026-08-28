import { BaseTask } from "../base";
import { db } from "db/db";
import { getAnnotationJson } from "db/annotation";

import type { IParentProxy } from "bridge/types";
import type { AttachmentService } from "worker/services/attachment";
import type { DocumentWorkerService } from "worker/services/document-worker";
import type { ZotFlowSettings } from "settings/types";
import type { TaskStatus } from "types/tasks";
import type { IDBZoteroItem, AnyIDBZoteroItem } from "types/db-schema";
import type { AttachmentData, AnnotationData } from "types/zotero-item";

/**
 * Identifies a single Zotero item by library + key.
 */
export interface ItemIdentifier {
    libraryID: number;
    itemKey: string;
}

/**
 * Input descriptor for batch image extraction.
 */
export interface BatchExtractImagesInput {
    /** Specific items to process. If empty, all synced items are used. */
    items?: ItemIdentifier[];
    /** Force re-render even if annotationImageVersion matches. */
    forceUpdate?: boolean;
}

/**
 * BatchExtractImagesTask — extracts annotation images from PDF attachments.
 *
 * For each item:
 *   1. Find PDF attachments
 *   2. Query image/ink annotations that need rendering
 *   3. Download PDF (via AttachmentService cache)
 *   4. Render annotation images via Document Worker
 *   5. Save images to vault
 */
export class BatchExtractImagesTask extends BaseTask {
    constructor(
        parentHost: IParentProxy,
        private attachmentService: AttachmentService,
        private documentWorker: DocumentWorkerService,
        private settings: ZotFlowSettings,
        private input: BatchExtractImagesInput,
    ) {
        super("batch-extract-images", parentHost);
        this.displayText = "Extracting Annotation Images";
        this.taskInput = {};
        if (input.items?.length) {
            this.taskInput.items = input.items.length;
        }
        if (input.forceUpdate) {
            this.taskInput.forceUpdate = 1;
        }
    }

    protected async run(signal: AbortSignal): Promise<void> {
        const items = await this.resolveItems();

        if (items.length === 0) {
            this.reportProgress(0, 0, "No items to process");
            return;
        }

        const total = items.length;
        let successCount = 0;
        let failCount = 0;
        const forceUpdate = this.input.forceUpdate ?? false;

        for (let i = 0; i < items.length; i++) {
            if (signal.aborted) throw new Error("Aborted");

            const item = items[i]!;
            const label = item.title || item.key;
            this.reportProgress(
                i,
                total,
                `Extracting ${i + 1}/${total}: ${label}`,
            );

            try {
                await this.extractForItem(item, forceUpdate);
                successCount++;
            } catch (e) {
                failCount++;
                // Non-fatal: log and continue
                this.log(
                    "error",
                    `Failed to extract images for item ${item.key}: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                    "BatchExtractImagesTask",
                    { itemKey: item.key, libraryID: item.libraryID },
                );
            }
        }

        this.result = {
            successCount,
            failCount,
            details: {
                items: total,
                extracted: successCount,
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
            this.reportProgress(total, total, "All images extracted");
        }
    }

    protected getTerminalDisplayText(status: TaskStatus): string {
        if (status === "cancelled") return "Extract Images — Cancelled";
        if (status === "failed") return "Extract Images — Failed";
        const r = this.result;
        if (r && r.failCount > 0) {
            return `Extracted images for ${r.successCount} items (${r.failCount} failed)`;
        }
        return `Extracted images for ${r?.successCount ?? 0} items`;
    }

    /**
     * Extract annotation images for a single parent item.
     * Mirrors `LibraryNoteService.extractAnnotationImages` but operates independently.
     */
    private async extractForItem(item: AnyIDBZoteroItem, forceUpdate: boolean) {
        // Resolve PDF attachments
        let attachments: IDBZoteroItem<AttachmentData>[];

        if (item.itemType === "attachment") {
            attachments = [item];
        } else {
            attachments = (await db.items
                .where({
                    libraryID: item.libraryID,
                    parentItem: item.key,
                    itemType: "attachment",
                })
                .toArray()) as IDBZoteroItem<AttachmentData>[];
        }

        attachments = attachments.filter(
            (a) => a.raw.data.contentType === "application/pdf",
        );

        for (const attachment of attachments) {
            const annotations = await getAnnotationJson(
                attachment,
                this.settings.zoteroapikey,
                (a: IDBZoteroItem<AnnotationData>) => {
                    if (a.syncStatus === "deleted") return false;
                    const isImage =
                        a.raw.data.annotationType === "image" ||
                        a.raw.data.annotationType === "ink";
                    const needsUpdate =
                        !a.annotationImageVersion ||
                        a.version > a.annotationImageVersion ||
                        forceUpdate;
                    return isImage && needsUpdate;
                },
            );

            if (annotations.length === 0) continue;

            const fileBlob =
                await this.attachmentService.getFileBlob(attachment);

            if (fileBlob) {
                const buffer = await fileBlob.arrayBuffer();
                await this.documentWorker.renderAnnotations(
                    item.libraryID,
                    buffer,
                    annotations,
                );
            }
        }
    }

    /**
     * Resolve items from database based on input descriptor.
     */
    private async resolveItems(): Promise<AnyIDBZoteroItem[]> {
        // If specific items are provided, fetch those directly
        if (this.input.items && this.input.items.length > 0) {
            const items: AnyIDBZoteroItem[] = [];
            for (const { libraryID, itemKey } of this.input.items) {
                const item = await db.items.get([libraryID, itemKey]);
                if (item) {
                    items.push(item);
                }
            }
            return items;
        }
        return [];
    }
}
