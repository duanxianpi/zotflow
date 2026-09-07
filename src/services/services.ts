import { EnhancementPackService } from "services/enhancement-pack-service";
import { workerBridge } from "bridge";
import { sdtCompatibility } from "enhancement-pack/compatibility";
import { IndexService } from "./index-service";
import { LogService } from "./log-service";
import { NotificationService } from "./notification-service";
import { ViewStateService } from "./view-state-service";
import { TaskMonitor } from "./task-monitor";
import { CitationService } from "./citation-service";
import { LibraryCache } from "./library-cache";
import { ReaderDocumentCache } from "./reader-document-cache";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { App } from "obsidian";
import type { ZotFlowSettings } from "settings/types";
import type ZotFlow from "main";

class ServiceLocator {
    private _app: App;
    private _plugin: ZotFlow;
    private _settings: ZotFlowSettings;
    private _initialized = false;

    private _indexService: IndexService;
    private _logService: LogService;
    private _notificationService: NotificationService;
    private _viewStateService: ViewStateService;
    private _taskMonitor: TaskMonitor;
    private _citationService: CitationService;
    private _libraryCache: LibraryCache;
    private _readerDocumentCache: ReaderDocumentCache;
    private _enhancementPack: EnhancementPackService;

    initialize(plugin: ZotFlow, settings: ZotFlowSettings) {
        this._plugin = plugin;
        this._app = plugin.app;
        this._settings = settings;

        this._logService = new LogService();
        this._notificationService = new NotificationService();
        this._viewStateService = new ViewStateService(
            this._plugin,
            this._logService,
            () => this._settings,
        );
        this._indexService = new IndexService(this._app, this._logService);
        this._indexService.load();

        this._taskMonitor = new TaskMonitor(this._app);
        this._citationService = new CitationService();
        this._libraryCache = new LibraryCache(
            () => this._settings,
            this._logService,
        );
        this._readerDocumentCache = new ReaderDocumentCache();
        this._enhancementPack = new EnhancementPackService(
            this._app.vault.adapter,
            this._app.vault.configDir,
            sdtCompatibility,
            () => workerBridge.enhancementResources,
            (error) =>
                this._logService.error(
                    "Resource snapshot cleanup failed",
                    "EnhancementPackService",
                    error,
                ),
        );

        this._initialized = true;
        this._logService.info("Services initialized.", "LocalServiceLocator");
    }

    private assertInitialized(): void {
        if (!this._initialized) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "LocalServiceLocator",
                "ServiceLocator not initialized. Call initialize() first.",
            );
        }
    }

    updateSettings(newSettings: ZotFlowSettings) {
        this.assertInitialized();
        this._settings = newSettings;
        // Library capabilities depend on the active API key + cached key info,
        // both of which can change after a settings save. Refresh in background.
        void this._libraryCache.refresh();
    }

    saveSettings() {
        this.assertInitialized();
        return this._plugin.saveSettings();
    }

    get plugin() {
        this.assertInitialized();
        return this._plugin;
    }

    get app() {
        this.assertInitialized();
        return this._app;
    }

    get settings() {
        this.assertInitialized();
        return this._settings;
    }

    get indexService() {
        this.assertInitialized();
        return this._indexService;
    }

    get logService() {
        this.assertInitialized();
        return this._logService;
    }

    get notificationService() {
        this.assertInitialized();
        return this._notificationService;
    }

    get viewStateService() {
        this.assertInitialized();
        return this._viewStateService;
    }

    get taskMonitor() {
        this.assertInitialized();
        return this._taskMonitor;
    }

    get citationService() {
        this.assertInitialized();
        return this._citationService;
    }

    get libraryCache() {
        this.assertInitialized();
        return this._libraryCache;
    }

    get enhancementPack() {
        this.assertInitialized();
        return this._enhancementPack;
    }

    get readerDocumentCache() {
        this.assertInitialized();
        return this._readerDocumentCache;
    }
}

/** Singleton `ServiceLocator` instance providing access to all main-thread services. */
export const services = new ServiceLocator();
