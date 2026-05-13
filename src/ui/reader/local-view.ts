import { FileView, WorkspaceLeaf, TFile, ItemView } from "obsidian";
import { workerBridge } from "bridge";
import { IframeReaderBridge } from "./bridge";
import { LocalDataManager } from "./local-data-manager";
import { copyAnnotationOnCreate, isNewlyCreated } from "./auto-copy";
import { getLinkedLocalSourceNote } from "utils/file";

import type {
    CreateReaderOptions,
    ColorScheme,
    AnnotationJSON,
    CustomReaderTheme,
} from "types/zotero-reader";
import { services } from "services/services";

/** View type identifier for the local vault file reader view. */
export const LOCAL_ZOTERO_READER_VIEW_TYPE = "zotflow-local-zotero-reader-view";

/** Obsidian `ItemView` that embeds the Zotero reader iframe for local PDF/EPUB/HTML vault files. */
export class LocalReaderView extends ItemView {
    private file: TFile | null = null;
    private bridge?: IframeReaderBridge;
    private colorScheme: ColorScheme = "light"; // Default to light
    private readerOptions: Partial<CreateReaderOptions> = {};
    private dataManager?: LocalDataManager;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
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

    async onOpen() {}

    async setState(state: any, result: any) {
        if (state.file) {
            const file = services.app.vault.getAbstractFileByPath(state.file);
            if (file instanceof TFile) {
                this.file = file;
                this.containerEl
                    .getElementsByClassName("view-header-title")[0]
                    ?.setText(this.file.name);

                this.loadDocument(this.file);
            }
        }
        super.setState(state, result);
    }

    getState(): any {
        return {
            file: this.file?.path,
        };
    }

    private async loadDocument(file: TFile) {
        const container = this.contentEl;
        container.empty();

        const loadingEl = container.createDiv({ cls: "zotflow-loading" });
        loadingEl.setText(`Loading ${file.name}...`);

        try {
            this.renderReader(file);
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
            // Create bridge once
            if (!this.bridge) {
                // Initialize data manager
                this.dataManager = new LocalDataManager(file);
                this.bridge = new IframeReaderBridge(
                    container,
                    true,
                    undefined,
                    file,
                    this.dataManager,
                );

                // Register event listeners
                this.bridge.onEventType("error", (evt) => {
                    console.error(`${evt.code}: ${evt.message}`);
                });

                this.bridge.onEventType("sidebarToggled", (evt) => {
                    console.log("Sidebar toggled:", evt.open);
                });

                this.bridge.onEventType("sidebarWidthChanged", (evt) => {
                    console.log("Sidebar width changed:", evt.width);
                });

                this.bridge.onEventType("openLink", (evt) => {
                    console.log("Opening link:", evt.url);
                });

                this.bridge.onEventType("annotationsSaved", async (evt) => {
                    await this.handleAnnotationsSaved(evt.annotations);
                });

                this.bridge.onEventType("annotationsDeleted", async (evt) => {
                    await this.handleAnnotationsDeleted(evt.ids);
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
                                this.bridge!.setColorScheme(newColorScheme);
                                this.colorScheme = newColorScheme;
                            }
                        }
                    }),
                );
            }

            // Connect Bridge & Get File concurrently
            const [_, buffer, loadedAnnotations] = await Promise.all([
                this.bridge.connect(),
                this.app.vault.readBinary(file),
                (async () => {
                    return await this.dataManager?.loadAnnotations();
                })(),
            ]);

            // Initialize Reader if ready
            if (this.bridge.state === "bridge-ready") {
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
                    darkTheme: viewState?.darkTheme ?? themeDefaults.darkTheme,
                };

                const opts: Partial<CreateReaderOptions> = {
                    ...this.readerOptions,
                    annotations: loadedAnnotations,
                    colorScheme: this.colorScheme,
                    primaryViewState: viewState?.primaryViewState,
                    customThemes: services.viewStateService.getCustomThemes(),
                    ...themeOverrides,
                };

                const type = this.getReaderType(file.extension);

                // Initialize Reader Logic
                this.bridge.initReader({
                    data: {
                        buf: new Uint8Array(buffer),
                        url: null,
                    },
                    type: type as any,
                    authorName: "",
                    ...opts,
                });
            }
        } catch (e: any) {
            console.error("Error loading Zotero Reader view:", e);
            container.empty();
            const errorMessage = container.createDiv({
                cls: "error-message",
            });
            errorMessage
                .createEl("div")
                .setText("Failed to load Zotero Reader");
            errorMessage.createEl("div").setText("Error details: " + e.message);
        }
    }

    private getReaderType(extension: string) {
        switch (extension.toLowerCase()) {
            case "pdf":
                return "pdf";
            case "epub":
                return "epub";
            case "html":
                return "snapshot";
            default:
                return "pdf";
        }
    }
    // Handle navigation info
    setEphemeralState(state: any): void {
        if (state && state.subpath) {
            const subpath = state.subpath;
            const navigationInfo = this.parseNavigationInfo(subpath);

            if (navigationInfo) {
                this.readerNavigate(navigationInfo);
            }
        }

        super.setEphemeralState(state);
    }

    // Parse navigation info
    parseNavigationInfo(subpath: string): any {
        //Regex to match annotation=url_encoded_string
        const match = subpath.match(/annotation=([^&]+)/);
        if (match && match[1]) {
            return JSON.parse(decodeURIComponent(match[1]));
        }
        return null;
    }

    readerNavigate(navigationInfo: any) {
        if (!this.bridge) return;
        this.bridge.navigate(navigationInfo);
    }

    async onClose() {
        if (this.bridge) {
            await this.bridge.dispose();
        }

        // Flush view state on close to ensure latest state is saved
        services.viewStateService.flushViewStateSave();
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
    private async handleAnnotationsSaved(annotations: any[]) {
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
                if (!isNewlyCreated(annotation as AnnotationJSON)) continue;
                await copyAnnotationOnCreate(annotation as AnnotationJSON, {
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
                if (annotation) {
                    const isVisual =
                        annotation.type === "image" ||
                        annotation.type === "ink";
                    if (isVisual) {
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
                }
                await this.dataManager.deleteAnnotation(id);
            }
        }
    }
}
