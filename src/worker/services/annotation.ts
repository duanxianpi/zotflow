import { db, getCombinations } from "db/db";
import { annotationItemFromJSON, getAnnotationJson } from "db/annotation";
import {
    createLocalItems,
    deleteLocalItems,
    mutateItem,
    mutateItems,
    newLocalItem,
} from "db/mutate";
import { toZoteroDate } from "db/normalize";

import type { IParentProxy } from "bridge/types";
import type { LibraryNoteService } from "./library-note";
import type { ConvertService } from "./convert";
import type { IDBZoteroItem, IDBZoteroKey } from "types/db-schema";
import type { AnnotationData, AttachmentData } from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";

/** Result returned by saveAnnotations so the caller knows whether a note update is needed. */
export interface SaveAnnotationsResult {
    hasChanges: boolean;
}

/**
 * Worker-side service for reader annotation CRUD.
 * Replaces all direct `db` access that was previously in the main-thread
 * `ZoteroReaderView` and `IframeReaderBridge`.
 */
export class AnnotationService {
    constructor(
        private noteService: LibraryNoteService,
        private parentHost: IParentProxy,
        private convertService: ConvertService,
    ) {}

    /* ================================================================ */
    /*  Queries (read-only)                                            */
    /* ================================================================ */

    /** Resolve the API key record from IDB. */
    async getKeyInfo(apiKey: string): Promise<IDBZoteroKey | undefined> {
        return db.keys.get(apiKey);
    }

    /**
     * Build the annotation JSON array the reader iframe expects.
     * Wraps `getAnnotationJson` from `db/annotation.ts` so the main thread
     * never needs to import Dexie.
     */
    async getAnnotations(
        attachmentItem: IDBZoteroItem<AttachmentData>,
        apiKey: string,
    ): Promise<AnnotationJSON[]> {
        return getAnnotationJson(attachmentItem, apiKey);
    }

    /**
     * Return all annotations across all child attachments of a parent item.
     * Used by the template preview UI for citation annotation context.
     */
    async getAllItemAnnotations(
        libraryID: number,
        itemKey: string,
        apiKey: string,
    ): Promise<AnnotationJSON[]> {
        const children = await db.items
            .where(["libraryID", "parentItem", "itemType", "trashed"])
            .equals([libraryID, itemKey, "attachment", 0])
            .toArray();

        const results: AnnotationJSON[] = [];
        for (const child of children) {
            const annots = await getAnnotationJson(child, apiKey);
            results.push(...annots);
        }
        return results;
    }

    /* ================================================================ */
    /*  Mutations                                                      */
    /* ================================================================ */

    /**
     * Process annotations saved/updated from the reader iframe.
     * Handles create-vs-update logic, image persistence, and triggers
     * source-note updates via `LibraryNoteService`.
     *
     * This method replaces `ZoteroReaderView.handleAnnotationsSaved`.
     */
    async saveAnnotations(
        attachmentItem: IDBZoteroItem<AttachmentData>,
        keyInfo: IDBZoteroKey,
        annotations: AnnotationJSON[],
    ): Promise<SaveAnnotationsResult> {
        const { libraryID, parentItem: paperKey } = attachmentItem;
        const library = attachmentItem.raw.library;
        const attachmentKey = attachmentItem.key;

        let hasChanges = false;
        const itemsToCreate: IDBZoteroItem<AnnotationData>[] = [];
        const edits: { key: string; data: Partial<AnnotationData> }[] = [];

        // Fetch existing synced (non-local-only) annotations
        const existingItems = (
            await db.items
                .where({
                    libraryID,
                    parentItem: attachmentKey,
                    itemType: "annotation",
                })
                .toArray()
        ).filter((i) => !i.localOnly) as IDBZoteroItem<AnnotationData>[];

        const existingMap = new Map(existingItems.map((i) => [i.key, i]));

        const zoteroDate = toZoteroDate(new Date().toISOString());

        for (const json of annotations) {
            const annotationData = annotationItemFromJSON(
                json,
            );
            const key = json.id;
            const existing = existingMap.get(key);
            const isVisual =
                annotationData.annotationType === "image" ||
                annotationData.annotationType === "ink";

            // Persist annotation image (fire & forget)
            if (isVisual && json.image) {
                this.noteService
                    .saveBase64Image(json.image, key)
                    .catch((e) => {
                        this.parentHost.log(
                            "error",
                            `Failed to save annotation image for ${key}`,
                            "AnnotationService",
                            e,
                        );
                        this.parentHost.notify(
                            "error",
                            `Failed to save annotation image for ${key}`,
                        );
                    });
            }

            if (existing) {
                // === Update ===
                if (!json.isExternal) {
                    if (
                        this.annotationDataDiff(
                            existing.raw.data,
                            annotationData,
                        )
                    ) {
                        hasChanges = true;
                        edits.push({ key, data: annotationData });
                    }
                }
            } else {
                // === Create ===
                hasChanges = true;
                const newItem: IDBZoteroItem<AnnotationData> = {
                    ...newLocalItem(
                        {
                            key,
                            version: 0,
                            library,
                            links: {},
                            meta: { numChildren: 0 },
                            data: {
                                ...annotationData,
                                key,
                                itemType: "annotation",
                                parentItem: attachmentKey,
                                relations: {},
                                dateAdded: zoteroDate,
                                dateModified: zoteroDate,
                                tags: annotationData.tags || [],
                                deleted: false,
                                version: 0,
                            } as unknown as AnnotationData,
                        },
                        libraryID,
                        json.isExternal ? "local-only" : "push",
                    ),
                    annotationImageVersion: 1,
                };

                if (library.type === "group" && keyInfo) {
                    newItem.raw.meta.createdByUser = {
                        id: keyInfo.userID,
                        name: keyInfo.displayName,
                        username: keyInfo.username,
                        links: {},
                    };
                }

                itemsToCreate.push(newItem);
            }
        }

        // Batch write: edits re-read each row in the write transaction.
        await createLocalItems(
            libraryID,
            itemsToCreate,
        );
        const written = await mutateItems(
            libraryID,
            edits.map(({ key, data }) => ({
                key,
                itemType: "annotation",
                edit: (d) => {
                    Object.assign(d, data);
                },
            })),
        );
        written.forEach((row, i) => {
            if (!row) {
                this.parentHost.log(
                    "warn",
                    `Annotation ${edits[i]!.key} was deleted in Zotero; the edit was not saved`,
                    "AnnotationService",
                );
            }
        });
        if (written.some((row) => !row)) {
            this.parentHost.notify(
                "warning",
                "An annotation you edited was deleted in Zotero meanwhile.",
            );
        }

        // Trigger source-note update (debounced, fire & forget)
        if (hasChanges) {
            this.parentHost.log(
                "debug",
                `Triggering update for note: ${paperKey}`,
                "AnnotationService",
            );
            this.noteService
                .triggerUpdate(
                    libraryID,
                    paperKey !== "" ? paperKey : attachmentKey,
                    { forceUpdateContent: true, forceUpdateImages: false },
                    true,
                )
                .catch((e) => {
                    this.parentHost.log(
                        "error",
                        "Failed to trigger note update after annotation save",
                        "AnnotationService",
                        e,
                    );
                    this.parentHost.notify(
                        "error",
                        "Failed to trigger note update after annotation save",
                    );
                });
        }

        return { hasChanges };
    }

    /**
     * Delete annotations: the rows go at once, and those Zotero has are
     * queued for a DELETE (see `deleteLocalItems`). Triggers a source-note
     * update afterwards.
     *
     * This method replaces `ZoteroReaderView.handleAnnotationsDeleted`.
     */
    async deleteAnnotations(
        attachmentItem: IDBZoteroItem<AttachmentData>,
        ids: string[],
    ): Promise<void> {
        const { libraryID } = attachmentItem;
        const paperKey = attachmentItem.parentItem;

        if (!ids.length) return;

        this.parentHost.log(
            "debug",
            `Handling deleted annotations: ${ids.join(", ")}`,
            "AnnotationService",
        );

        const items = (await db.items
            .where(["libraryID", "key"])
            .anyOf(getCombinations([[libraryID], ids]))
            .toArray()) as IDBZoteroItem<AnnotationData>[];

        this.parentHost.log(
            "debug",
            `Found ${items.length} annotations to delete`,
            "AnnotationService",
        );

        // Remove rendered images.
        const foundKeys = new Set(items.map((i) => i.key));
        const deleteImage = (key: string) =>
            this.noteService.deleteAnnotationImage(key).catch((e) => {
                this.parentHost.log(
                    "error",
                    `Failed to delete annotation image for ${key}`,
                    "AnnotationService",
                    e,
                );
            });

        for (const existing of items) {
            const isVisual =
                existing.raw.data.annotationType === "image" ||
                existing.raw.data.annotationType === "ink";
            if (isVisual) void deleteImage(existing.key);
        }
        for (const id of ids) {
            if (!foundKeys.has(id)) void deleteImage(id);
        }

        // Annotations are hard-deleted: the row goes now, the delete log
        // carries the DELETE to Zotero.
        await deleteLocalItems(
            libraryID,
            items.map((i) => i.key),
        );

        // Trigger source-note update
        this.noteService
            .triggerUpdate(
                libraryID,
                paperKey !== "" ? paperKey : attachmentItem.key,
                { forceUpdateContent: true },
                true,
            )
            .catch((e) => {
                this.parentHost.log(
                    "error",
                    "Failed to trigger note update after annotation delete",
                    "AnnotationService",
                    e,
                );
                this.parentHost.notify(
                    "error",
                    "Failed to trigger note update after annotation delete",
                );
            });
    }

    /**
     * Update only the comment field of an existing annotation.
     * Called from the editable-region sync plugin when an ANNO region is edited.
     *
     * The incoming `markdownComment` is markdown (bold/italic/sub/sup) that
     * gets converted to the restricted HTML subset the Zotero annotation
     * format supports (`<b>`, `<i>`, `<sub>`, `<sup>`).
     */
    async updateAnnotationComment(
        libraryID: number,
        annotationKey: string,
        markdownComment: string,
    ): Promise<void> {
        const item = await db.items.get([libraryID, annotationKey]);

        if (!item || item.itemType !== "annotation") {
            this.parentHost.log(
                "warn",
                `updateAnnotationComment: item ${annotationKey} not found or not an annotation`,
                "AnnotationService",
            );
            return;
        }

        const annotation = item;

        // External annotations (extracted from the embedded PDF) are
        // read-only — they are owned by the PDF, not by Zotero, and any
        // re-extraction would overwrite local edits.  Ignore edit-wrapper
        // writes for them.
        if (annotation.raw.data.annotationIsExternal === true) {
            this.parentHost.log(
                "debug",
                `updateAnnotationComment: skipping external annotation ${annotationKey}`,
                "AnnotationService",
            );
            return;
        }

        const newComment = this.convertService.annoMd2html(markdownComment);

        // Skip write if comment hasn't changed
        if (annotation.raw.data.annotationComment === newComment) return;

        const updated = await mutateItem(
            libraryID,
            annotationKey,
            "annotation",
            (data) => {
                data.annotationComment = newComment;
            },
        );
        if (!updated) {
            // Deleted (here or in Zotero) while the comment was being edited.
            this.parentHost.log(
                "warn",
                `updateAnnotationComment: annotation ${annotationKey} was deleted during the edit`,
                "AnnotationService",
            );
            this.parentHost.notify(
                "warning",
                "This annotation was deleted in Zotero; the comment was not saved.",
            );
            return;
        }

        this.parentHost.log(
            "debug",
            `Updated annotation comment for ${annotationKey}`,
            "AnnotationService",
        );

        this.parentHost.emit(
            "annotationChanged",
            libraryID,
            annotationKey,
            annotation.parentItem,
        );
    }

    /* ================================================================ */
    /*  Private helpers                                                */
    /* ================================================================ */

    private annotationDataDiff(
        existing: AnnotationData,
        annotationData: Partial<AnnotationData>,
    ): boolean {
        return (
            existing.annotationComment !== annotationData.annotationComment ||
            existing.annotationColor !== annotationData.annotationColor ||
            existing.annotationPageLabel !==
                annotationData.annotationPageLabel ||
            existing.annotationPosition !== annotationData.annotationPosition ||
            existing.annotationSortIndex !==
                annotationData.annotationSortIndex ||
            existing.annotationText !== annotationData.annotationText ||
            existing.annotationType !== annotationData.annotationType ||
            this.tagsSignature(existing.tags) !==
                this.tagsSignature(annotationData.tags)
        );
    }

    /**
     * Build an order-independent signature of a tag list so two lists with the
     * same tags in a different order compare equal.
     */
    private tagsSignature(
        tags?: Array<{ tag: string; type?: number }>,
    ): string {
        return JSON.stringify(
            (tags ?? [])
                .map((t) => ({ tag: t.tag, type: t.type ?? 0 }))
                .sort((a, b) => a.tag.localeCompare(b.tag)),
        );
    }
}
