import { Modal } from "obsidian";
import type { App } from "obsidian";

/** Multiple reader panes should share one installation prompt. */
export class EnhancementPackInstallModal extends Modal {
    private static current?: EnhancementPackInstallModal;

    static show(app: App): EnhancementPackInstallModal {
        if (!this.current) {
            this.current = new EnhancementPackInstallModal(app);
            this.current.open();
        }
        return this.current;
    }

    onOpen(): void {
        this.modalEl.addClass("zotflow-modal");
        this.setTitle("Install ZotFlow Enhancement Pack");
        this.contentEl.createEl("p", {
            text: "This feature needs the offline resources in ZotFlow Enhancement Pack.",
        });
        this.contentEl.createEl("p", {
            text: "Install the pack, then try the feature again. The pack can remain disabled.",
        });
        this.contentEl.createEl("a", {
            text: "Open ZotFlow Enhancement Pack in community plugins",
            href: "obsidian://show-plugin?id=zotflow-enhancement-pack",
        });
    }

    onClose(): void {
        this.contentEl.empty();
        if (EnhancementPackInstallModal.current === this) {
            EnhancementPackInstallModal.current = undefined;
        }
    }
}
