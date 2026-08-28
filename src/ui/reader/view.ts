import { ItemView, WorkspaceLeaf } from "obsidian";
import { workerBridge } from "bridge";
import { IframeReaderBridge } from "./bridge";
import { copyAnnotationOnCreate } from "./auto-copy";
import { services } from "services/services";
import { invalidateTagAutocompleteCache } from "ui/search/autocomplete-data";
import { ViewStateService } from "services/view-state-service";
import { openSourceNote } from "utils/viewer";
import { TagEditModal } from "ui/modals/tag-edit";

import type { ViewStateResult } from "obsidian";
import type { AttachmentData, AnnotationData } from "types/zotero-item";
import type { IDBZoteroItem, IDBZoteroKey } from "types/db-schema";
import type {
    AnnotationJSON,
    ColorScheme,
    CreateReaderOptions,
    CustomReaderTheme,
    ReaderNavigation,
} from "types/zotero-reader";
import type { ITaskInfo } from "types/tasks";
import type { ReaderDocumentLease } from "services/reader-document-cache";
import { getLibraryReaderDocumentKey } from "services/reader-document-cache";
import {
    ZotFlowError,
    ZotFlowErrorCode,
    errorMessage as describeError,
} from "utils/error";
import { fireAndForgetIn } from "utils/fire-and-forget";
import { redirectDuplicateReaderLeaf } from "utils/reader-leaf-navigation";

/** View type identifier for the Zotero cloud reader view. */
export const ZOTERO_READER_VIEW_TYPE = "zotflow-zotero-reader-view";

interface ReaderViewState extends Record<string, unknown> {
    libraryID: number;
    itemKey: string;
}

/** Obsidian `ItemView` that embeds the Zotero reader iframe for remote/cloud attachments. */
const ff = fireAndForgetIn("ZoteroReaderView");

/** In-flight setState calls, keyed by `libraryID:itemKey`, to close a race
 * between two concurrent opens of the same attachment. */
const openingReaders = new Map<string, WorkspaceLeaf>();

export class ZoteroReaderView extends ItemView {
    private attachmentItem: IDBZoteroItem<AttachmentData>;
    private keyInfo: IDBZoteroKey;

    private bridge?: IframeReaderBridge;
    private colorScheme: ColorScheme = "light"; // Default to light
    private unsubscribeTaskMonitor?: () => void;
    private unsubscribeAnnotationChanged?: () => void;
    private lastSyncTaskStatuses = new Map<string, ITaskInfo["status"]>();
    /** Actual MD5 of the PDF bytes used to initialise the reader. */
    private fileContentMD5?: string;
    private knownAnnotationIds = new Set<string>();
    private documentLease?: ReaderDocumentLease;
    private closing = false;
    private readerState: ReaderViewState = { libraryID: 0, itemKey: "" };

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
        this.addAction(
            "notebook-text",
            "Open source note",
            this.handleOpenSourceNote.bind(this),
        );
    }

    /**
     * Resolve and open the source note linked to this attachment's parent item.
     */
    private async handleOpenSourceNote() {
        if (!this.attachmentItem) return;
        const parentKey =
            this.attachmentItem.parentItem === ""
                ? this.attachmentItem.key
                : this.attachmentItem.parentItem;
        const file = services.indexService.getFileByKey(parentKey);
        if (!file) {
            services.notificationService.notify(
                "warning",
                "No source note found for this item.",
            );
            return;
        }
        await openSourceNote(file, this.app);
    }

    getViewType() {
        return ZOTERO_READER_VIEW_TYPE;
    }

    getDisplayText() {
        return (
            this.attachmentItem?.raw.data.filename ??
            this.attachmentItem?.raw.data.title ??
            "Zotero Reader"
        );
    }

    getIcon() {
        return "book-open";
    }

    /**
     * Use Obsidian-like link handling: absolute URLs open externally,
     * while vault-style links are resolved through the workspace.
     */
    private handleOpenLink(url: string) {
        const href = url.trim();
        if (!href) return;

        // URL with a scheme (https:, file:, mailto:, obsidian:, zotero:, etc.)
        // should be delegated to the host OS/browser.
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            window.open(href, "_blank", "noopener,noreferrer");
            return;
        }

        // Treat scheme-less links as Obsidian/vault links.
        void this.app.workspace.openLinkText(href, "", true);
    }

    async setState(
        state: ReaderViewState,
        result: ViewStateResult,
    ): Promise<void> {
        this.readerState = state;

        // Single-instance guard: reveal an existing reader for this attachment
        // and close the duplicate leaf before any async work starts.
        const key = this.readerKey(state);
        const existing = this.findExistingReaderLeaf(state);
        if (existing && existing !== this.leaf) {
            services.logService.warn(
                `Attachment ${key} is already open; reusing existing reader leaf`,
                "ZoteroReaderView",
            );
            services.notificationService.notify(
                "warning",
                "This attachment is already open. Use the reader's built-in split view to open two views of the same attachment.",
            );
            ff(
                redirectDuplicateReaderLeaf(
                    this.app.workspace,
                    this.leaf,
                    existing,
                ),
                "Failed to redirect a duplicate reader leaf",
            );
            return;
        }

        openingReaders.set(key, this.leaf);
        try {
            const _keyInfo = await workerBridge.annotation.getKeyInfo(
                services.settings.zoteroapikey,
            );

            if (!_keyInfo) {
                services.logService.error(
                    `Key ${services.settings.zoteroapikey} doesn't exist`,
                    "ZoteroReaderView",
                );
                throw new Error(
                    `Key ${services.settings.zoteroapikey} doesn't exist`,
                );
            }

            if (state.itemKey) {
                const _item = await workerBridge.dbHelper.getAttachmentItem(
                    state.libraryID,
                    state.itemKey,
                );
                if (!_item) {
                    services.logService.error(
                        `Item ${state.itemKey} doesn't exist or is not an attachment`,
                        "ZoteroReaderView",
                    );
                    throw new Error(
                        `Item ${state.itemKey} doesn't exist or is not an attachment`,
                    );
                }
                this.attachmentItem = _item;

                this.keyInfo = _keyInfo;
                this.containerEl
                    .getElementsByClassName("view-header-title")[0]
                    ?.setText(
                        this.attachmentItem.raw.data.filename ??
                            this.attachmentItem.raw.data.title ??
                            "Zotero Reader",
                    );
                ff(this.loadDocument(), "Failed to load document");
            }

            await super.setState(state, result);
        } finally {
            if (openingReaders.get(key) === this.leaf) {
                openingReaders.delete(key);
            }
        }
    }

    private readerKey(state: ReaderViewState): string {
        return `${state.libraryID}:${state.itemKey}`;
    }

    /** Find another leaf already showing, or currently opening, this attachment. */
    private findExistingReaderLeaf(state: ReaderViewState): WorkspaceLeaf | null {
        for (const leaf of this.app.workspace.getLeavesOfType(
            ZOTERO_READER_VIEW_TYPE,
        )) {
            if (leaf === this.leaf) continue;
            const leafState = leaf.getViewState().state as
                | Partial<ReaderViewState>
                | null
                | undefined;
            if (
                leafState?.libraryID === state.libraryID &&
                leafState?.itemKey === state.itemKey
            ) {
                return leaf;
            }
        }

        return openingReaders.get(this.readerKey(state)) ?? null;
    }

    private async loadDocument() {
        const container = this.contentEl;
        container.empty();

        const loadingEl = container.createDiv({ cls: "zotflow-loading" });
        loadingEl.setText(`Downloading/Loading ${this.attachmentItem.key}...`);

        // Try force update the source note
        workerBridge.libraryNote
            .triggerUpdate(
                this.attachmentItem.libraryID,
                this.attachmentItem.parentItem !== ""
                    ? this.attachmentItem.parentItem
                    : this.attachmentItem.key,
            )
            .catch((e) => {
                services.logService.error(
                    "Failed to trigger source note update",
                    "ZoteroReaderView",
                    e,
                );

                services.notificationService.notify(
                    "warning",
                    "Failed to auto-update source note",
                );
            });

        ff(this.renderReader(), "Failed to render the reader");
    }

    private async renderReader() {
        const container = this.contentEl;
        let acquiredLease: ReaderDocumentLease | undefined;
        let leaseInstalled = false;
        let readerInitialized = false;

        // Resolve initial color scheme based on setting
        const schemeSetting = services.settings.readerColorScheme;
        if (schemeSetting === "light") {
            this.colorScheme = "light";
        } else if (schemeSetting === "dark") {
            this.colorScheme = "dark";
        } else {
            this.colorScheme = getComputedStyle(document.body)
                .colorScheme as ColorScheme;
        }

        try {
            const revision =
                await workerBridge.attachment.getReaderDocumentRevision(
                    this.attachmentItem,
                );
            const documentKey = getLibraryReaderDocumentKey(
                this.attachmentItem,
                revision.kind === "external" ? revision : undefined,
            );

            // Create bridge once
            if (!this.bridge) {
                this.bridge = new IframeReaderBridge(
                    container,
                    false,
                    this.attachmentItem,
                );

                // Register event listeners
                this.bridge.onEventType("error", (evt) => {
                    services.logService.error(
                        `Reader error ${evt.code}: ${evt.message}`,
                        "ZoteroReaderView",
                    );
                });

                // Sidebar geometry is not persisted yet — `CreateReaderOptions`
                // has `sidebarOpen`/`sidebarWidth` but nothing writes them to
                // ViewStateService. Kept as debug traces so the hook stays
                // visible for whoever wires that up.
                this.bridge.onEventType("sidebarToggled", (evt) => {
                    services.logService.debug(
                        `Sidebar toggled: ${evt.open}`,
                        "ZoteroReaderView",
                    );
                });

                this.bridge.onEventType("sidebarWidthChanged", (evt) => {
                    services.logService.debug(
                        `Sidebar width changed: ${evt.width}`,
                        "ZoteroReaderView",
                    );
                });

                this.bridge.onEventType("openLink", (evt) => {
                    this.handleOpenLink(evt.url);
                });

                this.bridge.onEventType("annotationsSaved", (evt) => {
                    ff(
                        this.handleAnnotationsSaved(evt.annotations),
                        "Failed to apply saved annotations",
                    );
                });

                this.bridge.onEventType("annotationsDeleted", (evt) => {
                    ff(
                        this.handleAnnotationsDeleted(evt.ids),
                        "Failed to apply deleted annotations",
                    );
                });

                this.bridge.onEventType("viewStateChanged", (evt) => {
                    this.handleViewStateChanged(evt.state, evt.primary);
                });

                this.bridge.onEventType("saveCustomThemes", (evt) => {
                    services.viewStateService.saveCustomThemes(
                        evt.customThemes as CustomReaderTheme[],
                    );
                });

                this.bridge.onEventType("setLightTheme", (evt) => {
                    this.handleSetTheme("light", evt.theme);
                });

                this.bridge.onEventType("setDarkTheme", (evt) => {
                    this.handleSetTheme("dark", evt.theme);
                });

                //     onOpenTagsPopup: (annotationID, left, top) => {
                // 	this.emit({ type: "openTagsPopup", annotationID, left, top });
                // },
                this.bridge.onEventType("openTagsPopup", (evt) => {
                    void this.handleOpenTagsPopup(evt.annotationID);
                });

                // Observe color scheme changes via Obsidian's css-change event
                // Only monitor when following Obsidian scheme
                if (
                    schemeSetting === "obsidian" ||
                    schemeSetting === "obsidian-theme"
                ) {
                    this.registerEvent(
                        this.app.workspace.on("css-change", () => {
                            if (
                                schemeSetting === "obsidian" ||
                                schemeSetting === "obsidian-theme"
                            ) {
                                const newColorScheme = getComputedStyle(
                                    document.body,
                                ).colorScheme as ColorScheme;
                                if (
                                    newColorScheme &&
                                    newColorScheme !== this.colorScheme
                                ) {
                                    ff(
                                        this.bridge!.setColorScheme(
                                            newColorScheme,
                                        ),
                                        "Failed to set the reader colour scheme",
                                    );
                                    this.colorScheme = newColorScheme;
                                }
                            }
                        }),
                    );
                }
            }

            // Connect and acquire the shared document concurrently. Only the
            // first Reader for this attachment version invokes the worker.
            const leasePromise = services.readerDocumentCache.acquire(
                documentKey,
                async () => {
                    try {
                        return await workerBridge.downloadAttachment(
                            this.attachmentItem,
                        );
                    } catch (e) {
                        services.logService.error(
                            "Failed to download attachment",
                            "ZoteroReaderView",
                            e,
                        );
                        services.notificationService.notify(
                            "error",
                            "Failed to download attachment",
                        );
                        throw e;
                    }
                },
                { reuse: revision.kind !== "volatile" },
            );
            try {
                const [, lease] = await Promise.all([
                    this.bridge.connect(),
                    leasePromise,
                ]);
                acquiredLease = lease;
            } catch (e) {
                // If bridge connection failed first, release the document when
                // its in-flight load eventually settles.
                void leasePromise
                    .then((lease) => lease.release())
                    .catch(() => undefined);
                throw e;
            }

            if (this.closing) {
                acquiredLease.release();
                acquiredLease = undefined;
                return;
            }

            // Get Annotations
            const annotationJson = await workerBridge.annotation.getAnnotations(
                this.attachmentItem,
                services.settings.zoteroapikey,
            );
            // Seed known-annotation set so the initial load isn't auto-copied.
            this.knownAnnotationIds = new Set(
                annotationJson.map((a: AnnotationJSON) => a.id),
            );

            // Another overlapping render may already own the View's lease.
            if (
                this.bridge.state !== "bridge-ready" ||
                this.documentLease
            ) {
                acquiredLease.release();
                acquiredLease = undefined;
                return;
            }

            this.documentLease = acquiredLease;
            acquiredLease = undefined;
            leaseInstalled = true;

            const savedViewState = services.viewStateService.getViewState(
                ViewStateService.remoteKey(
                    this.attachmentItem.libraryID,
                    this.attachmentItem.key,
                ),
            );

            const themeDefaults = {
                lightTheme: services.settings.defaultLightTheme,
                darkTheme: services.settings.defaultDarkTheme,
            };

            // User's saved theme takes top priority
            const themeOverrides = {
                lightTheme:
                    savedViewState?.lightTheme ?? themeDefaults.lightTheme,
                darkTheme:
                    savedViewState?.darkTheme ?? themeDefaults.darkTheme,
            };

            const libID = this.attachmentItem.libraryID;
            // Read-only when sync mode is read-only
            const isReadOnly = services.libraryCache.isReadOnly(libID);

            const autoDisable =
                services.settings.autoDisableNoteImageTextTools;
            const opts: Partial<CreateReaderOptions> = {
                annotations: annotationJson,
                primaryViewState: savedViewState?.primaryViewState,
                colorScheme: this.colorScheme,
                customThemes: services.viewStateService.getCustomThemes(),
                autoDisableNoteTool: autoDisable,
                autoDisableTextTool: autoDisable,
                autoDisableImageTool: autoDisable,
                fontFamily: services.settings.epubFontFamily || undefined,
                ...themeOverrides,
                ...(isReadOnly ? { readOnly: true } : {}),
            };

            const contentType = this.attachmentItem.raw.data.contentType;
            let type: "pdf" | "epub" | "snapshot" | "paperclip";
            switch (contentType) {
                case "application/pdf":
                    type = "pdf";
                    break;
                case "application/epub+zip":
                    type = "epub";
                    break;
                case "text/html":
                    type = "snapshot";
                    break;
                default:
                    services.logService.error(
                        `Unknown content type: ${contentType}`,
                        "ZoteroReaderView",
                    );
                    throw new ZotFlowError(
                        ZotFlowErrorCode.UNKNOWN,
                        `Unknown content type: ${contentType}`,
                        "ZoteroReaderView",
                        {
                            attachmentItem: this.attachmentItem,
                        },
                    );
            }

            const authorName =
                this.attachmentItem.raw.library.type === "group"
                    ? this.keyInfo.username || ""
                    : "";

            this.fileContentMD5 = this.documentLease.contentMD5;
            await this.bridge.initReader({
                data: { buf: null, url: this.documentLease.url },
                type: type,
                authorName,
                ...opts,
            });
            readerInitialized = true;

            // Subscribe to sync events for live annotation updates
            this.subscribeToSyncEvents();
            this.subscribeToAnnotationChanges();

            // Extract external annotations
            ff(
                this.extractExternalAnnotation(),
                "Failed to extract external annotations",
            );
        } catch (e) {
            acquiredLease?.release();
            if (leaseInstalled && !readerInitialized) {
                this.releaseDocumentLease();
            }
            if (this.closing) return;
            services.logService.error(
                "Error loading Zotero Reader view",
                "ZoteroReaderView",
                e,
            );
            container.empty();
            const errorMessage = container.createDiv({
                cls: "error-message",
            });
            errorMessage.createDiv().setText("Failed to load Zotero Reader");
            errorMessage
                .createDiv()
                .setText("Error details: " + describeError(e));
        }
    }

    readerNavigate(navigationInfo: ReaderNavigation) {
        if (!this.bridge) return;

        ff(
            this.bridge.navigate(navigationInfo),
            "Failed to navigate the reader",
        );
    }

    getState(): ReaderViewState {
        return this.readerState;
    }

    async onClose() {
        this.closing = true;
        this.unsubscribeTaskMonitor?.();
        this.unsubscribeAnnotationChanged?.();
        this.unsubscribeTaskMonitor = undefined;
        this.unsubscribeAnnotationChanged = undefined;
        try {
            if (this.bridge) {
                await this.bridge.dispose();
            }
        } finally {
            this.bridge = undefined;
            this.releaseDocumentLease();
        }

        this.fileContentMD5 = undefined;
        this.knownAnnotationIds.clear();
        this.lastSyncTaskStatuses.clear();

        // Flush view state on close to ensure latest state is saved
        services.viewStateService.flushViewStateSave();
    }

    private releaseDocumentLease(): void {
        this.documentLease?.release();
        this.documentLease = undefined;
    }

    /**
     * Persist the reader's view state to data.json.
     */
    private handleViewStateChanged(state: unknown, primary: boolean) {
        if (!this.attachmentItem) return;

        services.viewStateService.saveViewState(
            ViewStateService.remoteKey(
                this.attachmentItem.libraryID,
                this.attachmentItem.key,
            ),
            primary,
            state as Record<string, unknown>,
        );

        // Keep the bridge's replay cache current. If Obsidian reparents this
        // panel (split / pop-out) the iframe reloads and the bridge re-inits the
        // reader from that cache — without this it would jump back to wherever
        // the file was when it was opened.
        this.bridge?.updateReaderOpts(
            primary
                ? { primaryViewState: state as Record<string, unknown> }
                : { secondaryViewState: state as Record<string, unknown> },
        );
    }

    /**
     * Subscribe to TaskMonitor and refresh annotations in the reader
     * when a sync task that covers this attachment's library completes.
     */
    private subscribeToSyncEvents() {
        // Avoid double-subscribe
        this.unsubscribeTaskMonitor?.();

        // Snapshot current task statuses so the initial callback
        // (fired immediately by subscribe()) is a no-op.
        for (const task of services.taskMonitor.getTasks()) {
            this.lastSyncTaskStatuses.set(task.id, task.status);
        }

        this.unsubscribeTaskMonitor = services.taskMonitor.subscribe(
            (tasks: ITaskInfo[]) => {
                for (const task of tasks) {
                    if (task.type !== "sync") continue;

                    const prev = this.lastSyncTaskStatuses.get(task.id);
                    this.lastSyncTaskStatuses.set(task.id, task.status);

                    // Only act on a transition *into* "completed"
                    if (task.status !== "completed" || prev === "completed")
                        continue;

                    // Check if the sync covers this attachment's library
                    const taskLibId = task.input?.["libraryId"];
                    if (
                        taskLibId !== undefined &&
                        taskLibId !== this.attachmentItem.libraryID
                    ) {
                        continue; // Sync was for a different library
                    }

                    services.logService.info(
                        `Sync completed — refreshing reader annotations (task ${task.id})`,
                        "ZoteroReaderView",
                    );

                    // Refresh the attachment item from IDB to pick up
                    // any metadata changes from sync (e.g. MD5, filename).
                    ff(
                        this.refreshAttachmentItem().then(() => {
                            // Refresh annotations from IDB without reconnecting
                            ff(
                                this.refreshAnnotationsFromDB(),
                                "Failed to refresh reader annotations after sync",
                            );

                            // Re-extract external annotations in case the file changed
                            ff(
                                this.extractExternalAnnotation(),
                                "Failed to re-extract external annotations",
                            );
                        }),
                        "Failed to refresh the attachment after sync",
                    );

                    // One refresh per update batch is enough
                    break;
                }
            },
        );
    }

    /**
     * Subscribe to annotation-changed events (fired when the user edits
     * an ANNO region in the markdown source note).  The upstream editor
     * sync plugin already debounces at 2 s, so we refresh immediately.
     */
    private subscribeToAnnotationChanges() {
        this.unsubscribeAnnotationChanged?.();

        this.unsubscribeAnnotationChanged =
            services.taskMonitor.annotationChanged.subscribe(
                (libraryID, _annotationKey, parentItemKey) => {
                    if (libraryID !== this.attachmentItem.libraryID) return;
                    if (parentItemKey !== this.attachmentItem.key) return;

                    this.refreshAnnotationsFromDB().catch((e) => {
                        services.logService.error(
                            "Failed to refresh reader annotations after markdown edit",
                            "ZoteroReaderView",
                            e,
                        );
                    });
                },
            );
    }

    /**
     * Re-read annotations from IDB and push them to the reader iframe
     * without tearing down the bridge.
     */
    private async refreshAnnotationsFromDB() {
        if (!this.bridge || this.bridge.state !== "reader-ready") return;

        const annotations = await workerBridge.annotation.getAnnotations(
            this.attachmentItem,
            services.settings.zoteroapikey,
        );

        await this.bridge.refreshAnnotations(annotations);
    }

    /**
     * Refresh the in-memory attachmentItem from IDB to pick up any
     * metadata changes (e.g. MD5, filename) after a sync.
     */
    private async refreshAttachmentItem() {
        const freshItem = await workerBridge.dbHelper.getAttachmentItem(
            this.attachmentItem.libraryID,
            this.attachmentItem.key,
        );
        if (freshItem) {
            this.attachmentItem = freshItem;
        }
    }

    private async extractExternalAnnotation() {
        const isPDF =
            this.attachmentItem.raw.data.contentType === "application/pdf";
        if (!isPDF) return;

        const currentMD5 =
            this.attachmentItem.raw.data.md5 || this.fileContentMD5;
        const lastExtractionMD5 =
            this.attachmentItem.externalAnnotationExtractionFileMD5;

        // Fast pre-check: only skip when server MD5 is available and matches.
        if (currentMD5 && currentMD5 === lastExtractionMD5) {
            services.logService.log(
                "debug",
                "Skipping annotation extraction (MD5 match)",
                "ZoteroReaderView",
            );
            return;
        }

        try {
            const annotations = await workerBridge.extractExternalAnnotations([
                {
                    libraryID: this.attachmentItem.libraryID,
                    itemKey: this.attachmentItem.key,
                    precomputedMD5: this.fileContentMD5,
                },
            ]);

            // The worker has atomically reconciled imported/deleted rows and
            // the source MD5. Replace the Reader snapshot from IDB so both
            // additions and removals become visible together.
            await this.refreshAnnotationsFromDB();

            // Refresh the in-memory extraction MD5 from IDB so subsequent
            // calls within the same session can skip via the fast pre-check.
            await this.refreshAttachmentItem();

            services.logService.log(
                "debug",
                `External annotations extracted: ${annotations.length}`,
                "ZoteroReaderView",
            );
        } catch (e) {
            services.logService.error(
                "Failed to extract external annotations",
                "ZoteroReaderView",
                e,
            );
            services.notificationService.notify(
                "error",
                "Failed to extract external annotations",
            );
        }
    }

    /**
     * Persist a theme choice to the view state.
     */
    private handleSetTheme(kind: "light" | "dark", theme: unknown) {
        if (!this.attachmentItem) return;
        services.viewStateService.saveTheme(
            ViewStateService.remoteKey(
                this.attachmentItem.libraryID,
                this.attachmentItem.key,
            ),
            kind,
            theme,
        );
    }

    /**
     * Handle saved/updated annotations
     */
    private async handleAnnotationsSaved(annotations: AnnotationJSON[]) {
        try {
            await workerBridge.annotation.saveAnnotations(
                this.attachmentItem,
                this.keyInfo,
                annotations,
            );
        } catch (e) {
            services.logService.error(
                "Failed to save annotations",
                "ZoteroReaderView",
                e,
            );
            services.notificationService.notify(
                "error",
                "Failed to save annotations",
            );
        }

        // Auto-copy newly created annotations (creation only — skips edits).
        const created = annotations.filter(
            (a) => !this.knownAnnotationIds.has(a.id),
        );
        // Update the known set for both newly-created and re-saved annotations
        // so subsequent edits aren't mistaken for creations.
        for (const a of annotations) this.knownAnnotationIds.add(a.id);
        if (created.length > 0) {
            const parentKey =
                this.attachmentItem.parentItem === ""
                    ? this.attachmentItem.key
                    : this.attachmentItem.parentItem;
            const sourceNotePath =
                services.indexService.getFileByKey(parentKey)?.path;
            for (const annotation of created) {
                await copyAnnotationOnCreate(annotation, {
                    sourceNotePath,
                    parentItemKey: parentKey,
                    libraryID: this.attachmentItem.libraryID,
                    attachmentKey: this.attachmentItem.key,
                });
            }
        }
    }

    /**
     * Handle deleted annotations
     */
    private async handleAnnotationsDeleted(ids: string[]) {
        try {
            await workerBridge.annotation.deleteAnnotations(
                this.attachmentItem,
                ids,
            );
        } catch (e) {
            services.logService.error(
                "Failed to delete annotations",
                "ZoteroReaderView",
                e,
            );
            services.notificationService.notify(
                "error",
                "Failed to delete annotations",
            );
        }
    }

    /**
     * Open the tag editor for a single annotation when the reader requests it.
     * Tags are persisted via the shared `TagService.setItemTags` (annotations
     * are regular items in IDB), then pushed back to the reader and the owning
     * source note is re-rendered when one exists.
     */
    private async handleOpenTagsPopup(annotationID: unknown) {
        if (!this.attachmentItem) return;

        const annotationKey = String(annotationID);
        const libraryID = this.attachmentItem.libraryID;

        try {
            const annoItem = await workerBridge.dbHelper.getItem(
                libraryID,
                annotationKey,
            );
            if (!annoItem || annoItem.itemType !== "annotation") {
                services.notificationService.notify(
                    "warning",
                    "Annotation not found.",
                );
                return;
            }

            const data = annoItem.raw.data;
            const current = data.tags ?? [];
            const all = await workerBridge.tag.getTagNames();

            new TagEditModal(this.app, {
                itemTitle: this.describeAnnotation(data),
                initialTags: current,
                suggestions: all,
                onSave: async (tags) => {
                    await workerBridge.tag.setItemTags(
                        libraryID,
                        annotationKey,
                        tags,
                    );
                    invalidateTagAutocompleteCache();

                    // Push updated tags back into the reader iframe.
                    await this.refreshAnnotationsFromDB();

                    // Re-render the owning source note if one already exists
                    // (never create a new one here).
                    const paperKey =
                        this.attachmentItem.parentItem !== ""
                            ? this.attachmentItem.parentItem
                            : this.attachmentItem.key;
                    try {
                        if (services.indexService.getFileByKey(paperKey)) {
                            await workerBridge.libraryNote.triggerUpdate(
                                libraryID,
                                paperKey,
                                { forceUpdateContent: true },
                            );
                        }
                    } catch {
                        // Index not ready / no note — ignore.
                    }

                    // services.notificationService.notify(
                    //     "success",
                    //     "Tags updated.",
                    // );
                },
            }).open();
        } catch (e) {
            services.logService.error(
                "Failed to open annotation tag editor",
                "ZoteroReaderView",
                e,
            );
            services.notificationService.notify(
                "error",
                "Failed to open tag editor.",
            );
        }
    }

    /**
     * Build a short, human-readable label for an annotation to show as the
     * tag-editor subtitle (e.g. `Highlight: "some text"`).
     */
    private describeAnnotation(data: AnnotationData): string {
        const type = data.annotationType || "annotation";
        const label = type.charAt(0).toUpperCase() + type.slice(1);
        const text = (
            data.annotationText ||
            data.annotationComment ||
            ""
        ).trim();
        if (!text) return label;
        const truncated = text.length > 80 ? text.slice(0, 80) + "…" : text;
        return `${label}: ${truncated}`;
    }
}
