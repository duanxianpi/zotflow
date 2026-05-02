import { Setting, ButtonComponent, setIcon, SettingGroup } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type ZotFlow from "main";
import type { LibrarySyncMode } from "settings/types";
import type { LibraryRow } from "worker/services/key";

/** Settings section for API key verification and per-library sync mode configuration. */
export class SyncSection {
    constructor(
        private plugin: ZotFlow,
        private refreshUI: () => void,
    ) {}

    async render(containerEl: HTMLElement) {
        const settingGroup = new SettingGroup(containerEl);
        settingGroup.setHeading("Synchronization");

        // Retrieve cached key info
        const keyInfo = await workerBridge.key.getKeyInfo(
            this.plugin.settings.zoteroapikey,
        );

        // Description
        const apiDescContainer = new DocumentFragment();
        const descDiv = apiDescContainer.createDiv();
        if (keyInfo) {
            descDiv.createSpan({
                text: `Connected as ${keyInfo.username} (User ID: ${keyInfo.userID})`,
            });
        } else {
            descDiv.createSpan({
                text: "Enter your Zotero API Key. Create one via ",
            });
            descDiv.createEl("a", {
                href: "https://www.zotero.org/settings/keys/new",
                text: "Zotero Settings",
            });
            descDiv.createSpan({ text: "." });
        }
        // API Key Input
        settingGroup.addSetting(async (setting) => {
            setting
                .setName("API Key")
                .setDesc(apiDescContainer)
                .addText((text) => {
                    text.setPlaceholder("Enter API Key")
                        .setValue(this.plugin.settings.zoteroapikey)
                        .onChange(async (value) => {
                            this.plugin.settings.zoteroapikey = value.trim();
                        });

                    if (keyInfo) {
                        text.setDisabled(true);
                        text.inputEl.type = "password";
                    } else {
                        text.inputEl.type = "text";
                    }
                    text.inputEl.size = 30;
                });

            // Verify Button
            setting.addButton(
                (button) =>
                    (button
                        .setButtonText(keyInfo ? "Verified" : "Verify Key")
                        .setCta()
                        .setDisabled(!!keyInfo)
                        .onClick(() =>
                            this.handleVerifyOrRefresh(button, "verify"),
                        ).buttonEl.style.width = "100px"),
            );

            // Clear Button
            setting.addExtraButton((btn) => {
                btn.setIcon("trash")
                    .setTooltip("Disconnect & Clear Key")
                    .onClick(async () => {
                        const oldKey = this.plugin.settings.zoteroapikey;
                        this.plugin.settings.zoteroapikey = "";
                        this.plugin.settings.librariesConfig = {};
                        if (oldKey) await workerBridge.key.deleteKey(oldKey);

                        await this.plugin.saveSettings();

                        services.notificationService.notify(
                            "info",
                            "Disconnected.",
                        );
                        this.refreshUI();
                    });
                btn.extraSettingsEl.addClass("zotflow-settings-danger-btn");
            });
        });

        // Libraries Table
        if (keyInfo) {
            settingGroup.addSetting(async (setting) => {
                setting.setName("Library Synchronization");
                setting.setDesc("Manage the sync settings for each library.");
                await this.renderLibrariesTable(setting.infoEl);
            });
        }
    }

    private async renderLibrariesTable(containerEl: HTMLElement) {
        // Prepare Data — the KeyService computes everything we need
        const libraryItems = await workerBridge.key.getLibraryRows(
            this.plugin.settings,
        );

        if (libraryItems.length === 0) {
            containerEl.createDiv({
                text: "No libraries found.",
                cls: "setting-item-description",
            });
            return;
        }

        // Sync Config Logic (Auto-init)
        let dirty = false;
        for (const lib of libraryItems) {
            const existingConfig = this.plugin.settings.librariesConfig[lib.id];
            if (!existingConfig) {
                this.plugin.settings.librariesConfig[lib.id] = {
                    mode: lib.defaultMode,
                };
                dirty = true;
            } else if (!lib.allowedModes.includes(existingConfig.mode)) {
                this.plugin.settings.librariesConfig[lib.id]!.mode =
                    lib.defaultMode;
                dirty = true;
            }
        }
        if (dirty) await this.plugin.saveSettings();

        const tableWrapper = containerEl.createDiv({
            cls: "zotflow-settings-lib-table-wrapper",
        });

        const table = tableWrapper.createEl("table", {
            cls: "zotflow-settings-lib-table",
        });

        const thead = table.createEl("thead");
        const hRow = thead.createEl("tr");
        ["Type", "Name", "Access", "Sync Mode"].forEach((h) => {
            hRow.createEl("th", { text: h });
        });

        const tbody = table.createEl("tbody");
        libraryItems.forEach((lib) => {
            const row = tbody.createEl("tr");

            const typeCell = row.createEl("td", {
                cls: "zotflow-settings-lib-type-cell",
            });
            setIcon(typeCell, lib.type === "user" ? "user" : "users");
            typeCell.createSpan({
                text: lib.type === "user" ? " Personal" : " Group",
            });

            const nameCell = row.createEl("td", { text: lib.name });
            nameCell.title = `ID: ${lib.id}`;

            const accessCell = row.createEl("td");
            const badgeCls = lib.canWrite
                ? "zotflow-settings-access-badge zotflow-settings-access-badge--rw"
                : "zotflow-settings-access-badge zotflow-settings-access-badge--ro";
            const badge = accessCell.createSpan({ cls: badgeCls });
            badge.setText(lib.canWrite ? "Read/Write" : "Read Only");

            // Surface notes permission separately so users can see why note
            // edits may be disabled even on a Read/Write library.
            const notesLine = accessCell.createDiv({
                cls: "zotflow-settings-access-notes",
            });
            notesLine.setText(
                `Notes: ${lib.hasNotesAccess ? "\u2713" : "\u2717"}`,
            );

            const actionCell = row.createEl("td");
            const select = actionCell.createEl("select");
            select.className = "dropdown zotflow-settings-lib-select";

            const modeLabels: Record<string, string> = {
                bidirectional: "Bidirectional",
                readonly: "Read-Only",
                ignored: "Ignored",
            };

            lib.allowedModes.forEach((m) => {
                const opt = select.createEl("option");
                opt.value = m;
                opt.text = modeLabels[m]!;
            });

            select.value = this.plugin.settings.librariesConfig[lib.id]!.mode;
            select.addEventListener("change", async () => {
                this.plugin.settings.librariesConfig[lib.id]!.mode =
                    select.value as LibrarySyncMode;
                await this.plugin.saveSettings();
            });
        });

        const btnContainer = containerEl.createDiv({
            cls: "zotflow-settings-table-btn-container",
        });
        new Setting(btnContainer).addButton(
            (btn) =>
                (btn
                    .setButtonText("Refresh Libraries")
                    .onClick(() =>
                        this.handleVerifyOrRefresh(btn, "refresh"),
                    ).buttonEl.style.width = "120px"),
        );
    }

    private async handleVerifyOrRefresh(
        btn: ButtonComponent,
        mode: "verify" | "refresh",
    ) {
        const apiKey = this.plugin.settings.zoteroapikey;
        if (!apiKey) {
            services.notificationService.notify(
                "warning",
                "Enter API Key first.",
            );
            return;
        }

        const originalText = btn.buttonEl.innerText;
        btn.setButtonText(mode === "verify" ? "Verifying..." : "Refreshing...");
        btn.setDisabled(true);

        try {
            // Verify key & persist key/groups/libraries via worker
            const result = await workerBridge.key.verifyAndPersistKey(apiKey);

            services.notificationService.notify(
                "success",
                mode === "verify"
                    ? `Verified as ${result.username}`
                    : "Libraries refreshed.",
            );
            await this.plugin.saveSettings();

            this.refreshUI();
        } catch (error: any) {
            services.logService.error(
                `Zotero API ${mode} failed`,
                "Settings",
                error,
            );
            services.notificationService.notify(
                "error",
                `Error: ${error.message}`,
            );
            if (mode === "verify") {
                this.plugin.settings.librariesConfig = {};
                // Even on failure, refresh to unlock inputs if needed
                this.refreshUI();
            } else {
                btn.setButtonText(originalText);
                btn.setDisabled(false);
            }
        }
    }
}
