import * as Comlink from "comlink";
import { setProxiedFetch } from "./proxied-fetch";
import { ZoteroAPIService } from "./services/zotero";
import { SyncService } from "./services/sync";
import { AttachmentService } from "./services/attachment";
import { WebDavService } from "./services/webdav";
import { TreeViewService } from "./services/tree-view";
import { LibraryTemplateService } from "./services/library-template";
import { LibraryNoteService } from "./services/library-note";
import { DocumentWorkerService } from "./services/document-worker";
import { LocalNoteService } from "./services/local-note";
import { LocalTemplateService } from "./services/local-template";
import { ConflictService } from "./services/conflict";
import { AnnotationService } from "./services/annotation";
import { KeyService } from "./services/key";
import { LibraryService } from "./services/library";
import { DbHelperService } from "./services/db-helper";
import { SearchService } from "./services/search";
import { TagService } from "./services/tag";
import { NotePathService } from "./services/note-path";
import { ConvertService } from "./services/convert";
import { ItemNoteService } from "./services/item-note";
import { CslRenderWorkerService } from "./services/csl-render";
import { TaskManager } from "./tasks/manager";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { ZotFlowSettings } from "settings/types";
import type { IParentProxy } from "bridge/types";
import type { UpdateOptions } from "./services/library-note";
import type { BatchNoteInput } from "./tasks/impl/batch-note-task";
import type {
    BatchExtractImagesInput,
    ItemIdentifier,
} from "./tasks/impl/batch-extract-images-task";
import type { IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";
import type { DownloadedAttachment } from "types/tasks";
import type { DbHelperService as DbHelperServiceType } from "./services/db-helper";
import type { TagService as TagServiceType } from "./services/tag";

/**
 * Worker API definition
 * This interface defines the methods exposed by the worker
 */
/**
 * A worker service handed across the Comlink boundary. The getters below
 * return `Comlink.proxy(...)`, so the value really is proxy-marked; declaring
 * that is what makes `Remote<WorkerAPI>` type these as proxies whose methods
 * return promises, rather than as values to be structured-cloned.
 */
type Exposed<T> = T & Comlink.ProxyMarked;

export interface WorkerAPI {
    init(
        settings: ZotFlowSettings,
        parentHost: IParentProxy,
        blobUrls: Record<string, string>,
    ): void;
    dispose(): void;
    zotero: Exposed<ZoteroAPIService>;
    sync: Exposed<SyncService>;
    attachment: Exposed<AttachmentService>;
    webdav: Exposed<WebDavService>;
    treeView: Exposed<TreeViewService>;
    libraryNote: Exposed<LibraryNoteService>;
    itemNote: Exposed<ItemNoteService>;
    localNote: Exposed<LocalNoteService>;
    conflict: Exposed<ConflictService>;
    annotation: Exposed<AnnotationService>;
    key: Exposed<KeyService>;
    library: Exposed<LibraryService>;
    dbHelper: Exposed<DbHelperServiceType>;
    tag: Exposed<TagServiceType>;
    documentWorker: Exposed<DocumentWorkerService>;
    libraryTemplate: Exposed<LibraryTemplateService>;
    localTemplate: Exposed<LocalTemplateService>;
    notePath: Exposed<NotePathService>;
    cslRender: Exposed<CslRenderWorkerService>;
    tasks: Exposed<TaskManager>;
    updateSettings(settings: ZotFlowSettings): void;

    // Task factory methods
    createSyncTask(libraryId?: number): Promise<string>;
    createBatchNoteTask(
        input: BatchNoteInput,
        options: UpdateOptions,
        isUpdate: boolean,
    ): Promise<string>;
    createBatchExtractImagesTask(
        input: BatchExtractImagesInput,
    ): Promise<string>;
    createBackfillCslJsonTask(): Promise<string>;
    downloadAttachment(
        attachmentItem: IDBZoteroItem<AttachmentData>,
    ): Promise<DownloadedAttachment>;
    extractExternalAnnotations(
        items: ItemIdentifier[],
    ): Promise<AnnotationJSON[]>;
    cancelTask(taskId: string): void;
}

// Service instances (Lazy initialized)
let _zotero: ZoteroAPIService | undefined;
let _webdav: WebDavService | undefined;
let _attachment: AttachmentService | undefined;
let _sync: SyncService | undefined;
let _treeView: TreeViewService | undefined;
let _template: LibraryTemplateService | undefined;
let _libraryNote: LibraryNoteService | undefined;
let _itemNote: ItemNoteService | undefined;
let _localNote: LocalNoteService | undefined;
let _localTemplate: LocalTemplateService | undefined;
let _conflict: ConflictService | undefined;
let _annotation: AnnotationService | undefined;
let _key: KeyService | undefined;
let _library: LibraryService | undefined;
let _dbHelper: DbHelperService | undefined;
let _search: SearchService | undefined;
let _tag: TagService | undefined;
let _notePath: NotePathService | undefined;
let _convert: ConvertService | undefined;
let _documentWorker: DocumentWorkerService | undefined;
let _cslRender: CslRenderWorkerService | undefined;
let _taskManager: TaskManager | undefined;
let _currentSettings: ZotFlowSettings | undefined;

function assertInitialized() {
    if (
        !_zotero ||
        !_webdav ||
        !_attachment ||
        !_sync ||
        !_treeView ||
        !_template ||
        !_libraryNote ||
        !_itemNote ||
        !_documentWorker ||
        !_localNote ||
        !_localTemplate ||
        !_conflict ||
        !_annotation ||
        !_key ||
        !_library ||
        !_dbHelper ||
        !_search ||
        !_tag ||
        !_notePath ||
        !_convert ||
        !_cslRender ||
        !_taskManager ||
        !_currentSettings
    ) {
        throw new ZotFlowError(
            ZotFlowErrorCode.RESOURCE_MISSING,
            "Worker",
            "Worker not initialized",
        );
    }
}

const exposedApi: WorkerAPI = {
    init: (
        settings: ZotFlowSettings,
        parentHost: IParentProxy,
        blobUrls: Record<string, string>,
    ) => {
        // Patch global fetch to proxy through Obsidian Main Thread
        // The worker global has no `originalFetch`; we are adding it so the
        // proxy can be unwound.
        const workerGlobal = self as unknown as {
            fetch: unknown;
            originalFetch?: unknown;
        };
        workerGlobal.originalFetch = workerGlobal.fetch;
        const proxiedFetchImpl = async (url: string, init?: RequestInit) => {
            try {
                const response = await parentHost.request({
                    url: url,
                    method: init?.method || "GET",
                    headers: init?.headers as Record<string, string>,
                    body: init?.body as string | ArrayBuffer,
                    throw: false, // We handle status codes in Services
                    contentType: "application/json",
                });

                // Handle empty response bodies
                if (
                    !response.arrayBuffer ||
                    response.arrayBuffer.byteLength === 0
                ) {
                    return new Response(null, {
                        status: response.status,
                        headers: new Headers(response.headers),
                    });
                }

                // Convert Obsidian Bridge response to standard Response object
                return new Response(response.arrayBuffer, {
                    status: response.status,
                    headers: new Headers(response.headers),
                });
            } catch (e) {
                throw new TypeError(
                    `Network Request Failed: ${(e as Error).message}`,
                );
            }
        };
        workerGlobal.fetch = proxiedFetchImpl;

        // Also expose via module import (see proxied-fetch.ts) so worker
        // code can use it without referencing lint-restricted globals.
        setProxiedFetch(proxiedFetchImpl);

        try {
            _zotero = new ZoteroAPIService(settings.zoteroapikey);
            _library = new LibraryService(settings, parentHost);
            _search = new SearchService();
            _dbHelper = new DbHelperService(
                settings,
                parentHost,
                _library,
                _search,
            );
            _tag = new TagService(settings, parentHost);
            _webdav = new WebDavService(settings, parentHost);
            _attachment = new AttachmentService(
                _webdav,
                settings,
                _zotero,
                parentHost,
            );
            _sync = new SyncService(_zotero, settings, parentHost, _library);
            _treeView = new TreeViewService(
                settings,
                parentHost,
                _library,
                _search,
            );

            _documentWorker = new DocumentWorkerService(
                settings,
                parentHost,
                blobUrls,
            );
            _notePath = new NotePathService(settings, _dbHelper);
            _convert = new ConvertService();

            _cslRender = new CslRenderWorkerService(settings);

            _template = new LibraryTemplateService(
                settings,
                parentHost,
                _dbHelper,
                _notePath,
                _convert,
                _cslRender,
                _zotero,
            );
            _libraryNote = new LibraryNoteService(
                settings,
                _template,
                parentHost,
                _attachment,
                _documentWorker,
                _notePath,
            );
            _itemNote = new ItemNoteService(
                settings,
                parentHost,
                _convert,
                _libraryNote,
            );

            _localTemplate = new LocalTemplateService(settings, parentHost);
            _localNote = new LocalNoteService(
                settings,
                parentHost,
                _localTemplate,
                _notePath,
            );

            _conflict = new ConflictService(parentHost);

            _annotation = new AnnotationService(
                _libraryNote,
                parentHost,
                _convert,
            );
            _key = new KeyService(_zotero, parentHost);

            _taskManager = new TaskManager(parentHost);

            _currentSettings = settings;

            // Initialize the nested Document Worker.
            _documentWorker._init();

            parentHost.log("info", "Services initialized.", "Worker");
        } catch (e) {
            parentHost.log("error", "Initialization failed", "Worker", e);

            // This error will be caught by the Comlink promise on the main thread
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                `Worker Initialization Failed: ${(e as Error).message}`,
            );
        }
    },

    get zotero() {
        if (!_zotero)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_zotero);
    },

    get sync() {
        if (!_sync)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_sync);
    },

    get webdav() {
        if (!_webdav)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_webdav);
    },

    get attachment() {
        if (!_attachment)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_attachment);
    },

    get treeView() {
        if (!_treeView)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_treeView);
    },

    get libraryNote() {
        if (!_libraryNote)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_libraryNote);
    },

    get itemNote() {
        if (!_itemNote)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_itemNote);
    },

    get localNote() {
        if (!_localNote)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_localNote);
    },

    get conflict() {
        if (!_conflict)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_conflict);
    },

    get annotation() {
        if (!_annotation)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_annotation);
    },

    get key() {
        if (!_key)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_key);
    },

    get library() {
        if (!_library)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_library);
    },

    get dbHelper() {
        if (!_dbHelper)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_dbHelper);
    },

    get tag() {
        if (!_tag)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_tag);
    },

    get documentWorker() {
        if (!_documentWorker)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_documentWorker);
    },

    get tasks() {
        if (!_taskManager)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_taskManager);
    },

    get libraryTemplate() {
        if (!_template)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_template);
    },

    get localTemplate() {
        if (!_localTemplate)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_localTemplate);
    },

    get notePath() {
        if (!_notePath)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_notePath);
    },

    get cslRender() {
        if (!_cslRender)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_cslRender);
    },

    dispose: () => {
        _libraryNote?.dispose();
        _localNote?.dispose();
        _cslRender?.dispose();
    },

    /* ================================================================ */
    /*  Task factory methods                                           */
    /* ================================================================ */

    createSyncTask: async (libraryId?: number) => {
        assertInitialized();
        return _taskManager!.createSyncTask(
            _sync!,
            libraryId,
            _libraryNote,
            _currentSettings,
        );
    },

    createBatchNoteTask: async (
        input: BatchNoteInput,
        options: UpdateOptions,
        isUpdate: boolean,
    ) => {
        assertInitialized();
        return _taskManager!.createBatchNoteTask(
            _libraryNote!,
            input,
            options,
            isUpdate,
        );
    },

    createBatchExtractImagesTask: async (input: BatchExtractImagesInput) => {
        assertInitialized();
        return _taskManager!.createBatchExtractImagesTask(
            _attachment!,
            _documentWorker!,
            _currentSettings!,
            input,
        );
    },

    createBackfillCslJsonTask: async () => {
        assertInitialized();
        return _taskManager!.createBackfillCslJsonTask(_zotero!);
    },

    downloadAttachment: async (
        attachmentItem: IDBZoteroItem<AttachmentData>,
    ) => {
        assertInitialized();
        return _taskManager!.createDownloadAttachmentTask(
            _attachment!,
            attachmentItem,
        );
    },

    extractExternalAnnotations: async (items: ItemIdentifier[]) => {
        assertInitialized();
        return _taskManager!.createBatchExtractExternalAnnotationsTask(
            _attachment!,
            _documentWorker!,
            _libraryNote!,
            { items },
        );
    },

    cancelTask: (taskId: string) => {
        assertInitialized();
        _taskManager!.cancelTask(taskId);
    },

    updateSettings: (settings: ZotFlowSettings) => {
        assertInitialized();

        // Safe updates
        _zotero!.updateCredentials(settings.zoteroapikey);
        _webdav!.updateSettings(settings);
        _attachment!.updateSettings(settings);
        _sync!.updateSettings(settings);
        _treeView!.updateSettings(settings);
        _library!.updateSettings(settings);
        _template!.updateSettings(settings);
        _libraryNote!.updateSettings(settings);
        _itemNote!.updateSettings(settings);
        _localNote!.updateSettings(settings);
        _localTemplate!.updateSettings(settings);
        _notePath!.updateSettings(settings);
        _dbHelper!.updateSettings(settings);
        _tag!.updateSettings(settings);
        _documentWorker!.updateSettings(settings);
        _cslRender!.updateSettings(settings);
        _currentSettings = settings;
    },
};

Comlink.expose(exposedApi);
