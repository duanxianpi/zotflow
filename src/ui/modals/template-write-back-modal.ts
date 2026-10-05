import { Modal, Setting } from "obsidian";
import { readTextFile } from "utils/file";
import {
    planWriteBack,
    TEMPLATE_TARGETS,
    writeBackWarnings,
} from "ui/activity-center/template-targets";

import type { App, ButtonComponent } from "obsidian";
import type {
    SavedTemplate,
    WriteBackPlan,
} from "ui/activity-center/template-targets";

/** What is at a file target's path, once read. */
interface FileCheck {
    path: string;
    /** The file's content; null when there is no file. */
    content: string | null;
}

/**
 * Confirms saving a tested template: where it goes and what it replaces.
 * For a template file it reads the actual target first, so that it says
 * whether saving creates the file or overwrites one, and shows what would
 * be overwritten.
 */
export class TemplateWriteBackModal extends Modal {
    private chosenPath: string;
    private planEl: HTMLElement | null = null;
    private saveButton: ButtonComponent | null = null;
    /** The last finished read of the file target; stale once the path changes. */
    private fileCheck: FileCheck | null = null;
    private checkSeq = 0;

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
                text: "No template file is set yet. ZotFlow saves the template to this file and uses it from now on.",
            });
            new Setting(contentEl).setName("Template file").addText((text) => {
                text.setValue(this.chosenPath).onChange((value) => {
                    this.chosenPath = value;
                    void this.checkFile();
                });
                text.inputEl.addClass("zotflow-template-save-path");
            });
        }

        this.planEl = contentEl.createDiv({ cls: "zotflow-template-save-plan" });

        for (const warning of writeBackWarnings(this.saved, this.text)) {
            contentEl.createDiv({ cls: "zotflow-template-save-warning", text: warning });
        }

        // A setting's current value; a file's is shown by the plan, read fresh.
        if (target.kind === "setting" && this.saved.stored?.trim()) {
            const details = contentEl.createEl("details", {
                cls: "zotflow-template-save-current",
            });
            details.createEl("summary", { text: "Current template" });
            details.createEl("pre", { text: this.saved.stored });
        }

        new Setting(contentEl)
            .addButton((b) => {
                this.saveButton = b;
                b.setButtonText("Save")
                    .setCta()
                    .onClick(async () => {
                        if (!this.canSave()) return;
                        b.setDisabled(true);
                        if (await this.onConfirm(this.plan())) this.close();
                        else b.setDisabled(false);
                    });
            })
            .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));

        this.renderPlan();
        if (target.kind === "file") void this.checkFile();
    }

    onClose(): void {
        this.checkSeq++;
        this.contentEl.empty();
    }

    private plan(): WriteBackPlan {
        return planWriteBack(this.saved, this.text, this.chosenPath);
    }

    /** A file target can be saved once its path is read; a setting at once. */
    private canSave(): boolean {
        const plan = this.plan();
        if (plan.kind === "setting") return true;
        return plan.path !== "" && this.fileCheck?.path === plan.path;
    }

    /** Read what is at the file target's path now. */
    private async checkFile(): Promise<void> {
        const plan = this.plan();
        if (plan.kind !== "file") return;
        const seq = ++this.checkSeq;
        this.renderPlan();
        if (!plan.path) return;
        let content: string | null = null;
        try {
            content = await readTextFile(this.app, plan.path);
        } catch {
            // Unreadable counts as absent; saving reports a failed write.
        }
        if (seq !== this.checkSeq) return;
        this.fileCheck = { path: plan.path, content };
        this.renderPlan();
    }

    private renderPlan(): void {
        if (!this.planEl) return;
        this.planEl.empty();
        this.saveButton?.setDisabled(!this.canSave());
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
        if (this.fileCheck?.path !== plan.path) {
            this.planEl.createEl("p", { text: `Checking ${plan.path}…` });
            return;
        }
        const existing = this.fileCheck.content;
        if (existing === null) {
            this.planEl.createEl("p", { text: `Creates the template file ${plan.path}.` });
            return;
        }
        this.planEl.createEl("p", {
            cls: plan.setsPath ? "zotflow-template-save-warning" : undefined,
            text: plan.setsPath
                ? `A file already exists at ${plan.path}. Saving replaces its content with the template.`
                : `Overwrites the template file ${plan.path}.`,
        });
        const details = this.planEl.createEl("details", {
            cls: "zotflow-template-save-current",
        });
        details.createEl("summary", {
            text: plan.setsPath ? "Content of the existing file" : "Current template",
        });
        details.createEl("pre", { text: existing });
    }
}
