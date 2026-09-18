import { workerBridge } from "bridge";
import { services } from "services/services";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

/** Declarative attachment cache settings and runtime usage statistics. */
export class CacheSection {
    private totalSizeBytes: number | undefined;
    private updateUsage: (() => void) | undefined;
    private loadVersion = 0;

    constructor(
        private readonly plugin: ZotFlow,
        private readonly requestUpdate: () => void,
    ) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        const visible = () => this.plugin.settings.useCache;
        return [
            {
                type: "group",
                heading: "Attachment Cache",
                items: [
                    {
                        name: "Enable Caching",
                        desc: "Save attachments locally to improve speed and work offline.",
                        render: (setting) => {
                            setting.addToggle((toggle) =>
                                toggle
                                    .setValue(this.plugin.settings.useCache)
                                    .onChange(async (value) => {
                                        this.plugin.settings.useCache = value;
                                        await this.plugin.saveSettings();
                                        if (!value) this.reset();
                                        this.requestUpdate();
                                    }),
                            );
                        },
                    },
                    {
                        name: "Max Cache Limit (MB)",
                        desc: "Set to 0 for unlimited.",
                        visible,
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setValue(
                                    String(this.plugin.settings.maxCacheSizeMB),
                                ).onChange(async (value) => {
                                    if (!/^\d+$/.test(value)) {
                                        services.notificationService.notify(
                                            "warning",
                                            "Must be a non-negative whole number",
                                        );
                                        return;
                                    }
                                    this.plugin.settings.maxCacheSizeMB =
                                        Number.parseInt(value, 10);
                                    await this.plugin.saveSettings();
                                    this.updateUsage?.();
                                });
                            });
                        },
                    },
                    {
                        name: "Current Cache Usage",
                        desc: "Storage used by cached attachment files.",
                        visible,
                        render: (setting) => this.renderUsage(setting.infoEl),
                    },
                    {
                        name: "Purge Cache",
                        desc: "Remove all cached attachment files.",
                        visible,
                        render: (setting) => {
                            setting.addButton((button) =>
                                button
                                    .setButtonText("Purge Cache")
                                    .setDestructive()
                                    .onClick(async () => {
                                        try {
                                            await workerBridge.attachment.purgeCache();
                                            this.totalSizeBytes = 0;
                                            this.updateUsage?.();
                                            services.notificationService.notify(
                                                "success",
                                                "Cache purged successfully.",
                                            );
                                            services.logService.info(
                                                "Cache purged successfully.",
                                                "Settings",
                                            );
                                        } catch (error) {
                                            services.notificationService.notify(
                                                "error",
                                                "Failed to purge cache.",
                                            );
                                            services.logService.error(
                                                "Failed to purge cache",
                                                "Settings",
                                                error,
                                            );
                                        }
                                    }),
                            );
                        },
                    },
                ],
            },
        ];
    }

    reset(): void {
        this.totalSizeBytes = undefined;
        this.updateUsage = undefined;
        this.loadVersion += 1;
    }

    private renderUsage(containerEl: HTMLElement): () => void {
        containerEl
            .querySelectorAll(":scope > .zotflow-settings-cache-usage")
            .forEach((element) => element.remove());

        const usageContainer = containerEl.createDiv({
            cls: "zotflow-settings-cache-usage",
        });
        const infoDiv = usageContainer.createDiv({
            cls: "zotflow-settings-cache-info",
        });
        infoDiv.createSpan({ text: "Current Usage" });
        const usageTextEl = infoDiv.createSpan({ text: "Calculating..." });
        const progressBg = usageContainer.createDiv({
            cls: "zotflow-settings-cache-progress-bg",
        });
        const progressFillEl = progressBg.createDiv({
            cls: "zotflow-settings-cache-progress-fill",
        });

        const update = () => {
            if (this.totalSizeBytes === undefined) return;
            const totalSizeMB = (this.totalSizeBytes / (1024 * 1024)).toFixed(
                2,
            );
            const limitMB = this.plugin.settings.maxCacheSizeMB;
            const percent =
                limitMB > 0
                    ? (this.totalSizeBytes / (limitMB * 1024 * 1024)) * 100
                    : 0;
            usageTextEl.setText(
                `${totalSizeMB} MB / ${limitMB > 0 ? `${limitMB} MB` : "Unlimited"}`,
            );
            progressFillEl.style.width = `${Math.min(percent, 100)}%`;
            progressFillEl.style.backgroundColor =
                percent > 90
                    ? "var(--text-error)"
                    : "var(--interactive-accent)";
        };

        this.updateUsage = update;
        update();

        const loadVersion = ++this.loadVersion;
        void (async () => {
            try {
                const totalSizeBytes =
                    await workerBridge.attachment.getCacheTotalSizeBytes();
                if (loadVersion !== this.loadVersion) return;
                this.totalSizeBytes = totalSizeBytes;
                update();
            } catch (error) {
                if (loadVersion !== this.loadVersion) return;
                usageTextEl.setText("Unable to read cache usage");
                services.logService.warn(
                    "Failed to read cache usage",
                    "Settings",
                    error,
                );
            }
        })();

        return () => {
            if (this.updateUsage === update) this.updateUsage = undefined;
            if (loadVersion === this.loadVersion) this.loadVersion += 1;
            usageContainer.remove();
        };
    }
}
