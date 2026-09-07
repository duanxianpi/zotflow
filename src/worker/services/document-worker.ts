import type { EnhancementResourceService } from "worker/services/enhancement-resources";
import { sdtCompatibility } from "enhancement-pack/compatibility";
import type { PackLease } from "enhancement-pack/types";
/*
 * Ported from Zotero's `chrome/content/zotero/xpcom/pdfWorker/manager.js`
 * (AGPL-3.0). The transport protocol and queue semantics follow the worker
 * bundled from zotero/document-worker commit 6d0c0ce (Zotero 10.0.0).
 */
import * as Comlink from "comlink";
import { db } from "db/db";
import type { ZotFlowSettings } from "settings/types";
import type { IParentProxy } from "bridge/types";
import type { IDBZoteroItem } from "types/db-schema";
import type { AnnotationData } from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

interface DocumentWorkerConfig {
    workerURL: string;
}

interface WorkerMessage {
    id?: number;
    progressID?: number;
    responseID?: number;
    action?: string;
    data?: unknown;
    error?: unknown;
}

type PromiseResolvers = {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    onProgress?: (progress: number) => void;
};

interface QueryOptions {
    onProgress?: (progress: number) => void;
}

type QueueItem = () => Promise<void>;

interface SaveRenderedAnnotationRequest {
    libraryID: number;
    annotationKey: string;
    buf: ArrayBuffer;
}

interface BufferResponse {
    buf: ArrayBuffer;
}

interface ExportAnnotation {
    id: string;
    type: string;
    authorName: string;
    comment: string;
    color: string;
    position: unknown;
    dateModified: string;
    tags: string[];
}

type ImportedAnnotation = Omit<
    AnnotationJSON,
    "id" | "isExternal" | "tags" | "dateModified" | "dateAdded"
> &
    Partial<
        Pick<AnnotationJSON, "id" | "isExternal" | "dateModified" | "dateAdded">
    > & {
        /** Document Worker emits raw Zotero tag names, not Reader tag objects. */
        tags?: string[];
    };

interface ImportResponse {
    imported: ImportedAnnotation[];
    deleted: string[];
    buf?: ArrayBuffer;
}

export interface ExistingPDFAnnotation {
    id: string;
    type: string;
    position: unknown;
    comment?: string;
}

export interface PDFImportOptions {
    existingAnnotations?: ExistingPDFAnnotation[];
    /** IDs already used by any annotation on the attachment. */
    reservedIDs?: string[];
    isPriority?: boolean;
    password?: string;
    transfer?: boolean;
}

export interface PDFImportResult {
    imported: AnnotationJSON[];
    deleted: string[];
    buf?: ArrayBuffer;
}

export interface StructuredDocumentTextOptions {
    contentType: string;
    sourceHash: string;
    isPriority?: boolean;
    password?: string;
    onProgress?: (progress: number) => void;
}

export interface PDFRecognizerData {
    metadata: Record<string, string>;
    totalPages: number;
    pages: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (isRecord(error) && typeof error.message === "string") {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return JSON.stringify(error) || "Unknown worker error";
}

function getWorkerErrorName(error: unknown): string {
    return isRecord(error) && typeof error.name === "string"
        ? error.name
        : "WorkerError";
}

function isSaveRenderedAnnotationRequest(
    data: unknown,
): data is SaveRenderedAnnotationRequest {
    return (
        isRecord(data) &&
        typeof data.libraryID === "number" &&
        typeof data.annotationKey === "string" &&
        data.buf instanceof ArrayBuffer
    );
}

function getOriginalFetch(): typeof fetch {
    const workerGlobal = self as typeof self & {
        originalFetch?: unknown;
    };
    if (typeof workerGlobal.originalFetch !== "function") {
        throw new Error("Native worker fetch is unavailable");
    }
    return workerGlobal.originalFetch as typeof fetch;
}

function parseJson(text: string): unknown {
    return JSON.parse(text) as unknown;
}

function generateAnnotationKey(): string {
    const characters = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    let key = "";
    for (let i = 0; i < 8; i++) {
        key += characters[Math.floor(Math.random() * characters.length)];
    }
    return key;
}

const DOCUMENT_WORKER_DIRECTORY = "document-worker";
const DOCUMENT_WORKER_URL_KEY = `${DOCUMENT_WORKER_DIRECTORY}/worker.js`;

/** Manages Zotero's nested Document Worker and its PDF/SDT operations. */
export class DocumentWorkerService {
    config: DocumentWorkerConfig;
    private _worker: Worker | null;
    private _lastPromiseID: number;
    private _waitingPromises: { [key: number]: PromiseResolvers };
    private _queue: QueueItem[];
    private _processingQueue: boolean;
    private _blobUrls: Record<string, string>;
    private sdtLease?: Promise<PackLease>;
    private workerEpoch = 0;
    private disposed = false;

    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        blobUrls: Record<string, string>,
        private enhancementResources: Pick<
            EnhancementResourceService,
            "getBlob"
        >,
    ) {
        this._worker = null;
        this._lastPromiseID = 0;
        this._waitingPromises = {};
        this._queue = [];
        this._processingQueue = false;
        this._blobUrls = blobUrls;

        try {
            const workerUrl = this._blobUrls[DOCUMENT_WORKER_URL_KEY];
            if (!workerUrl) {
                throw new ZotFlowError(
                    ZotFlowErrorCode.RESOURCE_MISSING,
                    "DocumentWorkerService",
                    `Document Worker resource not found: ${DOCUMENT_WORKER_URL_KEY}`,
                );
            }

            this.config = {
                workerURL: workerUrl,
            };
            this.parentHost.log(
                "debug",
                "Document Worker initialized",
                "DocumentWorkerService",
            );
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.RESOURCE_MISSING,
                "DocumentWorkerService",
                "Failed to initialize Document Worker",
            );
        }
    }

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    async _processQueue() {
        if (this._processingQueue) {
            return;
        }
        this._processingQueue = true;
        try {
            let queuedOperation: QueueItem | undefined;
            while ((queuedOperation = this._queue.shift())) {
                await queuedOperation();
            }
        } finally {
            this._processingQueue = false;
        }
    }

    async _enqueue<T>(fn: () => Promise<T>, isPriority?: boolean): Promise<T> {
        if (this.disposed)
            throw new Error("Document Worker service was disposed");
        return new Promise((resolve, reject) => {
            const queuedOperation = async () => {
                try {
                    if (this.disposed)
                        throw new Error("Document Worker service was disposed");
                    this._init();
                    resolve(await fn());
                } catch (error) {
                    reject(
                        error instanceof Error
                            ? error
                            : new Error(getErrorMessage(error)),
                    );
                }
            };
            if (isPriority) {
                this._queue.unshift(queuedOperation);
            } else {
                this._queue.push(queuedOperation);
            }
            void this._processQueue();
        });
    }

    async _query<T>(
        action: string,
        data: unknown,
        transfer?: Transferable[],
        options: QueryOptions = {},
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            if (!this._worker) {
                reject(
                    new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "DocumentWorkerService",
                        "Document Worker not initialized",
                    ),
                );
                return;
            }
            this._lastPromiseID++;
            this._waitingPromises[this._lastPromiseID] = {
                resolve: (value) => resolve(value as T),
                reject,
                onProgress: options.onProgress,
            };
            this._worker.postMessage(
                { id: this._lastPromiseID, action, data },
                transfer || [],
            );
        });
    }

    private async _fetchDocumentWorkerResource(
        resourcePath: string,
    ): Promise<Uint8Array> {
        if (
            !resourcePath ||
            resourcePath.startsWith("/") ||
            resourcePath.includes("\\") ||
            resourcePath.split("/").includes("..")
        ) {
            throw new Error(
                `Invalid Document Worker resource path: ${resourcePath}`,
            );
        }

        const resourceKey = `${DOCUMENT_WORKER_DIRECTORY}/${resourcePath}`;
        let resourceUrl: string | undefined;
        if (sdtCompatibility.resourcePaths.includes(resourcePath)) {
            const epoch = this.workerEpoch;
            this.sdtLease ??= this.parentHost
                .acquireEnhancementSdtResources()
                .then(async (lease) => {
                    if (this.disposed || epoch !== this.workerEpoch) {
                        await this.parentHost.releaseEnhancementResources(
                            lease.leaseId,
                        );
                        throw new Error(
                            "Document Worker resource session ended",
                        );
                    }
                    return lease;
                })
                .catch((error: unknown) => {
                    if (epoch === this.workerEpoch) this.sdtLease = undefined;
                    throw error;
                });
            const lease = await this.sdtLease;
            // Local service call: no main-thread URL creation, Blob fetch or extra Worker.
            const blob = await this.enhancementResources.getBlob(
                lease.snapshotId,
                resourcePath,
            );
            const bytes = await blob.arrayBuffer();
            if (this.disposed || epoch !== this.workerEpoch)
                throw new Error("Document Worker resource session ended");
            return new Uint8Array(bytes);
        } else {
            resourceUrl = this._blobUrls[resourceKey];
        }
        if (!resourceUrl) {
            throw new Error(
                `Document Worker resource not found: ${resourceKey}`,
            );
        }

        const response = await getOriginalFetch()(resourceUrl);
        if (!response.ok) {
            throw new Error(
                `Failed to load ${resourceKey}: ${response.status}`,
            );
        }
        return new Uint8Array(await response.arrayBuffer());
    }

    _init() {
        if (this._worker) return;
        if (!this.config.workerURL) {
            this.parentHost.log(
                "error",
                "Document Worker URL not configured",
                "DocumentWorkerService",
            );
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "DocumentWorkerService",
                "Document Worker URL not configured",
            );
        }
        const worker = new Worker(this.config.workerURL);
        this._worker = worker;
        worker.addEventListener(
            "message",
            (event: MessageEvent<WorkerMessage>) => {
                // The listener contract is void; the handler reports its own
                // failures, so the promise is marked rather than returned.
                void (async () => {
                    if (this._worker !== worker) return;
                    const message = event.data;

                    // Progress notifications refer to the original request
                    // without settling it. Zotero's Document Worker stores the
                    // percentage in data.progress.
                    if (message.progressID !== undefined) {
                        const resolver =
                            this._waitingPromises[message.progressID];
                        const progress = isRecord(message.data)
                            ? message.data.progress
                            : undefined;
                        if (
                            resolver?.onProgress &&
                            typeof progress === "number"
                        ) {
                            try {
                                resolver.onProgress(progress);
                            } catch (e) {
                                this.parentHost.log(
                                    "warn",
                                    "Document Worker progress callback failed",
                                    "DocumentWorkerService",
                                    e,
                                );
                            }
                        }
                        return;
                    }

                    // Handle Response (Worker -> Main Request)
                    if (message.responseID !== undefined) {
                        const resolver =
                            this._waitingPromises[message.responseID];
                        if (resolver) {
                            const { resolve, reject } = resolver;
                            delete this._waitingPromises[message.responseID];
                            if (
                                message.error !== undefined &&
                                message.error !== null
                            ) {
                                const errorMessage = getErrorMessage(
                                    message.error,
                                );
                                const errorName = getWorkerErrorName(
                                    message.error,
                                );
                                reject(
                                    new ZotFlowError(
                                        ZotFlowErrorCode.PARSE_ERROR,
                                        "DocumentWorkerService",
                                        `Document Worker Error (${errorName}): ${errorMessage}`,
                                        { workerErrorName: errorName },
                                    ),
                                );
                            } else {
                                resolve(message.data);
                            }
                        }
                        return;
                    }

                    // Handle Request (Worker -> Main Request)
                    if (message.id !== undefined) {
                        let responseData: unknown = null;
                        let responseError: { message: string } | null = null;

                        try {
                            switch (message.action) {
                                case "FetchData": {
                                    if (typeof message.data !== "string") {
                                        throw new Error(
                                            "Invalid resource request payload",
                                        );
                                    }
                                    responseData =
                                        await this._fetchDocumentWorkerResource(
                                            message.data,
                                        );
                                    break;
                                }

                                case "SaveRenderedAnnotation": {
                                    if (
                                        !isSaveRenderedAnnotationRequest(
                                            message.data,
                                        )
                                    ) {
                                        throw new Error(
                                            "Invalid rendered annotation payload",
                                        );
                                    }
                                    const { libraryID, annotationKey, buf } =
                                        message.data;

                                    await db.items
                                        .where({
                                            libraryID,
                                            key: annotationKey,
                                        })
                                        .modify((item) => {
                                            item.annotationImageVersion =
                                                Math.max(item.version, 1);
                                        });
                                    const folder =
                                        this.settings.annotationImageFolder.replace(
                                            /\/$/,
                                            "",
                                        );
                                    const path = `${folder}/${annotationKey}.png`;

                                    await this.parentHost.writeBinaryFile(
                                        path,
                                        Comlink.transfer(buf, [buf]),
                                    );

                                    responseData = true;
                                    break;
                                }

                                default:
                                    throw new Error(
                                        `Unsupported Document Worker request: ${message.action ?? "unknown"}`,
                                    );
                            }
                        } catch (e) {
                            this.parentHost.log(
                                "error",
                                `Failed to handle Document Worker request (${message.action ?? "unknown"})`,
                                "DocumentWorkerService",
                                e,
                            );
                            responseError = { message: getErrorMessage(e) };
                        }

                        if (this._worker !== worker) return;
                        const transfer: Transferable[] =
                            responseData instanceof Uint8Array &&
                            responseData.buffer instanceof ArrayBuffer
                                ? [responseData.buffer]
                                : [];
                        worker.postMessage(
                            {
                                responseID: message.id,
                                data: responseData,
                                error: responseError,
                            },
                            transfer,
                        );
                    }
                })();
            },
        );
        worker.addEventListener("error", (event) => {
            if (this._worker !== worker) return;
            this.resetWorker();
            this.parentHost.log(
                "error",
                `Document Worker error (${event.filename}:${event.lineno}): ${event.message}`,
                "DocumentWorkerService",
                event,
            );
        });
    }

    private resetWorker(): void {
        this.workerEpoch++;
        this._worker?.terminate();
        this._worker = null;
        for (const waiting of Object.values(this._waitingPromises))
            waiting.reject(new Error("Document Worker stopped"));
        this._waitingPromises = {};
        const lease = this.sdtLease;
        this.sdtLease = undefined;
        if (lease)
            void lease
                .then((value) =>
                    this.parentHost.releaseEnhancementResources(value.leaseId),
                )
                .catch((error: unknown) => {
                    this.parentHost.log(
                        "debug",
                        "SDT resource session ended",
                        "DocumentWorkerService",
                        error,
                    );
                });
    }

    dispose(): void {
        this.disposed = true;
        this.resetWorker();
    }

    /**
     * Export PDF file with annotations.
     *
     * @param buf The PDF file buffer
     * @param items Annotation items to embed
     * @param isPriority Whether to prioritize this export
     * @returns The exported PDF buffer
     */
    async export(
        buf: ArrayBuffer,
        items: IDBZoteroItem<AnnotationData>[],
        isPriority?: boolean,
    ): Promise<ArrayBuffer> {
        return this._enqueue(async () => {
            // ... (Logic extracted from original file, largely database independent logic)
            // Need to verify if `items` are raw objects or Dexie objects depending on worker
            // But they are passed as arguments.

            const internalItems = items.filter(
                (item) => !item.raw.data.annotationIsExternal,
            );
            const annotations: ExportAnnotation[] = [];
            for (const item of internalItems) {
                annotations.push({
                    id: item.key,
                    type: item.raw.data.annotationType,
                    authorName: item.raw.data.annotationAuthorName || "",
                    comment: (item.raw.data.annotationComment || "").replace(
                        /<\/?(i|b|sub|sup)>/g,
                        "",
                    ),
                    color: item.raw.data.annotationColor,
                    position:
                        typeof item.raw.data.annotationPosition === "string"
                            ? parseJson(item.raw.data.annotationPosition)
                            : item.raw.data.annotationPosition,
                    dateModified: item.raw.data.dateModified,
                    tags: item.raw.data.tags.map((x) => x.tag),
                });
            }

            let response: BufferResponse;
            try {
                response = await this._query<BufferResponse>(
                    "pdf.writeAnnotations",
                    { buf, annotations },
                    [buf],
                );
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "DocumentWorkerService",
                    "PDF Export failed",
                );
            }
            return response.buf;
        }, isPriority);
    }

    /**
     * Import annotations from PDF file
     */
    async import(
        buf: ArrayBuffer,
        options: PDFImportOptions = {},
    ): Promise<PDFImportResult> {
        return this._enqueue(async () => {
            let response: ImportResponse;
            try {
                response = await this._query<ImportResponse>(
                    "pdf.importAnnotations",
                    {
                        buf,
                        existingAnnotations: options.existingAnnotations ?? [],
                        password: options.password,
                        transfer: options.transfer ?? false,
                    },
                    [buf],
                );
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "DocumentWorkerService",
                    "PDF Import failed",
                );
            }

            // Document Worker emits raw PDF annotations. Normalize the fields
            // whose representation differs from the Reader bridge contract.
            const annotations: AnnotationJSON[] = [];
            const generatedKeys = new Set(options.reservedIDs ?? []);
            for (const annotation of response.imported) {
                const dateModified = annotation.dateModified ?? "";
                // A PDF annotation records only a modification stamp.
                const dateAdded = annotation.dateAdded ?? dateModified;
                let id = generateAnnotationKey();
                while (generatedKeys.has(id)) {
                    id = generateAnnotationKey();
                }
                generatedKeys.add(id);
                annotations.push({
                    ...annotation,
                    id,
                    isExternal: true,
                    tags: (annotation.tags ?? []).map((name) => ({ name })),
                    dateModified,
                    dateAdded,
                });
            }
            return {
                imported: annotations,
                deleted: response.deleted ?? [],
                ...(response.buf ? { buf: response.buf } : {}),
            };
        }, options.isPriority);
    }

    /**
     * Build Zotero's structured-document-text payload for a PDF or EPUB.
     * The optional model/ONNX resources are resolved through FetchData, so a
     * caller can install an Enhancement Pack without changing this protocol.
     */
    async getStructuredDocumentText(
        buf: ArrayBuffer,
        options: StructuredDocumentTextOptions,
    ): Promise<ArrayBuffer> {
        if (!options.contentType.trim()) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "DocumentWorkerService",
                "Structured document content type is required",
            );
        }
        if (!/^[0-9a-f]{32}$/.test(options.sourceHash)) {
            throw new ZotFlowError(
                ZotFlowErrorCode.PARSE_ERROR,
                "DocumentWorkerService",
                "Structured document source hash must be a lowercase MD5",
            );
        }

        return this._enqueue(async () => {
            try {
                const response = await this._query<BufferResponse>(
                    "getStructuredDocumentText",
                    {
                        buf,
                        contentType: options.contentType,
                        password: options.password,
                        sourceHash: options.sourceHash,
                        reportProgress:
                            typeof options.onProgress === "function",
                    },
                    [buf],
                    { onProgress: options.onProgress },
                );
                return response.buf;
            } catch (e) {
                // A failed SDT run may leave partially initialized models. Rebuild
                // its Worker before retrying so resources cannot mix generations.
                this.resetWorker();
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "DocumentWorkerService",
                    "Structured document text generation failed",
                );
            }
        }, options.isPriority);
    }

    /**
     * Rotate pages in PDF attachment
     */
    async rotatePages(
        buf: ArrayBuffer,
        pageIndexes: number[],
        degrees: 90 | 180 | 270,
        isPriority?: boolean,
        password?: string,
    ): Promise<ArrayBuffer> {
        return this._enqueue(async () => {
            let modifiedBuf: ArrayBuffer;
            try {
                ({ buf: modifiedBuf } = await this._query<BufferResponse>(
                    "pdf.rotatePages",
                    {
                        buf,
                        pageIndexes,
                        degrees,
                        password,
                    },
                    [buf],
                ));
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "DocumentWorkerService",
                    "Rotate Pages failed",
                );
            }

            return modifiedBuf;
        }, isPriority);
    }

    /**
     * Get data for recognizer-server
     */
    async getRecognizerData(
        buf: ArrayBuffer,
        isPriority?: boolean,
        password?: string,
    ): Promise<PDFRecognizerData> {
        return this._enqueue(async () => {
            let result: PDFRecognizerData;
            try {
                result = await this._query<PDFRecognizerData>(
                    "pdf.getRecognizerData",
                    { buf, password },
                    [buf],
                );
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "DocumentWorkerService",
                    "Get Recognizer Data failed",
                );
            }
            return result;
        }, isPriority);
    }

    /**
     * Get rendered annotations
     */
    async renderAnnotations(
        libraryID: number,
        buf: ArrayBuffer,
        annotations: AnnotationJSON[],
        password?: string,
    ): Promise<number> {
        return this._enqueue(async () => {
            let result: number;
            try {
                result = await this._query<number>(
                    "pdf.renderAnnotations",
                    { libraryID, buf, annotations, password },
                    [buf],
                );
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.PARSE_ERROR,
                    "DocumentWorkerService",
                    "Render Annotations failed",
                );
            }
            return result;
        });
    }
}
