import { AnnotationProfilesSection } from "settings/sections/annotation-profiles-section";
import { App, PluginSettingTab } from "obsidian";

import { CacheSection } from "settings/sections/cache-section";
import { CitationSection } from "settings/sections/citation-section";
import { CslSection } from "settings/sections/csl-section";
import { GeneralSection } from "settings/sections/general-section";
import { SyncSection } from "settings/sections/sync-section";
import { WebDavSection } from "settings/sections/webdav-section";
import { DEFAULT_SETTINGS } from "settings/types";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

/** Obsidian 1.13 declarative settings tab. */
export class ZotFlowSettingTab extends PluginSettingTab {
    plugin: ZotFlow;

    private readonly syncSection: SyncSection;
    private readonly webDavSection: WebDavSection;
    private readonly cacheSection: CacheSection;

    constructor(app: App, plugin: ZotFlow) {
        super(app, plugin);
        this.plugin = plugin;
        this.icon = "zotero-icon";

        const requestUpdate = () => this.update();
        this.syncSection = new SyncSection(plugin, requestUpdate);
        this.webDavSection = new WebDavSection(plugin, requestUpdate);
        this.cacheSection = new CacheSection(plugin, requestUpdate);
    }

    getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            { type: "page", name: "Annotation Profiles", items: new AnnotationProfilesSection(this.plugin, () => this.update()).getDefinitions() },
            {
                type: "page",
                name: "General",
                items: new GeneralSection(this.plugin).getDefinitions(),
            },
            {
                type: "page",
                name: "Sync",
                items: this.syncSection.getDefinitions(),
            },
            {
                type: "page",
                name: "WebDAV",
                items: this.webDavSection.getDefinitions(),
            },
            {
                type: "page",
                name: "Cache",
                items: this.cacheSection.getDefinitions(),
            },
            {
                type: "page",
                name: "Citation",
                items: new CitationSection(this.plugin).getDefinitions(),
            },
            {
                type: "page",
                name: "CSL Render",
                items: new CslSection(this.plugin).getDefinitions(),
            },
        ];
    }

    getControlValue(key: string): unknown {
        if (!this.isSettingKey(key)) return undefined;
        return this.plugin.settings[key];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        if (!this.isSettingKey(key)) {
            throw new Error(`Unknown ZotFlow setting: ${key}`);
        }

        Reflect.set(this.plugin.settings, key, value);
        await this.plugin.saveSettings();
    }

    refreshFromSettings(): void {
        this.syncSection.reset();
        this.webDavSection.reset();
        this.cacheSection.reset();
        this.update();
    }

    private isSettingKey(key: string): key is SettingKey {
        return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);
    }
}
