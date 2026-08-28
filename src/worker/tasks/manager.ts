import type { IParentProxy } from "bridge/types";
import type { BaseTask } from "./base";
import type { DownloadedAttachment, ITaskInfo } from "types/tasks";
import type { SyncService } from "worker/services/sync";
import type {
    LibraryNoteService,
    UpdateOptions,
} from "worker/services/library-note";
import type { AttachmentService } from "worker/services/attachment";
import type { ZoteroAPIService } from "worker/services/zotero";
import type { DocumentWorkerService } from "worker/services/document-worker";
import type { ZotFlowSettings } from "settings/types";
import type { BatchNoteInput } from "./impl/batch-note-task";
import type { BatchExtractImagesInput } from "./impl/batch-extract-images-task";
import type { BatchExtractExternalAnnotationsInput } from "./impl/batch-extract-external-annotations-task";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";

/** Registers, starts, and cancels background tasks; routes lifecycle events to the main thread. */
export class TaskManager {
    private tasks: Map<string, BaseTask> = new Map();
    private activeControllers: Map<string, AbortController> = new Map();
    private activeExtractions = new Map<string, Promise<AnnotationJSON[]>>();
    /**
     * Tracks in-flight sync tasks so we can dedupe overlapping requests for
     * the same library. Different libraries sync independently (separate
     * library-scoped DB rows and API endpoints), so they can run in parallel.
     *
     * Key: `libraryId` (number) for per-library syncs, `"all"` for full syncs.
     */
    private activeSyncs = new Map<number | "all", string>();
    /** In-flight csljson backfill task id — always all-libraries, so at most one. */
    private activeCslBackfill?: string;

    constructor(private parentHost: IParentProxy) {}

    public registerTask(task: BaseTask) {
        // cleanup old tasks (simple policy: keep max 50)
        if (this.tasks.size > 50) {
            // Destructured rather than `.next().value`, whose `IteratorResult`
            // return slot is typed `any`.
            const [oldest] = this.tasks.keys();
            if (oldest) this.tasks.delete(oldest);
        }

        this.tasks.set(task.id, task);

        // Bind update
        task.onUpdate = (info: ITaskInfo) => {
            this.parentHost.onTaskUpdate(task.id, info);
        };

        // Initial update
        this.parentHost.onTaskUpdate(task.id, task.getInfo());
    }

    public async startTask(task: BaseTask) {
        this.registerTask(task);

        const controller = new AbortController();
        this.activeControllers.set(task.id, controller);

        // Run without awaiting (fire and forget from manager perspective)
        // Fire and forget by design; the task layer records its own outcome.
        void task.execute(controller.signal).finally(() => {
            this.activeControllers.delete(task.id);
        });

        return task.id;
    }

    public cancelTask(taskId: string) {
        const controller = this.activeControllers.get(taskId);
        if (controller) {
            controller.abort();
        }
    }

    /* ================================================================ */
    /*  Factory methods (dynamic imports to avoid circular deps)        */
    /* ================================================================ */

    public async createTestTask(duration: number) {
        const { TestTask } = await import("./impl/test-task");
        const task = new TestTask(this.parentHost, duration);
        return this.startTask(task);
    }

    public async createSyncTask(
        syncService: SyncService,
        libraryId?: number,
        libraryNoteService?: LibraryNoteService,
        settings?: ZotFlowSettings,
    ) {
        const scope: number | "all" = libraryId ?? "all";
        const existing = this.activeSyncs.get(scope);
        if (existing) {
            this.parentHost.log(
                "info",
                `Sync for ${scope === "all" ? "all libraries" : `library ${scope}`} already in progress; reusing task ${existing}.`,
                "TaskManager",
            );
            return existing;
        }

        const { SyncTask } = await import("./impl/sync-task");
        const task = new SyncTask(
            this.parentHost,
            syncService,
            libraryId,
            this,
            libraryNoteService,
            settings,
        );
        this.activeSyncs.set(scope, task.id);

        this.registerTask(task);

        const controller = new AbortController();
        this.activeControllers.set(task.id, controller);

        // Fire and forget by design; the task layer records its own outcome.
        void task.execute(controller.signal).finally(() => {
            this.activeControllers.delete(task.id);
            this.activeSyncs.delete(scope);
        });

        return task.id;
    }

    /** Refetch and store the CSL-JSON payload for every citable item. */
    public async createBackfillCslJsonTask(zotero: ZoteroAPIService) {
        if (this.activeCslBackfill) {
            this.parentHost.log(
                "info",
                `CSL data update already in progress; reusing task ${this.activeCslBackfill}.`,
                "TaskManager",
            );
            return this.activeCslBackfill;
        }

        const { BackfillCslJsonTask } =
            await import("./impl/backfill-csljson-task");
        const task = new BackfillCslJsonTask(this.parentHost, zotero);
        this.activeCslBackfill = task.id;

        this.registerTask(task);

        const controller = new AbortController();
        this.activeControllers.set(task.id, controller);

        void task.execute(controller.signal).finally(() => {
            this.activeControllers.delete(task.id);
            this.activeCslBackfill = undefined;
        });

        return task.id;
    }

    public async createBatchNoteTask(
        noteService: LibraryNoteService,
        input: BatchNoteInput,
        options: UpdateOptions,
        isUpdate: boolean,
    ) {
        const { BatchNoteTask } = await import("./impl/batch-note-task");
        const type = isUpdate ? "batch-update-notes" : "batch-create-notes";
        const task = new BatchNoteTask(
            this.parentHost,
            noteService,
            input,
            options,
            type,
        );
        return this.startTask(task);
    }

    public async createBatchExtractImagesTask(
        attachmentService: AttachmentService,
        documentWorker: DocumentWorkerService,
        settings: ZotFlowSettings,
        input: BatchExtractImagesInput,
    ) {
        const { BatchExtractImagesTask } =
            await import("./impl/batch-extract-images-task");
        const task = new BatchExtractImagesTask(
            this.parentHost,
            attachmentService,
            documentWorker,
            settings,
            input,
        );
        return this.startTask(task);
    }

    /**
     * Create a download attachment task that tracks progress.
     * Returns a promise that resolves with the downloaded Blob.
     */
    public async createDownloadAttachmentTask(
        attachmentService: AttachmentService,
        attachmentItem: IDBZoteroItem<AttachmentData>,
    ): Promise<DownloadedAttachment> {
        const startedAt = Date.now();
        this.parentHost.log(
            "debug",
            "Creating download attachment task.",
            "TaskManager",
            {
                libraryID: attachmentItem.libraryID,
                itemKey: attachmentItem.key,
                filename: attachmentItem.raw.data.filename,
            },
        );
        const { DownloadAttachmentTask } =
            await import("./impl/download-attachment-task");
        const task = new DownloadAttachmentTask(
            this.parentHost,
            attachmentService,
            attachmentItem,
        );

        this.registerTask(task);

        const controller = new AbortController();
        this.activeControllers.set(task.id, controller);
        this.parentHost.log(
            "debug",
            "Download attachment task registered and controller created.",
            "TaskManager",
            {
                taskId: task.id,
                itemKey: attachmentItem.key,
                activeControllers: this.activeControllers.size,
            },
        );

        try {
            this.parentHost.log(
                "debug",
                "Executing download attachment task.",
                "TaskManager",
                {
                    taskId: task.id,
                    itemKey: attachmentItem.key,
                },
            );
            await task.execute(controller.signal);

            const result = task.takeResult();
            if (!result) {
                throw new Error(`Download failed for ${attachmentItem.key}`);
            }
            this.parentHost.log(
                "debug",
                "Download attachment task completed successfully.",
                "TaskManager",
                {
                    taskId: task.id,
                    itemKey: attachmentItem.key,
                    blobBytes: result.blob.size,
                    elapsedMs: Date.now() - startedAt,
                },
            );
            return result;
        } catch (e) {
            this.parentHost.log(
                "debug",
                "Download attachment task failed.",
                "TaskManager",
                {
                    taskId: task.id,
                    itemKey: attachmentItem.key,
                    elapsedMs: Date.now() - startedAt,
                    errorMessage: e instanceof Error ? e.message : String(e),
                },
            );
            throw e;
        } finally {
            this.activeControllers.delete(task.id);
            this.parentHost.log(
                "debug",
                "Download attachment task controller removed.",
                "TaskManager",
                {
                    taskId: task.id,
                    itemKey: attachmentItem.key,
                    activeControllers: this.activeControllers.size,
                },
            );
        }
    }

    /**
     * Create a batch extract external annotations task.
     * Returns a promise that resolves with the extracted AnnotationJSON[].
     */
    public async createBatchExtractExternalAnnotationsTask(
        attachmentService: AttachmentService,
        documentWorker: DocumentWorkerService,
        noteService: LibraryNoteService,
        input: BatchExtractExternalAnnotationsInput,
    ): Promise<AnnotationJSON[]> {
        // Dedup: if all requested items already have in-flight extractions,
        // return the existing promises instead of creating a new task.
        const keys = input.items.map((i) => `${i.libraryID}:${i.itemKey}`);
        const allInFlight = keys.every((k) => this.activeExtractions.has(k));
        if (allInFlight && keys.length > 0) {
            const results = await Promise.all(
                keys.map((k) => this.activeExtractions.get(k)!),
            );
            return results.flat();
        }

        const { BatchExtractExternalAnnotationsTask } =
            await import("./impl/batch-extract-external-annotations-task");
        const task = new BatchExtractExternalAnnotationsTask(
            this.parentHost,
            attachmentService,
            documentWorker,
            noteService,
            input,
        );

        this.registerTask(task);

        const controller = new AbortController();
        this.activeControllers.set(task.id, controller);

        const promise = task.execute(controller.signal).then(() => {
            return task.getExtractedAnnotations();
        });

        // Register each item key as in-flight
        for (const key of keys) {
            this.activeExtractions.set(key, promise);
        }

        try {
            return await promise;
        } finally {
            this.activeControllers.delete(task.id);
            for (const key of keys) {
                this.activeExtractions.delete(key);
            }
        }
    }

    public getTasks(): ITaskInfo[] {
        return Array.from(this.tasks.values()).map((t) => t.getInfo());
    }
}
