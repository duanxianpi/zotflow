import { Modal, Setting } from "obsidian";
import {
    planWriteBack,
    TEMPLATE_TARGETS,
    writeBackWarnings,
} from "ui/activity-center/template-targets";

import type { App } from "obsidian";
import type {
    SavedTemplate,
    WriteBackPlan,
} from "ui/activity-center/template-targets";

/**
 * Confirms saving a tested template: where it goes, what it replaces, and,
 * for a source note with no template file yet, the file to create.
 */
export class TemplateWriteBackModal extends Modal {
    private chosenPath: string;
    private planEl: HTMLElement | null = null;

    constructor(
        app: App,
        private readonly saved: SavedTemplate,
        private readonly text: string,
        private readonly onConfirm: (plan: WriteBackPlan) => Promise<boolean>,
    ) {
        super(app);
        const target = TEMPLATE_TARGETS[saved.context];
        this.chosenPath = target.kind === "file" ? target.defaultPath : "";
    }

    onOpen(): void {
        const target = TEMPLATE_TARGETS[this.saved.context];
        this.setTitle("Save template");
        this.modalEl.addClass("zotflow-modal", "zotflow-template-save-modal");
        const { contentEl } = this;

        if (target.kind === "file" && !this.saved.filePath) {
            contentEl.createEl("p", {
                text: "No template file is set yet. ZotFlow creates this file and uses it from now on.",
            });
            new Setting(contentEl).setName("Template file").addText((text) => {
                text.setValue(this.chosenPath).onChange((value) => {
                    this.chosenPath = value;
                    this.renderPlan();
                });
                text.inputEl.addClass("zotflow-template-save-path");
            });
        }

        this.planEl = contentEl.createDiv({ cls: "zotflow-template-save-plan" });
        this.renderPlan();

        for (const warning of writeBackWarnings(this.saved, this.text)) {
            contentEl.createDiv({ cls: "zotflow-template-save-warning", text: warning });
        }

        if (this.saved.stored?.trim()) {
            const details = contentEl.createEl("details", {
                cls: "zotflow-template-save-current",
            });
            details.createEl("summary", { text: "Current template" });
            details.createEl("pre", { text: this.saved.stored });
        }

        new Setting(contentEl)
            .addButton((b) =>
                b
                    .setButtonText("Save")
                    .setCta()
                    .onClick(async () => {
                        const plan = this.plan();
                        if (plan.kind === "file" && !plan.path) return;
                        b.setDisabled(true);
                        if (await this.onConfirm(plan)) this.close();
                        else b.setDisabled(false);
                    }),
            )
            .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private plan(): WriteBackPlan {
        return planWriteBack(this.saved, this.text, this.chosenPath);
    }

    private renderPlan(): void {
        if (!this.planEl) return;
        this.planEl.empty();
        const target = TEMPLATE_TARGETS[this.saved.context];
        const plan = this.plan();
        if (plan.kind === "setting") {
            this.planEl.createEl("p", { text: `Saves to the setting ${target.label}.` });
            if (plan.clearsToBuiltIn) {
                this.planEl.createEl("p", {
                    text: "This is the built-in template, so the setting is cleared and keeps following the built-in default.",
                });
            } else if (!plan.value) {
                this.planEl.createEl("p", {
                    text:
                        this.saved.context === "display-title"
                            ? "The template is empty: items show their Zotero titles."
                            : "The template is empty: the setting is cleared and the built-in default is used.",
                });
            }
            return;
        }
        if (!plan.path) {
            this.planEl.createEl("p", {
                cls: "zotflow-template-save-warning",
                text: "Enter a path for the template file.",
            });
            return;
        }
        this.planEl.createEl("p", {
            text:
                this.saved.stored !== null
                    ? `Overwrites the template file ${plan.path}.`
                    : `Writes the template file ${plan.path}.`,
        });
    }
}
