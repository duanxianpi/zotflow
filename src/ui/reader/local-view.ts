import { WorkspaceLeaf, TFile, ItemView } from "obsidian";
import { workerBridge } from "bridge";
import { IframeReaderBridge } from "./bridge";
import { LocalDataManager } from "./local-data-manager";
import { copyAnnotationOnCreate } from "./auto-copy";
import { getLinkedLocalSourceNote } from "utils/file";
import { openSourceNote } from "utils/viewer";
import { TagEditModal } from "ui/modals/tag-edit";

import type {
    CreateReaderOptions,
    ColorScheme,
    AnnotationJSON,
    CustomReaderTheme,
    ReaderNavigation,
} from "types/zotero-reader";
import type { ViewStateResult } from "obsidian";
import type { TagInput } from "worker/services/tag";
import type { ReaderDocumentLease } from "services/reader-document-cache";
import { services } from "services/services";
import {
    getLocalReaderDocumentFormat,
    getLocalReaderDocumentKey,
} from "services/reader-document-cache";
import { errorMessage as describeError } from "utils/error";
import { fireAndForgetIn } from "utils/fire-and-forget";
import { redirectDuplicateReaderLeaf } from "utils/reader-leaf-navigation";

/** View type identifier for the local vault file reader view. */
export const LOCAL_ZOTERO_READER_VIEW_TYPE = "zotflow-local-zotero-reader-view";

/** Persisted view state: the vault path of the file being read. */
interface LocalReaderViewState extends Record<string, unknown> {
    file?: string;
}

/** Obsidian `ItemView` that embeds the Zotero reader iframe for local PDF/EPUB/HTML vault files. */
const ff = fireAndForgetIn("LocalReaderView");

/** In-flight setState calls, keyed by vault path, to close a race between two
 * concurrent opens of the same local file. */
const openingLocalReaders = new Map<string, WorkspaceLeaf>();

export class LocalReaderView extends ItemView {
    private file: TFile | null = null;
    private bridge?: IframeReaderBridge;
    private colorScheme: ColorScheme = "light"; // Default to light
    private readerOptions: Partial<CreateReaderOptions> = {};
    private dataManager?: LocalDataManager;
    private knownAnnotationIds = new Set<string>();
    private unsubscribeLocalAnnotationChanged?: () => void;
    private documentLease?: ReaderDocumentLease;
    private closing = false;
    private localReaderState: LocalReaderViewState = {};

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
        this.addAction(
            "notebook-text",
            "Open source note",
            this.handleOpenSourceNote.bind(this),
        );
    }

    /**
     * Resolve and open the source note linked to this local attachment.
     */
    private async handleOpenSourceNote() {
        if (!this.file) return;
        const linked = getLinkedLocalSourceNote(services.app, this.file);
        if (!linked) {
            services.notificationService.notify(
                "warning",
                "No source note found for this file.",
            );
            return;
        }
        const file = services.app.vault.getAbstractFileByPath(linked.path);
        if (!(file instanceof TFile)) {
            services.notificationService.notify(
                "warning",
                "Source note file is missing from the vault.",
            );
            return;
        }
        await openSourceNote(file, this.app);
    }

    getViewType() {
        return LOCAL_ZOTERO_READER_VIEW_TYPE;
    }

    getDisplayText() {
        return this.file?.name || "Zotero Reader";
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

    async onOpen() {}

    async setState(state: LocalReaderViewState, result: ViewStateResult) {
        this.localReaderState = state;

        // Single-instance guard: reveal an existing reader for this file and
        // close the duplicate leaf before loading the document again.
        if (state.file) {
            const existing = this.findExistingLocalReaderLeaf(state.file);
            if (existing && existing !== this.leaf) {
                services.logService.warn(
                    `Local attachment ${state.file} is already open; reusing existing reader leaf`,
                    "LocalReaderView",
                );
                services.notificationService.notify(
                    "warning",
                    "This file is already open. Use the reader's built-in split view to open two views of the same file.",
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

            openingLocalReaders.set(state.file, this.leaf);
            try {
                const file = services.app.vault.getAbstractFileByPath(
                    state.file,
                );
                if (file instanceof TFile) {
                    this.file = file;
                    this.containerEl
                        .getElementsByClassName("view-header-title")[0]
                        ?.setText(this.file.name);

                    ff(this.loadDocument(this.file), "Failed to load document");
                }
                await super.setState(state, result);
            } finally {
                if (openingLocalReaders.get(state.file) === this.leaf) {
                    openingLocalReaders.delete(state.file);
                }
            }
            return;
        }
        return super.setState(state, result);
    }

    /** Find another leaf already showing, or currently opening, this file. */
    private findExistingLocalReaderLeaf(path: string): WorkspaceLeaf | null {
        for (const leaf of this.app.workspace.getLeavesOfType(
            LOCAL_ZOTERO_READER_VIEW_TYPE,
        )) {
            if (leaf === this.leaf) continue;
            const leafState = leaf.getViewState().state as
                | Partial<LocalReaderViewState>
                | null
                | undefined;
            if (leafState?.file === path) {
                return leaf;
            }
        }

        return openingLocalReaders.get(path) ?? null;
    }

    getState(): LocalReaderViewState {
        return this.localReaderState;
    }

    private async loadDocument(file: TFile) {
        const container = this.contentEl;
        container.empty();

        const loadingEl = container.createDiv({ cls: "zotflow-loading" });
        loadingEl.setText(`Loading ${file.name}...`);

        try {
            ff(this.renderReader(file), "Failed to render the reader");
        } catch (e) {
            services.logService.error(
                "Error loading document",
                "LocalReaderView",
                e,
            );
            services.notificationService.notify(
                "error",
                "Error loading document",
            );
        }
    }

    private async renderReader(file: TFile) {
        const container = this.contentEl;
        let acquiredLease: ReaderDocumentLease | undefined;
        let leaseInstalled = false;
        let readerInitialized = false;

        try {
            const format = getLocalReaderDocumentFormat(file.extension);
            const documentKey = getLocalReaderDocumentKey(file);

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

            // Create bridge once
            if (!this.bridge) {
                // Initialize data manager
                this.dataManager = new LocalDataManager(file);
                this.subscribeToLocalAnnotationChanges(file);
                this.bridge = new IframeReaderBridge(
                    container,
                    true,
                    undefined,
                    file,
                    this.dataManager,
                );

                // Register event listeners
                this.bridge.onEventType("error", (evt) => {
                    services.logService.error(
                        `Reader error ${evt.code}: ${evt.message}`,
                        "LocalReaderView",
                    );
                });

                // Sidebar geometry is not persisted yet — see the twin in
                // `view.ts`. Kept as debug traces so the hook stays visible.
                this.bridge.onEventType("sidebarToggled", (evt) => {
                    services.logService.debug(
                        `Sidebar toggled: ${evt.open}`,
                        "LocalReaderView",
                    );
                });

                this.bridge.onEventType("sidebarWidthChanged", (evt) => {
                    services.logService.debug(
                        `Sidebar width changed: ${evt.width}`,
                        "LocalReaderView",
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

                this.bridge.onEventType("openTagsPopup", (evt) => {
                    void this.handleOpenTagsPopup(evt.annotationID);
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

                // Observe color scheme changes via Obsidian's css-change event
                // Only monitor when following Obsidian scheme

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
                                    this.bridge!.setColorScheme(newColorScheme),
                                    "Failed to set the reader colour scheme",
                                );
                                this.colorScheme = newColorScheme;
                            }
                        }
                    }),
                );
            }

            // Connect, load annotations, and acquire the shared document in
            // parallel. The cache de-duplicates concurrent reads of this file.
            const leasePromise = services.readerDocumentCache.acquire(
                documentKey,
                async () => {
                    const buffer = await this.app.vault.readBinary(file);
                    return {
                        blob: new Blob([buffer], { type: format.mimeType }),
                    };
                },
            );
            try {
                const [, lease, loadedAnnotations] = await Promise.all([
                    this.bridge.connect(),
                    leasePromise,
                    (async () => {
                        return await this.dataManager?.loadAnnotations();
                    })(),
                ]);
                acquiredLease = lease;

                if (this.closing) {
                    acquiredLease.release();
                    acquiredLease = undefined;
                    return;
                }

                // Seed known-annotation set so the initial load isn't auto-copied.
                this.knownAnnotationIds = new Set(
                    (loadedAnnotations ?? []).map(
                        (a: AnnotationJSON) => a.id,
                    ),
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

                // Read persisted view state (including saved themes)
                const viewState = services.viewStateService.getViewState(
                    file.path,
                );

                const themeDefaults = {
                    lightTheme: services.settings.defaultLightTheme,
                    darkTheme: services.settings.defaultDarkTheme,
                };

                // User's saved theme takes top priority
                const themeOverrides = {
                    lightTheme:
                        viewState?.lightTheme ?? themeDefaults.lightTheme,
                    darkTheme:
                        viewState?.darkTheme ?? themeDefaults.darkTheme,
                };

                const autoDisable =
                    services.settings.autoDisableNoteImageTextTools;
                const opts: Partial<CreateReaderOptions> = {
                    ...this.readerOptions,
                    annotations: loadedAnnotations,
                    colorScheme: this.colorScheme,
                    primaryViewState: viewState?.primaryViewState,
                    customThemes: services.viewStateService.getCustomThemes(),
                    autoDisableNoteTool: autoDisable,
                    autoDisableTextTool: autoDisable,
                    autoDisableImageTool: autoDisable,
                    fontFamily: services.settings.epubFontFamily || undefined,
                    ...themeOverrides,
                };

                await this.bridge.initReader({
                    data: { buf: null, url: this.documentLease.url },
                    type: format.readerType,
                    authorName: "",
                    ...opts,
                });
                readerInitialized = true;
            } catch (e) {
                // If another Promise rejected first, release the lease when its
                // in-flight load eventually settles.
                void leasePromise
                    .then((lease) => lease.release())
                    .catch(() => undefined);
                throw e;
            }
        } catch (e) {
            acquiredLease?.release();
            if (leaseInstalled && !readerInitialized) {
                this.releaseDocumentLease();
            }
            if (this.closing) return;
            services.logService.error(
                "Error loading Zotero Reader view",
                "LocalReaderView",
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

    // Handle navigation info
    setEphemeralState(state: unknown): void {
        const subpath = (state as { subpath?: unknown } | null)?.subpath;
        if (typeof subpath === "string") {
            const navigationInfo = this.parseNavigationInfo(subpath);

            if (navigationInfo) {
                this.readerNavigate(navigationInfo);
            }
        }

        super.setEphemeralState(state);
    }

    // Parse navigation info
    parseNavigationInfo(subpath: string): ReaderNavigation | null {
        //Regex to match annotation=url_encoded_string
        const match = subpath.match(/annotation=([^&]+)/);
        if (match && match[1]) {
            return JSON.parse(decodeURIComponent(match[1])) as ReaderNavigation;
        }
        return null;
    }

    readerNavigate(navigationInfo: ReaderNavigation) {
        if (!this.bridge) return;
        ff(
            this.bridge.navigate(navigationInfo),
            "Failed to navigate the reader",
        );
    }

    async onClose() {
        this.closing = true;
        this.unsubscribeLocalAnnotationChanged?.();
        this.unsubscribeLocalAnnotationChanged = undefined;

        try {
            if (this.bridge) {
                await this.bridge.dispose();
            }
        } finally {
            this.bridge = undefined;
            this.releaseDocumentLease();
        }

        this.dataManager = undefined;
        this.file = null;
        this.knownAnnotationIds.clear();

        // Flush view state on close to ensure latest state is saved
        services.viewStateService.flushViewStateSave();
    }

    private releaseDocumentLease(): void {
        this.documentLease?.release();
        this.documentLease = undefined;
    }

    /**
     * Subscribe to comment edits made from the source note's ANNO editable
     * regions so an open reader reloads the sidecar instead of clobbering
     * the edit with its stale in-memory cache.
     */
    private subscribeToLocalAnnotationChanges(file: TFile) {
        this.unsubscribeLocalAnnotationChanged?.();

        this.unsubscribeLocalAnnotationChanged =
            services.eventHub.localAnnotationChanged.subscribe(
                (attachmentPath) => {
                    if (attachmentPath !== file.path) return;
                    if (!this.dataManager) return;

                    this.dataManager
                        .loadAnnotations()
                        .then((annotations) =>
                            this.bridge?.refreshAnnotations(annotations),
                        )
                        .catch((e) => {
                            services.logService.error(
                                "Failed to refresh local reader annotations after markdown edit",
                                "LocalReaderView",
                                e,
                            );
                        });
                },
            );
    }

    /**
     * Persist the reader's view state to data.json.
     */
    private handleViewStateChanged(state: unknown, primary: boolean) {
        if (!this.file) return;
        services.viewStateService.saveViewState(
            this.file.path,
            primary,
            state as Record<string, unknown>,
        );

        // Keep the bridge's replay cache current — see the twin in `view.ts`.
        this.bridge?.updateReaderOpts(
            primary
                ? { primaryViewState: state as Record<string, unknown> }
                : { secondaryViewState: state as Record<string, unknown> },
        );
    }

    /**
     * Persist a theme choice to the view state.
     */
    private handleSetTheme(kind: "light" | "dark", theme: unknown) {
        if (!this.file) return;
        services.viewStateService.saveTheme(this.file.path, kind, theme);
    }

    /**
     * Handle saved/updated annotations
     */
    private async handleAnnotationsSaved(annotations: AnnotationJSON[]) {
        if (this.dataManager) {
            for (const annotation of annotations) {
                const isVisual =
                    annotation.type === "image" || annotation.type === "ink";
                if (isVisual && annotation.image) {
                    workerBridge.localNote
                        .saveBase64Image(annotation.image, annotation.id)
                        .catch((e) =>
                            services.logService.error(
                                "Failed to save annotation image",
                                "LocalReaderView",
                                e,
                            ),
                        );
                }
                await this.dataManager.saveAnnotation(annotation);
            }
        }

        // Auto-copy newly created annotations (creation only — skips edits).
        if (this.file) {
            const sourceNotePath = getLinkedLocalSourceNote(
                services.app,
                this.file,
            )?.path;
            for (const annotation of annotations) {
                const id = annotation.id;
                if (this.knownAnnotationIds.has(id)) continue;
                this.knownAnnotationIds.add(id);
                await copyAnnotationOnCreate(annotation, {
                    sourceNotePath,
                });
            }
        }
    }

    /**
     * Handle deleted annotations
     * Optimization: Batch processing
     */
    private async handleAnnotationsDeleted(ids: string[]) {
        if (this.dataManager) {
            for (const id of ids) {
                const annotation = this.dataManager.getAnnotation(id);
                const maybeVisual =
                    !annotation ||
                    annotation.type === "image" ||
                    annotation.type === "ink";
                if (maybeVisual) {
                    workerBridge.localNote
                        .deleteAnnotationImage(id)
                        .catch((e) =>
                            services.logService.error(
                                "Failed to delete annotation image",
                                "LocalReaderView",
                                e,
                            ),
                        );
                }
                await this.dataManager.deleteAnnotation(id);
            }
        }
    }

    /**
     * Open the tag editor for a single local annotation when the reader
     * requests it. Tags are persisted into the `.zf.json` sidecar (via
     * `LocalDataManager`), then pushed back to the reader iframe.
     */
    private async handleOpenTagsPopup(annotationID: unknown) {
        if (!this.dataManager) return;

        const id = String(annotationID);
        const annotation = this.dataManager.getAnnotation(id);
        if (!annotation) {
            services.notificationService.notify(
                "warning",
                "Annotation not found.",
            );
            return;
        }

        const initialTags: TagInput[] = (annotation.tags ?? []).map((t) => ({
            tag: t.name,
        }));
        const suggestions = this.dataManager.getAllTagNames();

        new TagEditModal(this.app, {
            itemTitle: this.describeAnnotation(annotation),
            initialTags,
            suggestions,
            onSave: async (tags) => {
                annotation.tags = tags.map((t) => ({ name: t.tag }));
                try {
                    // Persist to the sidecar (also triggers a note re-render).
                    await this.dataManager!.saveAnnotation(annotation);

                    // Push updated tags back into the reader iframe.
                    await this.bridge?.refreshAnnotations(
                        this.dataManager!.getAllAnnotations(),
                    );
                } catch (e) {
                    services.logService.error(
                        "Failed to save annotation tags",
                        "LocalReaderView",
                        e,
                    );
                    services.notificationService.notify(
                        "error",
                        "Failed to save tags.",
                    );
                }
            },
        }).open();
    }

    /**
     * Build a short, human-readable label for an annotation to show as the
     * tag-editor subtitle (e.g. `Highlight: "some text"`).
     */
    private describeAnnotation(anno: AnnotationJSON): string {
        const label = anno.type.charAt(0).toUpperCase() + anno.type.slice(1);
        const text = (anno.text || anno.comment || "").trim();
        if (!text) return label;
        const truncated = text.length > 80 ? text.slice(0, 80) + "…" : text;
        return `${label}: ${truncated}`;
    }
}
