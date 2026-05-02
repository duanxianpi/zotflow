import * as Comlink from "comlink";
import { ZoteroAPIService } from "./services/zotero";
import { SyncService } from "./services/sync";
import { AttachmentService } from "./services/attachment";
import { WebDavService } from "./services/webdav";
import { TreeViewService } from "./services/tree-view";
import { LibraryTemplateService } from "./services/library-template";
import { LibraryNoteService } from "./services/library-note";
import { PDFProcessWorker } from "./services/pdf-processor";
import { LocalNoteService } from "./services/local-note";
import { LocalTemplateService } from "./services/local-template";
import { ConflictService } from "./services/conflict";
import { AnnotationService } from "./services/annotation";
import { KeyService } from "./services/key";
import { LibraryService } from "./services/library";
import { DbHelperService } from "./services/db-helper";
import { NotePathService } from "./services/note-path";
import { ConvertService } from "./services/convert";
import { ItemNoteService } from "./services/item-note";
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
import type { SaveAnnotationsResult } from "./services/annotation";
import type { LibraryRow } from "./services/key";
import type { DbHelperService as DbHelperServiceType } from "./services/db-helper";

/**
 * Worker API definition
 * This interface defines the methods exposed by the worker
 */
export interface WorkerAPI {
    init(
        settings: ZotFlowSettings,
        parentHost: IParentProxy,
        blobUrls: Record<string, string>,
    ): void;
    dispose(): void;
    zotero: ZoteroAPIService;
    sync: SyncService;
    attachment: AttachmentService;
    webdav: WebDavService;
    treeView: TreeViewService;
    libraryNote: LibraryNoteService;
    itemNote: ItemNoteService;
    localNote: LocalNoteService;
    conflict: ConflictService;
    annotation: AnnotationService;
    key: KeyService;
    library: LibraryService;
    dbHelper: DbHelperServiceType;
    pdfProcessor: PDFProcessWorker;
    libraryTemplate: LibraryTemplateService;
    localTemplate: LocalTemplateService;
    notePath: NotePathService;
    tasks: TaskManager;
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
    downloadAttachment(
        attachmentItem: IDBZoteroItem<AttachmentData>,
    ): Promise<Blob>;
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
let _notePath: NotePathService | undefined;
let _convert: ConvertService | undefined;
let _pdfProcessor: PDFProcessWorker | undefined;
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
        !_pdfProcessor ||
        !_localNote ||
        !_localTemplate ||
        !_conflict ||
        !_annotation ||
        !_key ||
        !_library ||
        !_dbHelper ||
        !_notePath ||
        !_convert ||
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
        (globalThis as any).originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
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

        try {
            _zotero = new ZoteroAPIService(settings.zoteroapikey);
            _library = new LibraryService(settings, parentHost);
            _dbHelper = new DbHelperService(settings, parentHost, _library);
            _webdav = new WebDavService(settings, parentHost);
            _attachment = new AttachmentService(
                _webdav,
                settings,
                _zotero,
                parentHost,
            );
            _sync = new SyncService(_zotero, settings, parentHost, _library);
            _treeView = new TreeViewService(settings, parentHost, _library);

            _pdfProcessor = new PDFProcessWorker(
                settings,
                parentHost,
                blobUrls,
            );
            _notePath = new NotePathService(settings, _dbHelper);
            _convert = new ConvertService();

            _template = new LibraryTemplateService(
                settings,
                parentHost,
                _dbHelper,
                _notePath,
                _convert,
            );
            _libraryNote = new LibraryNoteService(
                settings,
                _template,
                parentHost,
                _attachment,
                _pdfProcessor,
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

            // Initialize PDF Worker
            _pdfProcessor._init();

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

    get pdfProcessor() {
        if (!_pdfProcessor)
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "Worker",
                "Worker not initialized",
            );
        return Comlink.proxy(_pdfProcessor);
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

    dispose: () => {
        _libraryNote?.dispose();
        _localNote?.dispose();
    },

    /* ================================================================ */
    /*  Task factory methods                                           */
    /* ================================================================ */

    createSyncTask: async (libraryId?: number) => {
        assertInitialized();
        return _taskManager!.createSyncTask(_sync!, libraryId);
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
            _pdfProcessor!,
            _currentSettings!,
            input,
        );
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
            _pdfProcessor!,
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
        _pdfProcessor!.updateSettings(settings);
        _currentSettings = settings;
    },
};

Comlink.expose(exposedApi);
