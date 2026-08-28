import type { AnyIDBZoteroItem, IDBZoteroItem } from "types/db-schema";
import { LibraryTemplateService } from "./library-template";
import { db, getCombinations } from "db/db";
import { Zotero_Item_Types } from "types/zotero-item-const";
import type { ZotFlowSettings } from "settings/types";
import type { AttachmentData } from "types/zotero-item";
import { getAnnotationJson } from "db/annotation";
import type { IParentProxy } from "bridge/types";
import type { AttachmentService } from "./attachment";
import type { DocumentWorkerService } from "./document-worker";
import type { NotePathService } from "./note-path";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import {
    workerClearTimeout,
    workerSetTimeout,
    type WorkerTimeout,
} from "worker/timers";
import {
    extractPersistRegions,
    reinsertPersistRegions,
    type PersistExtract,
} from "utils/persist-regions";

const DEBOUNCE_DELAY = 2000;

/**
 * Update options interface
 */
export interface UpdateOptions {
    forceUpdateContent?: boolean;
    forceUpdateImages?: boolean;
}

/** CRUD service for library (Zotero) item source notes — creates, opens, updates, and manages annotation images. */
export class LibraryNoteService {
    // Debounce map for update operations
    private debouncers: Map<string, WorkerTimeout> = new Map();

    // Notes that gained orphaned persist regions since the last Notice.
    // Aggregated so a template change hitting hundreds of notes in one
    // batch produces a single summary Notice instead of one per note.
    private orphanReports: Map<string, string[]> = new Map();
    private orphanNoticeTimer: WorkerTimeout | null = null;

    constructor(
        private settings: ZotFlowSettings,
        private templateService: LibraryTemplateService,
        private parentHost: IParentProxy,
        private attachmentService: AttachmentService,
        private documentWorker: DocumentWorkerService,
        private notePathService: NotePathService,
    ) {}

    updateSettings(newSettings: ZotFlowSettings) {
        this.settings = newSettings;
        this.templateService.updateSettings(newSettings);
        this.notePathService.updateSettings(newSettings);
    }

    private normalizeTemplatePath(path: string): string {
        const trimmed = path.trim();
        if (!trimmed) return trimmed;
        return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
    }

    /**
     * Clear all pending debounced operations.
     */
    dispose() {
        for (const timer of this.debouncers.values()) {
            workerClearTimeout(timer);
        }
        this.debouncers.clear();
        if (this.orphanNoticeTimer !== null) {
            workerClearTimeout(this.orphanNoticeTimer);
            this.orphanNoticeTimer = null;
        }
    }

    /**
     * Record newly orphaned persist regions for a note and schedule a
     * single debounced summary Notice covering the whole update cycle.
     */
    private reportNewOrphans(path: string, orphanIds: string[]) {
        this.parentHost.log(
            "warn",
            `Persist region(s) orphaned in ${path}: ${orphanIds.join(", ")} — content moved to the "Orphaned persist regions" section`,
            "LibraryNoteService",
        );
        this.orphanReports.set(path, orphanIds);

        if (this.orphanNoticeTimer !== null) {
            workerClearTimeout(this.orphanNoticeTimer);
        }
        this.orphanNoticeTimer = workerSetTimeout(() => {
            this.orphanNoticeTimer = null;
            const noteCount = this.orphanReports.size;
            this.orphanReports.clear();
            if (noteCount === 0) return;
            this.parentHost.notify(
                "warning",
                `${noteCount} note(s) have orphaned persist regions — content was preserved at the bottom of each note (see log)`,
            );
        }, DEBOUNCE_DELAY);
    }

    /**
     * ============================================================
     * Public API
     * ============================================================
     */

    /**
     * Open note (core entry point)
     * Automatically find or create note
     * Smart update content (only update if version is different, unless specified force)
     * Open file in Obsidian
     */
    async openNote(
        libraryID: number,
        key: string,
        options: UpdateOptions = {},
    ) {
        try {
            const path = await this.ensureNote(libraryID, key, options);

            if (path) {
                this.parentHost.log(
                    "debug",
                    `Opening note: ${path}`,
                    "LibraryNoteService",
                );
                await this.parentHost.openFile(path, true);
            }
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.FILE_OPEN_FAILED,
                "LibraryNoteService",
                "Failed to open note",
            );
        }
    }

    /**
     * Trigger update (for background sync or manual refresh)
     * Support immediate execution or debounced execution
     */
    async triggerUpdate(
        libraryID: number,
        key: string,
        options: UpdateOptions = {},
        debounce: boolean = false,
    ) {
        const debounceId = `${libraryID}-${key}`;

        // Clear old timer
        if (this.debouncers.has(debounceId)) {
            workerClearTimeout(this.debouncers.get(debounceId));
            this.debouncers.delete(debounceId);
        }

        // Mode A: Immediate execution
        if (!debounce) {
            try {
                await this.ensureNote(libraryID, key, options);
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.FILE_WRITE_FAILED,
                    "LibraryNoteService",
                    "Immediate update failed",
                );
            }
            return;
        }

        // Mode B: Debounced execution (2 seconds delay)
        const run = async () => {
            this.debouncers.delete(debounceId);
            try {
                await this.ensureNote(libraryID, key, options);
            } catch (e) {
                // Background task should not throw, just log
                this.parentHost.log(
                    "error",
                    `Debounced update failed for ${key}`,
                    "LibraryNoteService",
                    e,
                );
            }
        };
        // The body handles its own failures, so the promise is deliberately
        // not awaited by the timer.
        const timer = workerSetTimeout(() => void run(), DEBOUNCE_DELAY);

        this.debouncers.set(debounceId, timer);
    }

    /**
     * Batch create notes
     * Wraps individual updates in try-catch to ensure batch continuity
     */
    async batchCreateNotes(items: AnyIDBZoteroItem[]) {
        this.parentHost.notify(
            "info",
            `Batch creation started for ${items.length} items.`,
        );

        let successCount = 0;
        let failCount = 0;

        for (const item of items) {
            try {
                // Batch operations do not open files, no debouncing
                await this.triggerUpdate(
                    item.libraryID,
                    item.key,
                    {
                        forceUpdateContent: false,
                        forceUpdateImages: false,
                    },
                    false,
                );
                successCount++;
            } catch (e) {
                this.parentHost.log(
                    "error",
                    `Failed to create note for ${item.key}`,
                    "LibraryNoteService",
                    e,
                );
                failCount++;
            }
        }

        if (failCount > 0) {
            this.parentHost.notify(
                "info",
                `Batch finished: ${successCount} success, ${failCount} failed.`,
            );
        } else {
            this.parentHost.notify(
                "info",
                `Batch creation finished successfully.`,
            );
        }
    }

    /**
     * Purge source notes whose Zotero items have been moved to the trash.
     *
     * Scans every trashed top-level item across the given libraries and, when
     * a matching source note exists in the vault, sends it to the system trash.
     * Idempotent — already-removed notes are skipped, so it is safe to run
     * after every sync.
     *
     * @returns the number of source notes removed.
     */
    async purgeTrashedSourceNotes(libraryIDs: number[]): Promise<number> {
        if (libraryIDs.length === 0) return 0;

        const isValidTopLevel = (type: string) =>
            !(["note", "annotation", "attachment"] as string[]).includes(type);
        const validTopLevelTypeList = Zotero_Item_Types.filter((type) =>
            isValidTopLevel(type),
        );

        const trashedItems = await db.items
            .where(["libraryID", "itemType", "trashed"])
            .anyOf(getCombinations([libraryIDs, validTopLevelTypeList, [1]]))
            .filter((item: AnyIDBZoteroItem) => !item.parentItem)
            .toArray();

        if (trashedItems.length === 0) return 0;

        let purged = 0;

        for (const item of trashedItems) {
            try {
                const path = await this.parentHost.getFileByKey(item.key);
                if (!path) continue;

                // Defensive: only delete a file that is actually this item's
                // source note (matching frontmatter key), never an unrelated file.
                const fileCheck = await this.parentHost.checkFile(path);
                if (
                    fileCheck.exists &&
                    fileCheck.frontmatter?.["zotero-key"] === item.key
                ) {
                    await this.parentHost.deleteFile(path);
                    purged++;
                    this.parentHost.log(
                        "info",
                        `Purged source note for trashed item ${item.key}: ${path}`,
                        "LibraryNoteService",
                    );
                }
            } catch (e) {
                // Best-effort: a single failure must not abort the whole purge.
                this.parentHost.log(
                    "warn",
                    `Failed to purge source note for trashed item ${item.key}`,
                    "LibraryNoteService",
                    e,
                );
            }
        }

        if (purged > 0) {
            this.parentHost.notify(
                "info",
                `Removed ${purged} source note(s) for trashed items.`,
            );
        }

        return purged;
    }

    /**
     * ============================================================
     * Core Logic (Flow Control)
     * ============================================================
     */

    /**
     * Core logic: Ensure note is ready
     * Responsible for routing logic:
     * Index lookup -> Default path fallback -> Existence check -> Create/Update
     */
    async ensureNote(
        libraryID: number,
        key: string,
        options: UpdateOptions,
    ): Promise<string> {
        const { forceUpdateContent = false, forceUpdateImages = false } =
            options;

        // Prepare data
        const item = await db.items.get({ libraryID, key });
        const library = await db.libraries.get({ id: libraryID });

        if (!item || !library) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "LibraryNoteService",
                `Item or Library not found: ${key}`,
            );
        }

        try {
            // Determine path
            // Ask main thread first: which file does this Key correspond to? (Cache lookup)
            let path = await this.parentHost.getFileByKey(key);

            // If Cache lookup fails, resolve path from template
            if (!path) {
                path = await this.notePathService.resolveLibraryNotePath(item);
            }

            // Check physical file status
            const fileCheck = await this.parentHost.checkFile(path);

            if (
                fileCheck.exists &&
                fileCheck.frontmatter?.["zotero-key"] === key
            ) {
                // Case A: File exists -> Try update (version check)
                await this.performUpdate(
                    item,
                    fileCheck,
                    forceUpdateContent,
                    forceUpdateImages,
                );
            } else {
                // Case B: File does not exist or frontmatter is different ->
                // Create new file. The write may land on a suffixed path when
                // the target is taken, so the caller must be told where the
                // note actually went — openNote would otherwise open the file
                // that caused the collision.
                path = await this.performCreate(item, path);

                // Post processing: Extract images (if setting is enabled)
                if (this.settings.autoImportAnnotationImages) {
                    try {
                        await this.extractAnnotationImages(item, true);
                    } catch (imgErr) {
                        // Non-fatal error: Image extraction failed, but note is saved.
                        this.parentHost.log(
                            "warn",
                            `Initial image extraction failed for ${key}`,
                            "LibraryNoteService",
                            imgErr,
                        );
                    }
                }
            }

            return path;
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.DB_WRITE_FAILED,
                "LibraryNoteService",
                `Ensure note failed: ${(e as Error).message}`,
            );
        }
    }

    /**
     * Fast path: guarantee a note file exists and return its path.
     * If the note doesn't exist yet, creates a minimal stub (mandatory frontmatter only)
     * and schedules a debounced background update to render the full content.
     * Use this when only the path is needed (e.g. citation generation).
     */
    async ensureNotePath(libraryID: number, key: string): Promise<string> {
        // Cache hit — file already indexed
        const cached = await this.parentHost.getFileByKey(key);
        if (cached) return cached;

        // Fetch item from DB
        const item = await db.items.get({ libraryID, key });
        if (!item) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "LibraryNoteService",
                `Item not found: ${key}`,
            );
        }

        // Resolve target path
        const targetPath =
            await this.notePathService.resolveLibraryNotePath(item);

        // Check if file already exists
        const fileCheck = await this.parentHost.checkFile(targetPath);
        if (fileCheck.exists && fileCheck.frontmatter?.["zotero-key"] === key) {
            return targetPath;
        }

        // Resolve unique path (handle collision with unrelated files)
        const notePath = fileCheck.exists
            ? await this.resolveUniquePath(targetPath)
            : targetPath;

        // Write stub with mandatory frontmatter only
        const stub = [
            "---",
            "zotflow-locked: true",
            `zotero-key: "${key}"`,
            "item-version: 0",
            `library-id: ${libraryID}`,
            "---",
            "",
        ].join("\n");
        await this.parentHost.writeTextFile(notePath, stub);
        await this.parentHost.indexFile(notePath);

        // Schedule background full render (debounced)
        this.triggerUpdate(libraryID, key, {}, true).catch((e) =>
            this.parentHost.log(
                "error",
                `Background note render failed for ${key}`,
                "LibraryNoteService",
                e,
            ),
        );

        return notePath;
    }

    /**
     * ============================================================
     * Execution Helpers (The Workers)
     * ============================================================
     */

    /**
     * Find a unique file path by appending `(N)` suffixes when the target is already taken.
     */
    private async resolveUniquePath(path: string): Promise<string> {
        let fileCheck = await this.parentHost.checkFile(path);
        if (!fileCheck.exists) return path;

        let notePath = path;
        let counter = 1;
        const maxRetries = 100;
        while (fileCheck.exists && counter < maxRetries) {
            notePath = path.replace(/\.md$/, ` (${counter}).md`);
            fileCheck = await this.parentHost.checkFile(notePath);
            counter++;
        }
        if (counter >= maxRetries) {
            throw new ZotFlowError(
                ZotFlowErrorCode.FILE_WRITE_FAILED,
                "LibraryNoteService",
                "Could not find a unique filename",
            );
        }
        return notePath;
    }

    /**
     * Perform file creation.
     *
     * @returns the path actually written, which differs from `path` when the
     *   target was already taken by an unrelated file.
     */
    private async performCreate(
        item: AnyIDBZoteroItem,
        path: string,
    ): Promise<string> {
        // If file exists but is not our note (collision), create a file with different name
        const notePath = await this.resolveUniquePath(path);

        // Create empty file first
        await this.parentHost.writeTextFile(notePath, "");
        await this.parentHost.indexFile(notePath);

        // Then write content
        const templateContent = await this.parentHost.readTextFile(
            this.normalizeTemplatePath(
                this.settings.librarySourceNoteTemplatePath,
            ),
        );

        // Render Item may throw ZotFlowError (Template Error), let it bubble
        const content = await this.templateService.renderLibrarySourceNote(
            item,
            templateContent,
            {},
        );

        // No old content on create, but still validate the render's persist
        // markers (throws on template errors; a no-op splice otherwise).
        const spliced = reinsertPersistRegions(content, {
            regions: [],
            orphanSectionInner: null,
        });

        await this.parentHost.writeTextFile(notePath, spliced.content);

        return notePath;
    }

    /**
     * Perform file update (with version check)
     */
    private async performUpdate(
        item: AnyIDBZoteroItem,
        fileCheck: Awaited<ReturnType<IParentProxy["checkFile"]>>,
        forceUpdate: boolean,
        forceUpdateImages: boolean,
    ) {
        // Read Frontmatter version from file
        const rawVersion = fileCheck.frontmatter?.["item-version"];
        // Only ever compared against a numeric string, so anything that is not
        // a scalar counts as "no version" and forces the update — which is
        // what a missing or mangled value should do anyway.
        const currentVersion =
            typeof rawVersion === "number" || typeof rawVersion === "string"
                ? String(rawVersion)
                : undefined;
        const newVersion = item.version.toString();

        // Only update if versions are different, or if forced update is specified
        if (forceUpdate || currentVersion !== newVersion) {
            // Persist regions: pull user-owned blocks out of the current
            // file before the full-content overwrite. A parse failure here
            // refuses the update — the file stays untouched until the user
            // repairs the markers.
            const oldContent = await this.parentHost.readTextFile(
                fileCheck.path,
            );
            if (oldContent === null || oldContent === undefined) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.FILE_OPEN_FAILED,
                    "LibraryNoteService",
                    `Could not read ${fileCheck.path} before update — refused to overwrite blindly`,
                );
            }

            let extracted: PersistExtract;
            try {
                extracted = extractPersistRegions(oldContent);
            } catch (e) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.PARSE_ERROR,
                    "LibraryNoteService",
                    `Invalid persist markers in ${fileCheck.path}: ${(e as Error).message}. Update refused until the file is fixed.`,
                    { cause: e, path: fileCheck.path },
                );
            }

            const templateContent = await this.parentHost.readTextFile(
                this.normalizeTemplatePath(
                    this.settings.librarySourceNoteTemplatePath,
                ),
            );

            const content = await this.templateService.renderLibrarySourceNote(
                item,
                templateContent,
                fileCheck.frontmatter || {},
            );

            const spliced = reinsertPersistRegions(content, extracted);

            await this.parentHost.writeTextFile(
                fileCheck.path,
                spliced.content,
            );

            if (spliced.newOrphans.length > 0) {
                this.reportNewOrphans(
                    fileCheck.path,
                    spliced.newOrphans.map((o) => o.id),
                );
            }

            this.parentHost.log(
                "debug",
                `Updated note: ${fileCheck.path} (v${currentVersion} -> v${newVersion})`,
                "LibraryNoteService",
            );

            // Extract images (if setting is enabled)
            if (this.settings.autoImportAnnotationImages) {
                try {
                    await this.extractAnnotationImages(item, forceUpdateImages);
                } catch (imgErr) {
                    throw ZotFlowError.wrap(
                        imgErr,
                        ZotFlowErrorCode.FILE_WRITE_FAILED,
                        "LibraryNoteService",
                        `Image update failed for ${item.key}`,
                    );
                }
            }
        } else {
            // Version is the same, skip writing
        }
    }

    /**
     * Extract images from PDF annotations.
     * Public to allow usage from batch tasks.
     */
    async extractAnnotationImages(
        item: AnyIDBZoteroItem,
        forceUpdateAnnotationImage: boolean,
    ) {
        // Get all PDF attachments
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
            try {
                const annotations = await getAnnotationJson(
                    attachment,
                    this.settings.zoteroapikey,
                    (a) => {
                        if (a.syncStatus === "deleted") return false;
                        const isImage =
                            a.raw.data.annotationType === "image" ||
                            a.raw.data.annotationType === "ink";
                        // Logic: is image annotation && (never rendered || Zotero version updated || forced refresh)
                        const needsUpdate =
                            !a.annotationImageVersion ||
                            a.version > a.annotationImageVersion ||
                            forceUpdateAnnotationImage;
                        return isImage && needsUpdate;
                    },
                );

                if (annotations.length > 0) {
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
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.FILE_WRITE_FAILED,
                    "LibraryNoteService",
                    `Failed to process attachment ${attachment.key}`,
                );
            }
        }
    }

    async saveBase64Image(image: string, annotationKey: string) {
        try {
            const base64 = image.split(",")[1]!;
            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const folder = this.settings.annotationImageFolder.replace(
                /\/$/,
                "",
            );
            const path = `${folder}/${annotationKey}.png`;

            await this.parentHost.writeBinaryFile(path, bytes.buffer);
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.FILE_WRITE_FAILED,
                "LibraryNoteService",
                `Failed to save image ${annotationKey}`,
            );
        }
    }

    async deleteAnnotationImage(annotationKey: string) {
        // Calculate image path
        const filename = `${annotationKey}.png`;
        const folder = this.settings.annotationImageFolder.replace(/\/$/, "");
        const path = `${folder}/${filename}`;

        // Call main thread to delete file
        try {
            const exists = await this.parentHost.checkFile(path);
            if (exists.exists) {
                await this.parentHost.deleteFile(path);
            }
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.FILE_WRITE_FAILED,
                "LibraryNoteService",
                `Failed to delete image ${annotationKey}: ${(e as Error).message}`,
            );
        }
    }
}
