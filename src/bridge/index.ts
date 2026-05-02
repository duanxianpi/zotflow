import * as Comlink from "comlink";
// @ts-expect-error esbuild virtual module "virtual:worker"
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
import type { PDFProcessWorker } from "worker/services/pdf-processor";
import type { LibraryTemplateService } from "worker/services/library-template";
import type { LocalTemplateService } from "worker/services/local-template";
import type { NotePathService } from "worker/services/note-path";
import type { BatchNoteInput } from "worker/tasks/impl/batch-note-task";
import type {
    BatchExtractImagesInput,
    ItemIdentifier,
} from "worker/tasks/impl/batch-extract-images-task";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";

import type { App } from "obsidian";
import type { AttachmentIdentifier } from "worker/tasks/impl/batch-extract-external-annotations-task";

import { services } from "services/services";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

/** Comlink-based RPC wrapper managing the Web Worker lifecycle and exposing all worker service proxies. */
export class WorkerBridge {
    private _worker: Worker;

    private _api: Comlink.Remote<WorkerAPI>;

    private _attachment: AttachmentService;
    private _sync: SyncService;
    private _zotero: ZoteroAPIService;
    private _webdav: WebDavService;
    private _treeView: TreeViewService;
    private _libraryNote: LibraryNoteService;
    private _itemNote: ItemNoteService;
    private _localNote: LocalNoteService;
    private _conflict: ConflictService;
    private _annotation: AnnotationService;
    private _key: KeyService;
    private _library: LibraryService;
    private _dbHelper: DbHelperService;
    private _pdfProcessor: PDFProcessWorker;
    private _libraryTemplate: LibraryTemplateService;
    private _localTemplate: LocalTemplateService;
    private _notePath: NotePathService;
    private _tasks: TaskManager;

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

        this._attachment = await this._api.attachment;
        this._sync = await this._api.sync;
        this._zotero = await this._api.zotero;
        this._webdav = await this._api.webdav;
        this._treeView = await this._api.treeView;
        this._libraryNote = await this._api.libraryNote;
        this._itemNote = await this._api.itemNote;
        this._localNote = await this._api.localNote;
        this._conflict = await this._api.conflict;
        this._annotation = await this._api.annotation;
        this._key = await this._api.key;
        this._library = await this._api.library;
        this._dbHelper = await this._api.dbHelper;
        this._pdfProcessor = await this._api.pdfProcessor;
        this._libraryTemplate = await this._api.libraryTemplate;
        this._localTemplate = await this._api.localTemplate;
        this._notePath = await this._api.notePath;
        this._tasks = await this._api.tasks;

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

    get pdfProcessWorker() {
        this.assertInitialized();
        return this._pdfProcessor;
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

    async downloadAttachment(
        attachmentItem: IDBZoteroItem<AttachmentData>,
    ): Promise<Blob> {
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
        this._api.cancelTask(taskId);
    }

    updateSettings(newSettings: ZotFlowSettings) {
        this._api.updateSettings(newSettings);
    }

    terminate() {
        this._worker.terminate();
        URL.revokeObjectURL(this._workerBlobUrl);
        this._initialized = false;
    }
}

/** Singleton `WorkerBridge` instance used throughout the main thread. */
export const workerBridge = new WorkerBridge();
