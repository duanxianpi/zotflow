import { db, getCombinations } from "db/db";
import { annotationItemFromJSON, getAnnotationJson } from "db/annotation";
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
        return getAnnotationJson(
            attachmentItem,
            apiKey,
            (item) => item.syncStatus !== "deleted",
        );
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
            const annots = await getAnnotationJson(
                child,
                apiKey,
                (item) => item.syncStatus !== "deleted",
            );
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
        const itemsToPut: IDBZoteroItem<AnnotationData>[] = [];

        // Fetch existing non-deleted, non-ignored annotations
        const existingItems = (
            await db.items
                .where({
                    libraryID,
                    parentItem: attachmentKey,
                    itemType: "annotation",
                })
                .toArray()
        ).filter(
            (i) => i.syncStatus !== "deleted" && i.syncStatus !== "ignore",
        ) as IDBZoteroItem<AnnotationData>[];

        const existingMap = new Map(existingItems.map((i) => [i.key, i]));

        const now = new Date().toISOString().split(".")[0] + "Z";
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
                        const newSyncStatus =
                            existing.syncStatus === "created"
                                ? "created"
                                : "updated";

                        itemsToPut.push({
                            ...existing,
                            syncStatus: newSyncStatus,
                            dateModified: now,
                            raw: {
                                ...existing.raw,
                                data: {
                                    ...existing.raw.data,
                                    ...annotationData,
                                    dateModified: zoteroDate,
                                },
                            },
                        });
                    }
                }
            } else {
                // === Create ===
                hasChanges = true;
                const newItem: IDBZoteroItem<AnnotationData> = {
                    libraryID,
                    key,
                    itemType: "annotation",
                    parentItem: attachmentKey,
                    title: "",
                    collections: [],
                    dateAdded: now,
                    dateModified: now,
                    version: 0,
                    trashed: 0,
                    searchCreators: [],
                    searchTags: [],
                    syncStatus: !json.isExternal
                        ? "created"
                        : "ignore",
                    syncedAt: now,
                    syncError: "",
                    annotationImageVersion: 1,
                    raw: {
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
                };

                if (library.type === "group" && keyInfo) {
                    newItem.raw.meta.createdByUser = {
                        id: keyInfo.userID,
                        name: keyInfo.displayName,
                        username: keyInfo.username,
                        links: {},
                    };
                }

                itemsToPut.push(newItem);
            }
        }

        // Batch write
        if (itemsToPut.length > 0) {
            await db.transaction("rw", db.items, async () => {
                await db.items.bulkPut(itemsToPut);
            });
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
     * Delete annotations from IDB (soft-delete for synced, hard-delete for
     * locally-created ones). Triggers source-note update afterwards.
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

        const itemsToDeletePhysical: [number, string][] = [];
        const itemsToDeleteSoft: IDBZoteroItem<AnnotationData>[] = [];
        const now = new Date().toISOString().split(".")[0] + "Z";

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

        for (const existing of items) {
            if (existing.syncStatus === "created") {
                itemsToDeletePhysical.push([libraryID, existing.key]);
            } else {
                itemsToDeleteSoft.push({
                    ...existing,
                    syncStatus: "deleted",
                    dateModified: now,
                    raw: {
                        ...existing.raw,
                        data: {
                            ...existing.raw.data,
                            deleted: true,
                        },
                    },
                });
            }
        }

        // Batch write
        if (itemsToDeletePhysical.length > 0 || itemsToDeleteSoft.length > 0) {
            await db.transaction("rw", db.items, async () => {
                if (itemsToDeletePhysical.length > 0) {
                    await db.items.bulkDelete(itemsToDeletePhysical);
                }
                if (itemsToDeleteSoft.length > 0) {
                    await db.items.bulkPut(itemsToDeleteSoft);
                }
            });
        }

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

        const updatedRaw = structuredClone(annotation.raw);
        (updatedRaw.data).annotationComment = newComment;

        const now = new Date().toISOString();
        await db.items.update([libraryID, annotationKey], {
            raw: updatedRaw,
            syncStatus:
                annotation.syncStatus === "created" ? "created" : "updated",
            dateModified: now,
        });

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
