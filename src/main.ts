import {
    addIcon,
    Component,
    MarkdownRenderer,
    MarkdownView,
    Menu,
    Plugin,
    TFile,
    TAbstractFile,
    WorkspaceLeaf,
    type ObsidianProtocolData,
} from "obsidian";

import { ZotFlowSettingTab } from "./settings/settings";
import { DEFAULT_SETTINGS } from "./settings/types";
import { workerBridge } from "./bridge";
import { revokeBlobUrls } from "bundle-assets/inline-assets";
import {
    saveCredentials,
    loadCredentials,
    stripCredentials,
} from "utils/credentials";
import { ZOTERO_READER_VIEW_TYPE, ZoteroReaderView } from "./ui/reader/view";
import { TREE_VIEW_TYPE, ZotFlowTreeView } from "./ui/tree-view/view";
import { services } from "./services/services";
import { errorMessage as describeError } from "utils/error";
import { ZotFlowLockExtension } from "ui/editor/zotflow-lock-extension";
import { ZotFlowEditableRegionExtension } from "ui/editor/zotflow-editable-region-extension";
import { handleEditorDrop } from "ui/editor/citation-helper";

import { openAttachment, openItemNote } from "utils/viewer";
import { getLocalSidecarPath } from "utils/utils";
import { checkFile, readTextFile, renameFile, deleteFile } from "utils/file";
import { ActivityCenterModal } from "ui/activity-center/modal";
import { ZoteroSearchModal } from "ui/modals/suggest";
import { AttachmentSelectModal } from "ui/modals/attachment-suggest";
import { CslFolderService } from "services/csl-folder-service";

import type {
    ZotFlowSettings,
    ZotFlowPluginData,
    ViewStateEntry,
} from "./settings/types";
import type { CustomReaderTheme } from "types/zotero-reader";
import type { AnnotationJSON } from "types/zotero-reader";
import type { AttachmentData } from "types/zotero-item";
import type { IDBZoteroItem } from "types/db-schema";

import {
    LOCAL_ZOTERO_READER_VIEW_TYPE,
    LocalReaderView,
} from "ui/reader/local-view";
import { NOTE_EDITOR_VIEW_TYPE, NoteEditorView } from "ui/note-editor/view";
import { ZotFlowRegionDecorationExtension } from "ui/editor/zotflow-region-decoration-extension";
import { CitationSuggest } from "ui/editor/citation-suggest";
import { fireAndForgetIn } from "utils/fire-and-forget";
import { focusReaderLeaf } from "utils/reader-leaf-navigation";

const SUPPORTED_EXTENSIONS = ["pdf", "epub", "html"];

/** Plugin entry point managing lifecycle, commands, views, settings, and protocol handlers. */
const ff = fireAndForgetIn("ZotFlow");

export default class ZotFlow extends Plugin {
    settings: ZotFlowSettings;
    viewStates: Record<string, ViewStateEntry>;
    customThemes: CustomReaderTheme[] = [];
    cslFolder: CslFolderService;
    private zotFlowSettingTab: ZotFlowSettingTab | undefined;
    private citationSuggest: CitationSuggest;
    private sourceNoteActionElements = new WeakMap<MarkdownView, HTMLElement>();

    async onload() {
        // Load settings
        await this.loadSettings();
        this.applyEditableRegionMarkerVisibility();

        // Initialize local services
        services.initialize(this, this.settings);
        services.viewStateService.setViewStates(this.viewStates);
        services.viewStateService.setCustomThemes(this.customThemes);

        // Initialize worker bridge
        try {
            await workerBridge.initialize(this.settings, this.app);
            // Now that the worker is ready, populate per-library capabilities
            // (notes/write access). Used by UI gates and the lock extension.
            await services.libraryCache.refresh();
        } catch (e) {
            services.logService.error(
                "Failed to initialize worker bridge",
                "Main",
                e,
            );
            services.notificationService.notify(
                "error",
                "Failed to start background service.",
            );
        }

        // Add Icons
        this.addIcons();

        // Register views
        this.registerView(
            ZOTERO_READER_VIEW_TYPE,
            (leaf) => new ZoteroReaderView(leaf),
        );
        this.registerView(TREE_VIEW_TYPE, (leaf) => new ZotFlowTreeView(leaf));
        this.registerView(
            LOCAL_ZOTERO_READER_VIEW_TYPE,
            (leaf) => new LocalReaderView(leaf),
        );
        this.registerView(
            NOTE_EDITOR_VIEW_TYPE,
            (leaf) => new NoteEditorView(leaf),
        );

        // Add tree view to left
        this.app.workspace.onLayoutReady(() => {
            ff(this.registerTreeView(), "Failed to register the tree view");
        });

        // this.registerEvent(
        //     this.app.workspace.on("file-open", this.handleFileOpen.bind(this)),
        // );

        // Add "Open attachment" toggle action on source-note markdown views.
        this.registerEvent(
            this.app.workspace.on(
                "file-open",
                this.handleSourceNoteFileOpen.bind(this),
            ),
        );

        // Register editor extensions
        const isDefaultLocked = () => this.settings.defaultEditableRegionLocked;
        this.registerEditorExtension([ZotFlowEditableRegionExtension()]);
        this.registerEditorExtension([ZotFlowLockExtension(isDefaultLocked)]);
        // this.registerEditorExtension([ZotFlowCommentExtension()]);
        this.registerEditorExtension([
            ZotFlowRegionDecorationExtension(isDefaultLocked),
        ]);

        // Register drop-to-cite handler
        this.registerEvent(
            this.app.workspace.on("editor-drop", handleEditorDrop),
        );

        // Register citation suggest
        this.citationSuggest = new CitationSuggest();
        this.registerEditorSuggest(this.citationSuggest);

        // Register protocol handler for zotflow URIs
        // Usage: obsidian://zotflow?filePath=path/to/file.md
        this.registerObsidianProtocolHandler(
            "zotflow",
            this.handleProtocolCall.bind(this),
        );

        if (this.settings.overwriteViewer) {
            try {
                this.app.viewRegistry.unregisterExtensions(
                    SUPPORTED_EXTENSIONS,
                );
                this.registerExtensions(
                    SUPPORTED_EXTENSIONS,
                    LOCAL_ZOTERO_READER_VIEW_TYPE,
                );
            } catch {
                const message = `Could not unregister extension: '${SUPPORTED_EXTENSIONS.join(", ")}'`;
                services.logService.error(message, "Main");
                // services.notificationService.notify("error", message);
            }
        } else {
            for (const extension of SUPPORTED_EXTENSIONS) {
                try {
                    this.registerExtensions(
                        [extension],
                        LOCAL_ZOTERO_READER_VIEW_TYPE,
                    );
                } catch {
                    const message = `Could not register extension: '${extension}'`;
                    services.logService.error(message, "Main");
                    // services.notificationService.notify("error", message);
                }
            }
        }

        // Ensure MathJax is loaded. The output is thrown away — this only
        // exists to make Obsidian load the library — so a failure means the
        // warm-up did not happen and nothing more.
        const tempComponent = new Component();
        void MarkdownRenderer.render(
            this.app,
            "$\\int$",
            createDiv(),
            "",
            tempComponent,
        );
        tempComponent.unload();

        this.addRibbonIcon(
            "zotero-icon",
            "ZotFlow: Activity Center",
            async (evt: MouseEvent) => {
                new ActivityCenterModal(this.app).open();
            },
        );

        this.addCommand({
            id: "open-tree-view",
            name: "Open Zotero Tree View",
            callback: () => {
                ff(
                    this.registerTreeView(true),
                    "Failed to register the tree view",
                );
            },
        });

        this.addCommand({
            id: "open-activity-center",
            name: "Open Activity Center",
            callback: () => {
                new ActivityCenterModal(this.app).open();
            },
        });

        this.addCommand({
            id: "sync-all-libraries",
            name: "Sync all libraries",
            callback: async () => {
                await this.runTaskCommand(
                    () => workerBridge.createSyncTask(),
                    "Sync started",
                    "Failed to start sync",
                );
            },
        });

        this.addCommand({
            id: "update-all-library-source-notes",
            name: "Update all library source notes (skip up-to-date)",
            callback: async () => {
                await this.runTaskCommand(
                    async () => {
                        const items =
                            await workerBridge.dbHelper.getAllTopLevelItemIdentifiers();
                        return workerBridge.createBatchNoteTask(
                            { items },
                            {},
                            true,
                        );
                    },
                    "Library source note update started",
                    "Failed to start library source note update",
                );
            },
        });

        this.addCommand({
            id: "force-update-all-library-source-notes",
            name: "Force update all library source notes",
            callback: async () => {
                await this.runTaskCommand(
                    async () => {
                        const items =
                            await workerBridge.dbHelper.getAllTopLevelItemIdentifiers();
                        return workerBridge.createBatchNoteTask(
                            { items },
                            {
                                forceUpdateContent: true,
                                forceUpdateImages: true,
                            },
                            true,
                        );
                    },
                    "Library source note force-update started",
                    "Failed to start library source note force-update",
                );
            },
        });

        this.addCommand({
            id: "update-all-csl-data",
            name: "Update CSL citation data for all items",
            callback: async () => {
                await this.runTaskCommand(
                    () => workerBridge.createBackfillCslJsonTask(),
                    "CSL citation data update started",
                    "Failed to start CSL citation data update",
                );
            },
        });

        this.addCommand({
            id: "extract-all-annotation-images",
            name: "Extract all annotation images from attachments",
            callback: async () => {
                await this.runTaskCommand(
                    () =>
                        workerBridge.createBatchExtractImagesTask({
                            forceUpdate: false,
                        }),
                    "Annotation image extraction started",
                    "Failed to start annotation image extraction",
                );
            },
        });

        this.addCommand({
            id: "search-zotero",
            name: "Search Zotero Library",
            callback: () => {
                new ZoteroSearchModal(this.app, this.settings).open();
            },
        });

        this.addRibbonIcon("zotero-search", "ZotFlow: Search Zotero", () => {
            new ZoteroSearchModal(this.app, this.settings).open();
        });

        this.addCommand({
            id: "insert-citation",
            name: "Insert Citation",
            editorCallback: () => {
                this.citationSuggest.triggerManually();
            },
            // hotkeys: [{ modifiers: ["Alt"], key: "c" }],
        });

        this.addCommand({
            id: "create-child-note",
            name: "Create child note for current source note",
            callback: async () => {
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) {
                    services.notificationService.notify(
                        "warning",
                        "No note is currently open.",
                    );
                    return;
                }

                const cache = this.app.metadataCache.getFileCache(view.file);
                const fm = cache?.frontmatter;
                const zoteroKey: unknown = fm?.["zotero-key"];
                const libraryID: unknown = fm?.["library-id"];

                if (
                    typeof zoteroKey !== "string" ||
                    typeof libraryID !== "number"
                ) {
                    services.notificationService.notify(
                        "warning",
                        "This is not a valid ZotFlow source note.",
                    );
                    return;
                }

                if (!services.libraryCache.canEditNotes(libraryID)) {
                    services.notificationService.notify(
                        "warning",
                        "You do not have permission to create notes in this library.",
                    );
                    return;
                }

                try {
                    const noteKey = await workerBridge.itemNote.createChildNote(
                        libraryID,
                        zoteroKey,
                    );
                    await workerBridge.libraryNote.triggerUpdate(
                        libraryID,
                        zoteroKey,
                        { forceUpdateContent: true },
                    );
                    await openItemNote(libraryID, noteKey, this.app);
                } catch (err) {
                    services.logService.error(
                        "Failed to create child note",
                        "Main",
                        err,
                    );
                    services.notificationService.notify(
                        "error",
                        "Failed to create child note.",
                    );
                }
            },
        });

        this.addCommand({
            id: "trigger-test-task",
            name: "Trigger Test Task",
            callback: async () => {
                try {
                    const taskId =
                        await workerBridge.tasks.createTestTask(50000);
                    services.notificationService.notify(
                        "info",
                        `Test Task Started: ${taskId}`,
                    );
                } catch (e) {
                    services.notificationService.notify(
                        "error",
                        `Failed to start task: ${String(e)}`,
                    );
                    services.logService.error(
                        "Failed to start test task",
                        "Main",
                        e,
                    );
                }
            },
        });

        this.zotFlowSettingTab = new ZotFlowSettingTab(this.app, this);
        this.addSettingTab(this.zotFlowSettingTab);

        // Track file renames to keep viewStates and .zf.json sidecar in sync
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                services.viewStateService.renameViewState(oldPath, file.path);
                this.handleSidecarRename(file, oldPath);
                void this.cslFolder.onRename(file, oldPath);
            }),
        );

        // Clean up view state and .zf.json sidecar when an attachment is deleted
        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                services.viewStateService.deleteViewState(file.path);
                this.handleSidecarDelete(file);
                void this.cslFolder.onDelete(file);
            }),
        );

        // Hot-load custom CSL styles/locales from the configured vault folder.
        // create/modify are registered after layout-ready: "create" fires for
        // every existing file during startup indexing otherwise.
        this.cslFolder = new CslFolderService(this.app.vault);
        this.cslFolder.setFolder(this.settings.cslStylesFolder);
        this.app.workspace.onLayoutReady(() => {
            void this.cslFolder.rescan();
            this.registerEvent(
                this.app.vault.on("create", (file) => {
                    void this.cslFolder.onCreateOrModify(file);
                }),
            );
            this.registerEvent(
                this.app.vault.on("modify", (file) => {
                    void this.cslFolder.onCreateOrModify(file);
                }),
            );
        });

        // Add right-click "Update source note" entries for source notes
        this.registerEvent(
            this.app.workspace.on("file-menu", this.handleFileMenu.bind(this)),
        );
    }

    onunload() {
        services.viewStateService.flushViewStateSave();
        services.readerDocumentCache.dispose();
        services.enhancementPack.dispose();
        workerBridge.terminate();
        revokeBlobUrls();
    }

    addIcons() {
        // Add Icons
        addIcon(
            "zotero-underline",
            `
            <path style="scale: 5;" fill-rule="evenodd" clip-rule="evenodd" d="M16 16L11 4H9L4 16H6.16667L7.41667 13H12.5833L13.8333 16H16ZM10 6.8L8.04167 11.5H11.9583L10 6.8ZM2 17H3H17H18V17.25V18V18.25H17H3H2V18V17.25V17Z" fill="currentColor"/>
            `,
        );

        addIcon(
            "zotero-highlight",
            `<path style="scale: 5;" fill-rule="evenodd" clip-rule="evenodd" d="M3 3H17V17H3V3ZM1.75 1.75H3H17H18.25V3V17V18.25H17H3H1.75V17V3V1.75ZM16 16L11 4H9L4 16H6.16667L7.41667 13H12.5833L13.8333 16H16ZM10 6.8L8.04167 11.5H11.9583L10 6.8Z" fill="currentColor"/>`,
        );

        addIcon(
            "zotero-note",
            `<path style="scale: 5;" d="M9.375 17.625H17.625V2.375H2.375V10.625M9.375 17.625L2.375 10.625M9.375 17.625V10.625H2.375" stroke="currentColor" stroke-width="1.25" fill="transparent"/>`,
        );
        addIcon(
            "zotero-text",
            `<path style="scale: 5;" fill-rule="evenodd" clip-rule="evenodd" d="M9 2H4V4H9V17H11V4H16V2H11H9Z" fill="currentColor"/>`,
        );
        addIcon(
            "zotero-image",
            `<path style="scale: 5;" d="M12 1.75H8V3H12V1.75Z" fill="currentColor"/><path style="scale: 5;" fill-rule="evenodd" clip-rule="evenodd" d="M4 4V16H16V4H4ZM14.75 5.25H5.25V14.75H14.75V5.25Z" fill="currentColor"/><path style="scale: 5;" d="M17 14H18.25V18.25H14V17H17V14Z" fill="currentColor"/><path style="scale: 5;" d="M18.25 8H17V12H18.25V8Z" fill="currentColor"/><path style="scale: 5;" d="M1.75 8H3V12H1.75V8Z" fill="currentColor"/><path style="scale: 5;" d="M8 17H12V18.25H8V17Z" fill="currentColor"/><path style="scale: 5;" d="M14 3H17V6H18.25V1.75H14V3Z" fill="currentColor"/><path style="scale: 5;" d="M3 3V6H1.75L1.75 1.75H6V3H3Z" fill="currentColor"/><path style="scale: 5;" d="M6 17H3L3 14L1.75 14V18.25H6V17Z" fill="currentColor"/>`,
        );
        addIcon(
            "zotero-ink",
            `<g clip-path="url(#clip0_1132_37397)"><path style="scale: 5;" fill-rule="evenodd" clip-rule="evenodd" d="M15.2993 3.45132C9.70796 0.401476 5.6195 0.767603 3.51167 2.73007C2.06694 4.07517 1.70037 6.04539 2.40922 7.78528C1.9673 8.3293 1.6187 8.97119 1.40141 9.69542C0.6682 12.1393 1.45832 15.336 4.7659 18.773L5.21574 17.4235C2.50064 14.3978 2.0703 11.8158 2.59868 10.0546C2.71734 9.65915 2.88566 9.29662 3.09316 8.97053C3.37618 9.33844 3.71725 9.68296 4.11634 9.99337C6.54681 11.8837 8.86308 11.4966 9.88566 10.048C10.3762 9.35303 10.5148 8.44381 10.1287 7.61814C9.74229 6.79153 8.88965 6.16857 7.63567 5.8899C6.16757 5.56366 4.62141 5.93344 3.40711 6.83169C3.12285 5.67493 3.46864 4.47804 4.36344 3.64494C5.88061 2.2324 9.29215 1.59853 14.7008 4.54869L15.2993 3.45132ZM7.02724 19.9673L6.28793 20.2138C6.38929 20.3018 6.49234 20.3899 6.59709 20.4781L7.02724 19.9673ZM4.88377 9.00668C4.49328 8.70297 4.17813 8.36467 3.93536 8.00651C4.89976 7.1921 6.18125 6.84719 7.36451 7.11014C8.36051 7.33147 8.82035 7.77101 8.99638 8.14754C9.17285 8.52499 9.12392 8.95952 8.86445 9.3271C8.38703 10.0034 6.9533 10.6163 4.88377 9.00668ZM15.6162 6.50001C16.1043 6.01185 16.8958 6.01185 17.3839 6.50001L18.5 7.61612C18.9882 8.10428 18.9882 8.89574 18.5 9.38389L10.5463 17.3376C10.4091 17.4748 10.2418 17.5782 10.0577 17.6396L7.19768 18.5929L6.01183 18.9882L6.40711 17.8024L7.36046 14.9423C7.42182 14.7582 7.52521 14.591 7.66243 14.4537L15.6162 6.50001ZM14.5 9.38389L8.54631 15.3376L7.98825 17.0118L9.66243 16.4537L15.6162 10.5L14.5 9.38389ZM15.3839 8.50001L16.5 9.61612L17.6162 8.50001L16.5 7.38389L15.3839 8.50001Z" fill="currentColor"/></g><defs><clipPath id="clip0_1132_37397"><rect width="20" height="20" fill="white" style="scale: 5;"/></clipPath></defs>`,
        );
        addIcon(
            "zotero-icon",
            `
            <path
            style="fill:none;fill-opacity:1;stroke:currentColor;stroke-width:8.33331;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:none;stroke-opacity:1"
            d="m 17.213858,8.3334232 h 65.067213 l 5.218851,9.8385298 -44.69689,56.088003 H 87.163227 V 91.666577 H 17.550592 L 12.500086,81.155337 56.607743,25.992326 H 17.045509 Z"/>
            `,
        );
        addIcon(
            "zotero-search",
            `
            <defs><mask maskUnits="userSpaceOnUse" id="a"><g style="display:inline"><path fill="#fff" d="M0 0h100v100H0z"/><circle cx="64.5" cy="68.25" r="28"/><path stroke="#000" stroke-width="26" stroke-linecap="round" style="stroke-width:40;stroke-dasharray:none" d="m70 70 30 30"/></g></mask></defs><path mask="url(#a)" style="fill:none;stroke:currentColor;stroke-width:8.33331;stroke-linecap:round;stroke-linejoin:round" d="M17.214 8.333H82.28l5.219 9.839L42.803 74.26h44.36v17.407H17.551L12.5 81.155l44.107-55.163H17.046Z"/><g transform="matrix(2.5 0 0 2.5 37 40.75)"><circle cx="11" cy="11" r="8" style="fill:none;stroke:currentColor;stroke-width:3.33;stroke-linecap:round;stroke-linejoin:round"/><path d="m21 21-4.34-4.34" style="fill:none;stroke:currentColor;stroke-width:3.33;stroke-linecap:round;stroke-linejoin:round"/></g>
            `,
        );
    }

    async registerTreeView(active = false) {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(TREE_VIEW_TYPE);

        if (leaves.length > 0) {
            const existingLeaf = leaves[0];
            if (existingLeaf) leaf = existingLeaf;
        } else {
            const leftLeaf = workspace.getLeftLeaf(false);
            if (leftLeaf) {
                leaf = leftLeaf;
                await leaf.setViewState({
                    type: TREE_VIEW_TYPE,
                    active,
                });
            }
        }

        if (leaf && active) void workspace.revealLeaf(leaf);
    }

    async loadSettings() {
        const raw = (await this.loadData()) as Record<string, unknown> | null;

        if (raw && "settings" in raw) {
            // New nested format: { settings, viewStates }
            const data = raw as Partial<ZotFlowPluginData>;
            this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
            this.viewStates = { ...(data.viewStates ?? {}) };
            this.customThemes = data.customThemes ?? [];
        } else {
            // Legacy flat format
            this.settings = { ...DEFAULT_SETTINGS, ...raw };
            this.viewStates = {};
            this.customThemes = [];
        }

        // Load sensitive credentials from SecretStorage (cross-platform safe)
        loadCredentials(this.settings, this.app.secretStorage);
    }

    async onExternalSettingsChange() {
        await this.loadSettings();
        workerBridge.updateSettings(this.settings);
        services.updateSettings(this.settings);
        services.viewStateService.setViewStates(this.viewStates);
        services.viewStateService.setCustomThemes(this.customThemes);
        if (this.cslFolder) {
            this.cslFolder.setFolder(this.settings.cslStylesFolder);
            await this.cslFolder.rescan();
        }
        this.applyEditableRegionMarkerVisibility();
        this.zotFlowSettingTab?.refreshFromSettings();
    }

    async saveSettings() {
        // Store sensitive credentials in SecretStorage (cross-platform safe)
        saveCredentials(this.settings, this.app.secretStorage);
        // Persist nested data.json (without sensitive fields)
        const data: ZotFlowPluginData = {
            settings: stripCredentials(this.settings),
            customThemes: services.viewStateService.getCustomThemes(),
            viewStates: services.viewStateService.getViewStatesMap(),
        };
        await this.saveData(data);
        workerBridge.updateSettings(this.settings);
        services.updateSettings(this.settings);

        this.applyEditableRegionMarkerVisibility();
    }

    /**
     * Toggle a body-level CSS class so styles.css can hide the BEG/END/META
     * marker tags inside CodeMirror without reconfiguring the editor extension.
     * The lock icon widget and the region border overlay remain visible.
     */
    private applyEditableRegionMarkerVisibility() {
        document.body.classList.toggle(
            "zotflow-hide-region-markers",
            this.settings.hideEditableRegionMarkers,
        );
    }

    /**
     * Handle protocol calls for zotflow
     */
    private async handleProtocolCall(
        params: ObsidianProtocolData,
    ): Promise<void> {
        try {
            const { type, libraryID, key, navigation } = params;

            if (!type || !libraryID || !key) {
                services.logService.log(
                    "warn",
                    "Missing parameters for protocol call",
                    "Main",
                );
                services.notificationService.notify(
                    "warning",
                    "Missing parameters for protocol call",
                );
                return;
            }

            const libID = parseInt(libraryID);
            if (isNaN(libID)) {
                services.logService.log("warn", "Invalid library ID", "Main");
                services.notificationService.notify(
                    "warning",
                    "Invalid library ID",
                );
                return;
            }

            if (type === "open-note") {
                await workerBridge.libraryNote.openNote(libID, key);
            } else if (type === "open-item-note") {
                // Child note links (e.g. converted Better Notes
                // zotero://note links) — openItemNote honors the
                // alwaysOpenChildNoteInEditor setting.
                await openItemNote(libID, key, this.app);
            } else if (type === "open-attachment") {
                await openAttachment(libID, key, this.app, navigation);
            } else if (type === "open-annotation") {
                // Locate the annotation by key, then open its parent attachment
                // navigated to the annotation. Only the annotation id is needed.
                const annotation = await workerBridge.dbHelper.getItem(
                    libID,
                    key,
                );
                if (!annotation || annotation.itemType !== "annotation") {
                    services.notificationService.notify(
                        "warning",
                        "Annotation not found.",
                    );
                    return;
                }
                const attachmentKey = annotation.parentItem;
                if (!attachmentKey) {
                    services.notificationService.notify(
                        "warning",
                        "Annotation has no parent attachment.",
                    );
                    return;
                }
                await openAttachment(
                    libID,
                    attachmentKey,
                    this.app,
                    JSON.stringify({ annotationID: key }),
                );
            } else {
                services.logService.log(
                    "warn",
                    `Unknown action type: ${type}`,
                    "Main",
                );
                services.notificationService.notify(
                    "warning",
                    `Unknown action type: ${type}`,
                );
            }
        } catch (error) {
            services.logService.log(
                "error",
                "Error handling zotflow protocol call",
                "Main",
                error,
            );

            // Handle typed errors from Worker
            services.notificationService.notify(
                "error",
                `Protocol Error: ${describeError(error) || "Unknown error"}`,
            );
        }
    }

    /**
     * When a supported attachment is renamed/moved, rename/move its
     * co-located `.zf.json` sidecar file to keep them in sync.
     */
    private handleSidecarRename(file: TAbstractFile, oldPath: string) {
        if (!(file instanceof TFile)) return;
        if (!SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase()))
            return;

        const oldJsonPath = this.getSidecarPath(oldPath);
        const newJsonPath = this.getSidecarPathFromFile(file);
        if (oldJsonPath === newJsonPath) return;

        // renameFile handles both Vault-tracked and hidden (.dot folder) paths.
        renameFile(this.app, oldJsonPath, newJsonPath).catch((err) => {
            services.logService.error(
                `Failed to rename sidecar ${oldJsonPath} → ${newJsonPath}`,
                "Main",
                err,
            );
        });
    }

    /**
     * When a supported attachment is deleted, delete its
     * co-located `.zf.json` sidecar file.
     */
    private handleSidecarDelete(file: TAbstractFile) {
        if (!(file instanceof TFile)) return;
        if (!SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase()))
            return;

        const jsonPath = this.getSidecarPathFromFile(file);
        // deleteFile handles both Vault-tracked and hidden (.dot folder) paths.
        deleteFile(this.app, jsonPath).catch((err) => {
            services.logService.error(
                `Failed to delete sidecar ${jsonPath}`,
                "Main",
                err,
            );
        });
    }

    /**
     * Derive sidecar `.zf.json` path from a raw file path string.
     */
    private getSidecarPath(filePath: string): string {
        return getLocalSidecarPath(filePath, this.settings.localSidecarFolder);
    }

    /**
     * Derive sidecar `.zf.json` path from a TFile.
     */
    private getSidecarPathFromFile(file: TFile): string {
        return getLocalSidecarPath(file.path, this.settings.localSidecarFolder);
    }

    /**
     * Run a worker task-creating callback and surface a success/error notice.
     * Used by command-palette commands that delegate to TaskManager.
     */
    private async runTaskCommand(
        createTask: () => Promise<string>,
        successMessage: string,
        errorMessage: string,
    ): Promise<void> {
        try {
            const taskId = await createTask();
            services.notificationService.notify(
                "info",
                `${successMessage} (task ${taskId.slice(0, 8)})`,
            );
        } catch (e) {
            services.notificationService.notify("error", errorMessage);
            services.logService.error(errorMessage, "Main", e);
        }
    }

    /**
     * Right-click "Update source note" entries.
     * - Library source note (zotero-key + library-id): incremental + force.
     * - Local source note (zotflow-local-attachment): single update entry
     *   (local notes are template-driven and always re-render fully).
     */
    private handleFileMenu(menu: Menu, file: TAbstractFile): void {
        if (!(file instanceof TFile) || file.extension !== "md") return;

        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm) return;

        const zoteroKey: unknown = fm["zotero-key"];
        const libraryID: unknown = fm["library-id"];
        const localAttachment: unknown = fm["zotflow-local-attachment"];

        const isLibrarySourceNote =
            typeof zoteroKey === "string" && typeof libraryID === "number";
        const isLocalSourceNote = typeof localAttachment === "string";

        if (!isLibrarySourceNote && !isLocalSourceNote) return;

        if (isLibrarySourceNote) {
            menu.addItem((item) => {
                item.setTitle("ZotFlow: Update source note")
                    .setIcon("refresh-cw")
                    .onClick(async () => {
                        try {
                            await workerBridge.libraryNote.triggerUpdate(
                                libraryID,
                                zoteroKey,
                                {},
                                false,
                            );
                            services.notificationService.notify(
                                "success",
                                "Source note updated.",
                            );
                        } catch (e) {
                            services.notificationService.notify(
                                "error",
                                "Failed to update source note.",
                            );
                            services.logService.error(
                                "Failed to update library source note",
                                "Main",
                                e,
                            );
                        }
                    });
            });

            menu.addItem((item) => {
                item.setTitle("ZotFlow: Force update source note")
                    .setIcon("refresh-ccw")
                    .onClick(async () => {
                        try {
                            await workerBridge.libraryNote.triggerUpdate(
                                libraryID,
                                zoteroKey,
                                {
                                    forceUpdateContent: true,
                                    forceUpdateImages: true,
                                },
                                false,
                            );
                            services.notificationService.notify(
                                "success",
                                "Source note force-updated.",
                            );
                        } catch (e) {
                            services.notificationService.notify(
                                "error",
                                "Failed to force-update source note.",
                            );
                            services.logService.error(
                                "Failed to force-update library source note",
                                "Main",
                                e,
                            );
                        }
                    });
            });

            if (services.libraryCache.canEditNotes(libraryID)) {
                menu.addItem((item) => {
                    item.setTitle("ZotFlow: Create child note")
                        .setIcon("sticky-note")
                        .onClick(async () => {
                            try {
                                const noteKey =
                                    await workerBridge.itemNote.createChildNote(
                                        libraryID,
                                        zoteroKey,
                                    );
                                await workerBridge.libraryNote.triggerUpdate(
                                    libraryID,
                                    zoteroKey,
                                    { forceUpdateContent: true },
                                );
                                await openItemNote(
                                    libraryID,
                                    noteKey,
                                    this.app,
                                );
                            } catch (err) {
                                services.logService.error(
                                    "Failed to create child note",
                                    "Main",
                                    err,
                                );
                                services.notificationService.notify(
                                    "error",
                                    "Failed to create child note.",
                                );
                            }
                        });
                });
            }
        } else if (isLocalSourceNote) {
            menu.addItem((item) => {
                item.setTitle("ZotFlow: Update source note")
                    .setIcon("refresh-cw")
                    .onClick(async () => {
                        await this.updateLocalSourceNoteFromMenu(
                            file,
                            localAttachment,
                        );
                    });
            });
        }
    }

    /**
     * Resolve a local source note's linked attachment + sidecar annotations
     * and trigger a worker-side note re-render.
     */
    private async updateLocalSourceNoteFromMenu(
        sourceNote: TFile,
        link: string,
    ): Promise<void> {
        try {
            const linkPath = link
                .replace(/\[\[|\]\]/g, "")
                .split("|")[0]!
                .trim();
            const dest = this.app.metadataCache.getFirstLinkpathDest(
                linkPath,
                sourceNote.path,
            );
            if (!dest) {
                services.notificationService.notify(
                    "warning",
                    "Linked attachment file not found.",
                );
                return;
            }

            const sidecarPath = getLocalSidecarPath(
                dest.path,
                this.settings.localSidecarFolder,
            );
            let annotations: AnnotationJSON[] = [];
            const sidecar = await checkFile(this.app, sidecarPath);
            if (sidecar.exists) {
                const content = await readTextFile(this.app, sidecarPath);
                if (content) {
                    try {
                        const parsed = JSON.parse(content) as {
                            annotations?: AnnotationJSON[];
                        };
                        annotations = parsed.annotations ?? [];
                    } catch (e) {
                        services.logService.warn(
                            `Failed to parse sidecar ${sidecarPath}`,
                            "Main",
                            e,
                        );
                    }
                }
            }

            await workerBridge.localNote.triggerUpdate(
                {
                    path: dest.path,
                    name: dest.name,
                    extension: dest.extension,
                    basename: dest.basename,
                },
                annotations,
                false,
            );
            services.notificationService.notify(
                "success",
                "Source note updated.",
            );
        } catch (e) {
            services.notificationService.notify(
                "error",
                "Failed to update source note.",
            );
            services.logService.error(
                "Failed to update local source note",
                "Main",
                e,
            );
        }
    }

    /**
     * On every file-open, decide whether the active markdown view is a ZotFlow
     * source note (library or local). If so, ensure an "Open attachment" action
     * button is present in its view header.
     */
    private handleSourceNoteFileOpen(file: TFile | null) {
        if (!file || file.extension !== "md") return;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== file.path) return;

        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;

        const zoteroKey: unknown = fm?.["zotero-key"];
        const libraryID: unknown = fm?.["library-id"];
        const localAttachment: unknown = fm?.["zotflow-local-attachment"];

        const isLibrarySourceNote =
            typeof zoteroKey === "string" && typeof libraryID === "number";
        const isLocalSourceNote = typeof localAttachment === "string";

        // Remove any prior action so a single view doesn't accumulate buttons
        // when its frontmatter changes.
        const prior = this.sourceNoteActionElements.get(view);
        if (prior) {
            prior.remove();
            this.sourceNoteActionElements.delete(view);
        }

        if (!isLibrarySourceNote && !isLocalSourceNote) return;

        const action = view.addAction(
            "paperclip",
            "Open attachment",
            async () => {
                if (isLibrarySourceNote) {
                    await this.openLibrarySourceNoteAttachment(
                        libraryID,
                        zoteroKey,
                    );
                } else {
                    await this.openLocalSourceNoteAttachment(
                        file,
                        localAttachment as string,
                    );
                }
            },
        );
        this.sourceNoteActionElements.set(view, action);
    }

    /**
     * Open the attachment associated with a library-backed source note.
     * - 0 attachments → warning notice
     * - 1 attachment  → open it directly
     * - >1 attachments → show the attachment picker modal
     */
    private async openLibrarySourceNoteAttachment(
        libraryID: number,
        zoteroKey: string,
    ): Promise<void> {
        const attachments = (await workerBridge.dbHelper.getAttachments(
            libraryID,
            zoteroKey,
        )) as IDBZoteroItem<AttachmentData>[];

        if (attachments.length === 0) {
            services.notificationService.notify(
                "warning",
                "No attachments found for this item.",
            );
            return;
        }

        if (attachments.length === 1) {
            await openAttachment(
                attachments[0]!.libraryID,
                attachments[0]!.key,
                this.app,
            );
            return;
        }

        const parentItem = await workerBridge.dbHelper.getItem(
            libraryID,
            zoteroKey,
        );
        if (!parentItem) {
            services.notificationService.notify(
                "warning",
                "Parent item not found in the local database.",
            );
            return;
        }
        new AttachmentSelectModal(this.app, parentItem, attachments).open();
    }

    /**
     * Open the local vault file referenced by a local source note's
     * `zotflow-local-attachment` frontmatter wikilink.
     */
    private async openLocalSourceNoteAttachment(
        sourceNote: TFile,
        link: string,
    ): Promise<void> {
        // Strip `[[ ... ]]` and any `|alias` suffix.
        const linkPath = link
            .replace(/\[\[|\]\]/g, "")
            .split("|")[0]!
            .trim();
        const dest = this.app.metadataCache.getFirstLinkpathDest(
            linkPath,
            sourceNote.path,
        );
        if (!dest) {
            services.notificationService.notify(
                "warning",
                "Linked attachment file not found in the vault.",
            );
            return;
        }

        // Reuse an existing local reader leaf already showing this file.
        const existing = this.app.workspace
            .getLeavesOfType(LOCAL_ZOTERO_READER_VIEW_TYPE)
            .find(
                (leaf) =>
                    (leaf.view as LocalReaderView).getState()?.file ===
                    dest.path,
        );
        if (existing) {
            await focusReaderLeaf(this.app.workspace, existing);
            return;
        }

        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(dest);
        await focusReaderLeaf(this.app.workspace, leaf);
    }

    async handleFileOpen(file: TFile | null) {
        if (!file || file.extension !== "md") return;

        const cache = this.app.metadataCache.getFileCache(file);

        if (
            cache?.frontmatter &&
            cache.frontmatter["zotflow-locked"] === true
        ) {
            const leaf = this.app.workspace.getLeaf(false);
            const view = leaf.view;

            if (view instanceof MarkdownView) {
                const state = leaf.getViewState();

                if (state.state && state.state.mode !== "preview") {
                    const newState = {
                        ...state,
                        state: {
                            ...state.state,
                            mode: "preview",
                            source: false,
                        },
                    };

                    window.setTimeout(() => {
                        if (leaf.view instanceof MarkdownView) {
                            ff(
                                leaf.setViewState(newState),
                                "Failed to restore the note view state",
                            );
                        }
                    }, 10);
                }
            }
        }
    }
}
