import * as Comlink from "comlink";
import workerCode from "virtual:worker";
import { ParentHost } from "./parent-host";
import { getBlobUrls } from "bundle-assets/inline-assets";

import type { EnhancementResourceService } from "worker/services/enhancement-resources";
import type { WorkerAPI } from "worker/worker";
import type { TaskManager } from "worker/tasks/manager";
import type { ZotFlowSettings } from "settings/types";
import type { AttachmentService } from "worker/services/attachment";
import type { SyncService } from "worker/services/sync";
import type { ZoteroAPIService } from "worker/services/zotero";
import type { WebDavService } from "worker/services/webdav";
import type { TreeViewService } from "worker/services/tree-view";
import type {
    LibraryNoteService,
    UpdateOptions,
} from "worker/services/library-note";
import type { ItemNoteService } from "worker/services/item-note";
import type { EditQueue } from "worker/services/edit-queue";
import type { LocalNoteService } from "worker/services/local-note";
import type { ConflictService } from "worker/services/conflict";
import type { AnnotationService } from "worker/services/annotation";
import type { KeyService } from "worker/services/key";
import type { LibraryService } from "worker/services/library";
import type { DbHelperService } from "worker/services/db-helper";
import type { SearchService } from "worker/services/search";
import type { DisplayTitleService } from "worker/services/display-title";
import type { TagService } from "worker/services/tag";
import type { DocumentWorkerService } from "worker/services/document-worker";
import type { LibraryTemplateService } from "worker/services/library-template";
import type { LocalTemplateService } from "worker/services/local-template";
import type { NotePathService } from "worker/services/note-path";
import type { CslRenderWorkerService } from "worker/services/csl-render";
import type { BatchNoteInput } from "worker/tasks/impl/batch-note-task";
import type { BatchExtractImagesInput } from "worker/tasks/impl/batch-extract-images-task";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";
import type { DownloadedAttachment } from "types/tasks";

import type { App } from "obsidian";
import type { AttachmentIdentifier } from "worker/tasks/impl/batch-extract-external-annotations-task";

import { services } from "services/services";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

/** Comlink-based RPC wrapper managing the Web Worker lifecycle and exposing all worker service proxies. */
export class WorkerBridge {
    private _worker: Worker;

    private _api: Comlink.Remote<WorkerAPI>;

    private _attachment: Comlink.Remote<AttachmentService>;
    private _sync: Comlink.Remote<SyncService>;
    private _zotero: Comlink.Remote<ZoteroAPIService>;
    private _webdav: Comlink.Remote<WebDavService>;
    private _treeView: Comlink.Remote<TreeViewService>;
    private _libraryNote: Comlink.Remote<LibraryNoteService>;
    private _itemNote: Comlink.Remote<ItemNoteService>;
    private _editQueue: Comlink.Remote<EditQueue>;
    private _localNote: Comlink.Remote<LocalNoteService>;
    private _conflict: Comlink.Remote<ConflictService>;
    private _annotation: Comlink.Remote<AnnotationService>;
    private _key: Comlink.Remote<KeyService>;
    private _library: Comlink.Remote<LibraryService>;
    private _dbHelper: Comlink.Remote<DbHelperService>;
    private _search: Comlink.Remote<SearchService>;
    private _displayTitle: Comlink.Remote<DisplayTitleService>;
    private _tag: Comlink.Remote<TagService>;
    private _documentWorker: Comlink.Remote<DocumentWorkerService>;
    private _enhancementResources: Comlink.Remote<EnhancementResourceService>;
    private _libraryTemplate: Comlink.Remote<LibraryTemplateService>;
    private _localTemplate: Comlink.Remote<LocalTemplateService>;
    private _notePath: Comlink.Remote<NotePathService>;
    private _cslRender: Comlink.Remote<CslRenderWorkerService>;
    private _tasks: Comlink.Remote<TaskManager>;

    private _parentHost: ParentHost;

    private _workerBlobUrl: string;
    private _initialized = false;

    constructor() {
        // Create a blob from the inlined worker code
        const blob = new Blob([workerCode], { type: "application/javascript" });
        this._workerBlobUrl = URL.createObjectURL(blob);

        this._worker = new Worker(this._workerBlobUrl);
        this._api = Comlink.wrap<WorkerAPI>(this._worker);
    }

    async initialize(settings: ZotFlowSettings, app: App) {
        const proxyTimings: Record<string, number> = {};
        const materializeComlinkProxy = async <T>(
            name: string,
            proxy: T,
        ): Promise<Awaited<T>> => {
            const started = performance.now();
            try {
                return await Promise.resolve(proxy);
            } finally {
                proxyTimings[name] = Number(
                    (performance.now() - started).toFixed(2),
                );
            }
        };
        let stageStarted = performance.now();
        // These timings are nested within Startup's worker bridge stage.
        const finishStage = (stage: string) => {
            const finished = performance.now();
            services.logService.debug(stage, "WorkerBridge", {
                durationMs: Number((finished - stageStarted).toFixed(2)),
            });
            stageStarted = finished;
        };
        // Worker settings update / initialization
        const blobUrls = getBlobUrls((details) =>
            services.logService.debug(
                "Reader resource preparation breakdown",
                "WorkerBridge",
                details,
            ),
        );
        finishStage("Prepare bundled Reader resource URLs");
        this._parentHost = new ParentHost(app);
        await this._api.init(
            settings,
            Comlink.proxy(this._parentHost),
            blobUrls,
        );
        finishStage("Wait for worker initialization");

        // Promise.resolve performs the same thenable assimilation as `await`.
        // Comlink's runtime `then` trap materialises each dedicated MessagePort,
        // although its TypeScript types do not expose that thenable shape.
        this._attachment = await materializeComlinkProxy(
            "attachment",
            this._api.attachment,
        );
        this._sync = await materializeComlinkProxy("sync", this._api.sync);
        this._zotero = await materializeComlinkProxy(
            "zotero",
            this._api.zotero,
        );
        this._webdav = await materializeComlinkProxy(
            "webdav",
            this._api.webdav,
        );
        this._treeView = await materializeComlinkProxy(
            "treeView",
            this._api.treeView,
        );
        this._libraryNote = await materializeComlinkProxy(
            "libraryNote",
            this._api.libraryNote,
        );
        this._itemNote = await materializeComlinkProxy(
            "itemNote",
            this._api.itemNote,
        );
        this._editQueue = await materializeComlinkProxy(
            "editQueue",
            this._api.editQueue,
        );
        this._localNote = await materializeComlinkProxy(
            "localNote",
            this._api.localNote,
        );
        this._conflict = await materializeComlinkProxy(
            "conflict",
            this._api.conflict,
        );
        this._annotation = await materializeComlinkProxy(
            "annotation",
            this._api.annotation,
        );
        this._key = await materializeComlinkProxy("key", this._api.key);
        this._library = await materializeComlinkProxy(
            "library",
            this._api.library,
        );
        this._dbHelper = await materializeComlinkProxy(
            "dbHelper",
            this._api.dbHelper,
        );
        this._search = await materializeComlinkProxy(
            "search",
            this._api.search,
        );
        this._displayTitle = await materializeComlinkProxy(
            "displayTitle",
            this._api.displayTitle,
        );
        this._tag = await materializeComlinkProxy("tag", this._api.tag);
        this._enhancementResources = await materializeComlinkProxy(
            "enhancementResources",
            this._api.enhancementResources,
        );
        this._documentWorker = await materializeComlinkProxy(
            "documentWorker",
            this._api.documentWorker,
        );
        this._libraryTemplate = await materializeComlinkProxy(
            "libraryTemplate",
            this._api.libraryTemplate,
        );
        this._localTemplate = await materializeComlinkProxy(
            "localTemplate",
            this._api.localTemplate,
        );
        this._notePath = await materializeComlinkProxy(
            "notePath",
            this._api.notePath,
        );
        this._cslRender = await materializeComlinkProxy(
            "cslRender",
            this._api.cslRender,
        );
        this._tasks = await materializeComlinkProxy("tasks", this._api.tasks);
        finishStage("Connect worker service proxies");
        // One record avoids inserting a log operation between every RPC round trip.
        services.logService.debug(
            "Service proxy connection breakdown",
            "WorkerBridge",
            {
                serviceDurationMs: proxyTimings,
            },
        );

        this._initialized = true;
        // Native Worker failure supplies no RPC responses. Settle resource waiters locally.
        this._worker.addEventListener("error", () =>
            services.enhancementPack.dispose(),
        );
        this._worker.addEventListener("messageerror", () =>
            services.enhancementPack.dispose(),
        );
        services.logService.log(
            "info",
            "Worker Client initialized.",
            "WorkerBridge",
        );
    }

    private assertInitialized(): void {
        if (!this._initialized) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "WorkerBridge",
                "WorkerBridge not initialized. Call initialize() first.",
            );
        }
    }

    get attachment() {
        this.assertInitialized();
        return this._attachment;
    }

    get sync() {
        this.assertInitialized();
        return this._sync;
    }

    get zotero() {
        this.assertInitialized();
        return this._zotero;
    }

    get webdav() {
        this.assertInitialized();
        return this._webdav;
    }

    get treeView() {
        this.assertInitialized();
        return this._treeView;
    }

    get libraryNote() {
        this.assertInitialized();
        return this._libraryNote;
    }

    get itemNote() {
        this.assertInitialized();
        return this._itemNote;
    }

    /** Edits typed into source notes and the note editor, written by the worker (see EditQueue). */
    get editQueue() {
        this.assertInitialized();
        return this._editQueue;
    }

    get localNote() {
        this.assertInitialized();
        return this._localNote;
    }

    get conflict() {
        this.assertInitialized();
        return this._conflict;
    }

    get annotation() {
        this.assertInitialized();
        return this._annotation;
    }

    get key() {
        this.assertInitialized();
        return this._key;
    }

    get library() {
        this.assertInitialized();
        return this._library;
    }

    get dbHelper() {
        this.assertInitialized();
        return this._dbHelper;
    }

    get search() {
        this.assertInitialized();
        return this._search;
    }

    get displayTitle() {
        this.assertInitialized();
        return this._displayTitle;
    }

    get tag() {
        this.assertInitialized();
        return this._tag;
    }

    get enhancementResources() {
        this.assertInitialized();
        return this._enhancementResources;
    }

    get documentWorker() {
        this.assertInitialized();
        return this._documentWorker;
    }

    get libraryTemplate() {
        this.assertInitialized();
        return this._libraryTemplate;
    }

    get localTemplate() {
        this.assertInitialized();
        return this._localTemplate;
    }

    get notePath() {
        this.assertInitialized();
        return this._notePath;
    }

    get cslRender() {
        this.assertInitialized();
        return this._cslRender;
    }

    get tasks() {
        this.assertInitialized();
        return this._tasks;
    }

    /** The main-thread host the worker calls back into. */
    get parentHost() {
        this.assertInitialized();
        return this._parentHost;
    }

    /* ================================================================ */
    /*  Task factory methods (delegates to top-level WorkerAPI methods) */
    /* ================================================================ */

    async createSyncTask(libraryId?: number): Promise<string> {
        this.assertInitialized();
        return this._api.createSyncTask(libraryId);
    }

    async createBatchNoteTask(
        input: BatchNoteInput,
        options: UpdateOptions,
        isUpdate: boolean,
    ): Promise<string> {
        this.assertInitialized();
        return this._api.createBatchNoteTask(input, options, isUpdate);
    }

    async createBatchExtractImagesTask(
        input: BatchExtractImagesInput,
    ): Promise<string> {
        this.assertInitialized();
        return this._api.createBatchExtractImagesTask(input);
    }

    async createBackfillCslJsonTask(): Promise<string> {
        this.assertInitialized();
        return this._api.createBackfillCslJsonTask();
    }

    async downloadAttachment(
        attachmentItem: IDBZoteroItem<AttachmentData>,
    ): Promise<DownloadedAttachment> {
        this.assertInitialized();
        return this._api.downloadAttachment(attachmentItem);
    }

    async extractExternalAnnotations(
        items: AttachmentIdentifier[],
    ): Promise<AnnotationJSON[]> {
        this.assertInitialized();
        return this._api.extractExternalAnnotations(items);
    }

    cancelTask(taskId: string): void {
        this.assertInitialized();
        void this._api.cancelTask(taskId);
    }

    updateSettings(newSettings: ZotFlowSettings) {
        void this._api.updateSettings(newSettings);
    }

    terminate() {
        this._worker.terminate();
        URL.revokeObjectURL(this._workerBlobUrl);
        this._initialized = false;
    }
}

/** Singleton `WorkerBridge` instance used throughout the main thread. */
export const workerBridge = new WorkerBridge();
