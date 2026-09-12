import { ButtonComponent, setIcon } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import { errorMessage as describeError } from "utils/error";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { LibrarySyncMode, SettingKey } from "settings/types";
import type { IDBZoteroKey } from "types/db-schema";
import type { LibraryRow } from "worker/services/key";

const MODE_LABELS: Record<LibrarySyncMode, string> = {
    bidirectional: "Bidirectional",
    readonly: "Read-Only",
    ignored: "Ignored",
};

/** Declarative synchronization settings and asynchronously populated libraries. */
export class SyncSection {
    private keyInfo: IDBZoteroKey | undefined;
    private keyInfoLoaded = false;
    private keyLoadPromise: Promise<void> | undefined;
    private keyLoadVersion = 0;
    private apiKeyDraft: string | undefined;

    constructor(
        private readonly plugin: ZotFlow,
        private readonly requestUpdate: () => void,
    ) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "group",
                heading: "Synchronization",
                items: [
                    {
                        name: "API Key",
                        desc: this.createApiDescription(),
                        render: (setting) => {
                            this.ensureKeyInfoLoaded();
                            const loading = !this.keyInfoLoaded;
                            setting.addText((text) => {
                                text.setPlaceholder("Enter API Key")
                                    .setValue(
                                        this.apiKeyDraft ??
                                            this.plugin.settings.zoteroapikey,
                                    )
                                    .setDisabled(loading || !!this.keyInfo)
                                    .onChange((value) => {
                                        this.apiKeyDraft = value.trim();
                                    });
                                text.inputEl.type = this.keyInfo
                                    ? "password"
                                    : "text";
                                text.inputEl.size = 30;
                            });

                            setting.addButton((button) => {
                                button
                                    .setButtonText(
                                        loading
                                            ? "Checking..."
                                            : this.keyInfo
                                              ? "Verified"
                                              : "Verify Key",
                                    )
                                    .setCta()
                                    .setDisabled(loading || !!this.keyInfo)
                                    .onClick(() =>
                                        this.handleVerifyOrRefresh(
                                            button,
                                            "verify",
                                        ),
                                    );
                                button.buttonEl.setCssStyles({
                                    width: "100px",
                                });
                            });

                            setting.addExtraButton((button) => {
                                button
                                    .setIcon("trash")
                                    .setTooltip("Disconnect & Clear Key")
                                    .setDisabled(loading)
                                    .onClick(async () => {
                                        const oldKey =
                                            this.plugin.settings.zoteroapikey;
                                        this.apiKeyDraft = undefined;
                                        this.plugin.settings.zoteroapikey = "";
                                        this.plugin.settings.librariesConfig =
                                            {};
                                        if (oldKey) {
                                            await workerBridge.key.deleteKey(
                                                oldKey,
                                            );
                                        }
                                        await this.plugin.saveSettings();
                                        this.setKeyInfo(undefined);
                                        services.notificationService.notify(
                                            "info",
                                            "Disconnected.",
                                        );
                                        this.requestUpdate();
                                    });
                                button.extraSettingsEl.addClass(
                                    "zotflow-settings-danger-btn",
                                );
                            });
                        },
                    },
                    {
                        name: "Auto-update source notes after sync",
                        desc: "When enabled, source notes for items changed during sync are automatically refreshed (incremental — unchanged notes are skipped).",
                        control: {
                            type: "toggle",
                            key: "autoUpdateSourceNotesAfterSync",
                        },
                    },
                    {
                        name: "Auto-purge source notes for trashed items",
                        desc: "When enabled, source notes for items moved to the Zotero trash are automatically removed (sent to the system trash) after each sync.",
                        control: {
                            type: "toggle",
                            key: "autoPurgeTrashedSourceNotes",
                        },
                    },
                    {
                        name: "Library Synchronization",
                        desc: "Manage the sync settings for each library.",
                        visible: () => this.keyInfoLoaded && !!this.keyInfo,
                        render: (setting) => {
                            let disposed = false;
                            const container = setting.infoEl.createDiv({
                                cls: "zotflow-settings-library-container",
                            });
                            container.createDiv({
                                text: "Loading libraries...",
                                cls: "setting-item-description",
                            });
                            void this.renderLibrariesTable(
                                container,
                                () => disposed,
                            );
                            return () => {
                                disposed = true;
                            };
                        },
                    },
                ],
            },
        ];
    }

    reset(): void {
        this.keyInfo = undefined;
        this.keyInfoLoaded = false;
        this.keyLoadPromise = undefined;
        this.keyLoadVersion += 1;
        this.apiKeyDraft = undefined;
    }

    private createApiDescription(): DocumentFragment {
        return createFragment((fragment) => {
            if (!this.keyInfoLoaded) {
                fragment.appendText("Checking stored Zotero API key...");
                return;
            }
            if (this.keyInfo) {
                fragment.appendText(
                    `Connected as ${this.keyInfo.username} (User ID: ${this.keyInfo.userID})`,
                );
                return;
            }
            fragment.appendText("Enter your Zotero API Key. Create one via ");
            fragment.createEl("a", {
                href: "https://www.zotero.org/settings/keys/new",
                text: "Zotero Settings",
            });
            fragment.appendText(".");
        });
    }

    private ensureKeyInfoLoaded(): void {
        if (this.keyInfoLoaded || this.keyLoadPromise) return;
        if (!this.plugin.settings.zoteroapikey) {
            this.setKeyInfo(undefined);
            return;
        }

        const loadVersion = ++this.keyLoadVersion;
        this.keyLoadPromise = (async () => {
            try {
                const keyInfo = await workerBridge.key.getKeyInfo(
                    this.plugin.settings.zoteroapikey,
                );
                if (loadVersion !== this.keyLoadVersion) return;
                this.setKeyInfo(keyInfo);
            } catch (error) {
                if (loadVersion !== this.keyLoadVersion) return;
                this.setKeyInfo(undefined);
                services.logService.warn(
                    "Failed to read cached Zotero API key",
                    "Settings",
                    error,
                );
            } finally {
                if (loadVersion === this.keyLoadVersion) {
                    this.keyLoadPromise = undefined;
                    this.requestUpdate();
                }
            }
        })();
    }

    private setKeyInfo(keyInfo: IDBZoteroKey | undefined): void {
        this.keyInfo = keyInfo;
        this.keyInfoLoaded = true;
    }

    private async renderLibrariesTable(
        containerEl: HTMLElement,
        isDisposed: () => boolean,
    ): Promise<void> {
        try {
            const libraryItems = await workerBridge.key.getLibraryRows(
                this.plugin.settings,
            );
            if (isDisposed()) return;
            containerEl.empty();

            if (libraryItems.length === 0) {
                containerEl.createDiv({
                    text: "No libraries found.",
                    cls: "setting-item-description",
                });
                return;
            }

            await this.initializeLibraryModes(libraryItems);
            if (isDisposed()) return;

            const tableWrapper = containerEl.createDiv({
                cls: "zotflow-settings-lib-table-wrapper",
            });
            const table = tableWrapper.createEl("table", {
                cls: "zotflow-settings-lib-table",
            });
            const headerRow = table.createEl("thead").createEl("tr");
            for (const heading of ["Type", "Name", "Access", "Sync Mode"]) {
                headerRow.createEl("th", { text: heading });
            }

            const body = table.createEl("tbody");
            for (const library of libraryItems) {
                this.renderLibraryRow(body, library);
            }

            const buttonContainer = containerEl.createDiv({
                cls: "zotflow-settings-table-btn-container",
            });
            const refreshButton = new ButtonComponent(buttonContainer);
            refreshButton
                .setButtonText("Refresh Libraries")
                .onClick(() =>
                    this.handleVerifyOrRefresh(refreshButton, "refresh"),
                );
            refreshButton.buttonEl.setCssStyles({ width: "120px" });
        } catch (error) {
            if (isDisposed()) return;
            containerEl.empty();
            containerEl.createDiv({
                text: "Unable to load libraries.",
                cls: "setting-item-description",
            });
            services.logService.error(
                "Failed to load Zotero libraries",
                "Settings",
                error,
            );
        }
    }

    private async initializeLibraryModes(
        libraryItems: LibraryRow[],
    ): Promise<void> {
        let dirty = false;
        for (const library of libraryItems) {
            const existingConfig =
                this.plugin.settings.librariesConfig[library.id];
            if (!existingConfig) {
                this.plugin.settings.librariesConfig[library.id] = {
                    mode: library.defaultMode,
                };
                dirty = true;
            } else if (!library.allowedModes.includes(existingConfig.mode)) {
                existingConfig.mode = library.defaultMode;
                dirty = true;
            }
        }
        if (dirty) await this.plugin.saveSettings();
    }

    private renderLibraryRow(
        body: HTMLTableSectionElement,
        library: LibraryRow,
    ): void {
        const row = body.createEl("tr");
        const typeCell = row.createEl("td", {
            cls: "zotflow-settings-lib-type-cell",
        });
        setIcon(typeCell, library.type === "user" ? "user" : "users");
        typeCell.createSpan({
            text: library.type === "user" ? " Personal" : " Group",
        });

        const nameCell = row.createEl("td", { text: library.name });
        nameCell.title = `ID: ${library.id}`;

        const accessCell = row.createEl("td");
        const badge = accessCell.createSpan({
            cls: library.canWrite
                ? "zotflow-settings-access-badge zotflow-settings-access-badge--rw"
                : "zotflow-settings-access-badge zotflow-settings-access-badge--ro",
        });
        badge.setText(library.canWrite ? "Read/Write" : "Read Only");
        accessCell.createDiv({
            cls: "zotflow-settings-access-notes",
            text: `Notes: ${library.hasNotesAccess ? "✓" : "✗"}`,
        });

        const select = row.createEl("td").createEl("select", {
            cls: "dropdown zotflow-settings-lib-select",
        });
        for (const mode of library.allowedModes) {
            select.createEl("option", {
                value: mode,
                text: MODE_LABELS[mode],
            });
        }
        select.value =
            this.plugin.settings.librariesConfig[library.id]?.mode ??
            library.defaultMode;
        select.addEventListener("change", () => {
            const mode = select.value as LibrarySyncMode;
            if (!library.allowedModes.includes(mode)) return;
            this.plugin.settings.librariesConfig[library.id] = { mode };
            void this.plugin.saveSettings();
        });
    }

    private async handleVerifyOrRefresh(
        button: ButtonComponent,
        mode: "verify" | "refresh",
    ): Promise<void> {
        const apiKey =
            mode === "verify"
                ? (this.apiKeyDraft ?? this.plugin.settings.zoteroapikey)
                : this.plugin.settings.zoteroapikey;
        if (!apiKey) {
            services.notificationService.notify(
                "warning",
                "Enter API Key first.",
            );
            return;
        }

        const originalText = button.buttonEl.innerText;
        button.setButtonText(
            mode === "verify" ? "Verifying..." : "Refreshing...",
        );
        button.setDisabled(true);

        try {
            const result = await workerBridge.key.verifyAndPersistKey(apiKey);
            if (mode === "verify") {
                this.plugin.settings.zoteroapikey = apiKey;
            }
            await this.plugin.saveSettings();
            services.notificationService.notify(
                "success",
                mode === "verify"
                    ? `Verified as ${result.username}`
                    : "Libraries refreshed.",
            );
            this.reset();
            this.ensureKeyInfoLoaded();
        } catch (error) {
            services.logService.error(
                `Zotero API ${mode} failed`,
                "Settings",
                error,
            );
            services.notificationService.notify(
                "error",
                `Error: ${describeError(error)}`,
            );
            if (mode === "verify") {
                this.plugin.settings.librariesConfig = {};
                this.requestUpdate();
            } else {
                button.setButtonText(originalText);
                button.setDisabled(false);
            }
        }
    }
}
