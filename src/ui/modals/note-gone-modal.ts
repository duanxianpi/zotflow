import { Modal, Setting } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type { App } from "obsidian";

/**
 * Offered when an edit reaches a note that no longer exists (deleted in
 * Zotero and removed by a sync): the text the user typed is kept until they
 * choose, and can be saved as a new note — under the same parent if it still
 * exists, otherwise as a standalone note.
 *
 * One prompt per note, however many edits arrive meanwhile.
 */
export class NoteGoneModal extends Modal {
    private static open = new Set<string>();

    private constructor(
        app: App,
        private libraryID: number,
        private noteKey: string,
        private parentKey: string,
        private parentExists: boolean,
        private content: () => string,
        private onSaved?: (newKey: string) => void,
    ) {
        super(app);
    }

    /** Shows the prompt for `noteKey`, unless it is already showing. */
    static show(
        app: App,
        options: {
            libraryID: number;
            noteKey: string;
            parentKey: string;
            parentExists: boolean;
            /** The text to save, read when the user chooses. */
            content: () => string;
            onSaved?: (newKey: string) => void;
        },
    ): void {
        const id = `${options.libraryID}/${options.noteKey}`;
        if (NoteGoneModal.open.has(id)) return;
        NoteGoneModal.open.add(id);
        services.notificationService.notify("warning", "This note was deleted in Zotero.");
        new NoteGoneModal(
            app,
            options.libraryID,
            options.noteKey,
            options.parentKey,
            options.parentExists,
            options.content,
            options.onSaved,
        ).open();
    }

    onOpen(): void {
        this.setTitle("This note was deleted in Zotero");
        this.contentEl.createEl("p", {
            text: "Your latest changes could not be saved to it. They are still in the editor.",
        });
        this.contentEl.createEl("p", {
            text: this.parentExists
                ? "Save them as a new note under the same item?"
                : "Its parent item is gone too. Save them as a standalone note?",
        });
        new Setting(this.contentEl)
            .addButton((b) =>
                b
                    .setButtonText("Save as new note")
                    .setCta()
                    .onClick(() => {
                        void this.save();
                    }),
            )
            .addButton((b) => b.setButtonText("Not now").onClick(() => this.close()));
    }

    private async save(): Promise<void> {
        try {
            const key = await workerBridge.itemNote.saveAsNewNote(
                this.libraryID,
                this.parentExists ? this.parentKey : "",
                this.content(),
            );
            services.notificationService.notify("success", "Saved as a new note.");
            this.onSaved?.(key);
            this.close();
        } catch (e) {
            services.logService.error("Failed to save the text as a new note", "NoteGoneModal", e);
            services.notificationService.notify("error", "Failed to save the note.");
        }
    }

    onClose(): void {
        this.contentEl.empty();
        NoteGoneModal.open.delete(`${this.libraryID}/${this.noteKey}`);
    }
}
