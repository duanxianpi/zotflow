import * as Comlink from "comlink";
import workerCode from "virtual:worker";
import { ParentHost } from "./parent-host";
import { getBlobUrls } from "bundle-assets/inline-assets";

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
import type { LocalNoteService } from "worker/services/local-note";
import type { ConflictService } from "worker/services/conflict";
import type { AnnotationService } from "worker/services/annotation";
import type { KeyService } from "worker/services/key";
import type { LibraryService } from "worker/services/library";
import type { DbHelperService } from "worker/services/db-helper";
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

function materializeComlinkProxy<T>(proxy: T): Promise<Awaited<T>> {
    return Promise.resolve(proxy);
}

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
    private _localNote: Comlink.Remote<LocalNoteService>;
    private _conflict: Comlink.Remote<ConflictService>;
    private _annotation: Comlink.Remote<AnnotationService>;
    private _key: Comlink.Remote<KeyService>;
    private _library: Comlink.Remote<LibraryService>;
    private _dbHelper: Comlink.Remote<DbHelperService>;
    private _tag: Comlink.Remote<TagService>;
    private _documentWorker: Comlink.Remote<DocumentWorkerService>;
    private _libraryTemplate: Comlink.Remote<LibraryTemplateService>;
    private _localTemplate: Comlink.Remote<LocalTemplateService>;
    private _notePath: Comlink.Remote<NotePathService>;
    private _cslRender: Comlink.Remote<CslRenderWorkerService>;
    private _tasks: Comlink.Remote<TaskManager>;

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
        // Worker settings update / initialization
        const blobUrls = getBlobUrls();
        await this._api.init(
            settings,
            Comlink.proxy(new ParentHost(app)),
            blobUrls,
        );

        // Promise.resolve performs the same thenable assimilation as `await`.
        // Comlink's runtime `then` trap materialises each dedicated MessagePort,
        // although its TypeScript types do not expose that thenable shape.
        this._attachment = await materializeComlinkProxy(this._api.attachment);
        this._sync = await materializeComlinkProxy(this._api.sync);
        this._zotero = await materializeComlinkProxy(this._api.zotero);
        this._webdav = await materializeComlinkProxy(this._api.webdav);
        this._treeView = await materializeComlinkProxy(this._api.treeView);
        this._libraryNote = await materializeComlinkProxy(
            this._api.libraryNote,
        );
        this._itemNote = await materializeComlinkProxy(this._api.itemNote);
        this._localNote = await materializeComlinkProxy(this._api.localNote);
        this._conflict = await materializeComlinkProxy(this._api.conflict);
        this._annotation = await materializeComlinkProxy(this._api.annotation);
        this._key = await materializeComlinkProxy(this._api.key);
        this._library = await materializeComlinkProxy(this._api.library);
        this._dbHelper = await materializeComlinkProxy(this._api.dbHelper);
        this._tag = await materializeComlinkProxy(this._api.tag);
        this._documentWorker = await materializeComlinkProxy(
            this._api.documentWorker,
        );
        this._libraryTemplate = await materializeComlinkProxy(
            this._api.libraryTemplate,
        );
        this._localTemplate = await materializeComlinkProxy(
            this._api.localTemplate,
        );
        this._notePath = await materializeComlinkProxy(this._api.notePath);
        this._cslRender = await materializeComlinkProxy(this._api.cslRender);
        this._tasks = await materializeComlinkProxy(this._api.tasks);

        this._initialized = true;
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

    get tag() {
        this.assertInitialized();
        return this._tag;
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
