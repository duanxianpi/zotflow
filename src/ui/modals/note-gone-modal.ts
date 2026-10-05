import { Modal, Setting } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { stripLeadingNoteMeta } from "utils/note-meta";

import type { App } from "obsidian";

/** A note deleted in Zotero whose text is still in an editor. */
export interface GoneNote {
    libraryID: number;
    noteKey: string;
    parentKey: string;
    parentExists: boolean;
}

/**
 * Saves the text of a gone note as a new note: under its parent if that
 * still exists, otherwise standalone.
 *
 * @returns the new note's key, or null if saving failed (already reported).
 */
export async function saveGoneNoteText(note: GoneNote, content: string): Promise<string | null> {
    try {
        const key = await workerBridge.itemNote.saveAsNewNote(
            note.libraryID,
            note.parentExists ? note.parentKey : "",
            content,
        );
        services.notificationService.notify("success", "Saved as a new note.");
        return key;
    } catch (e) {
        services.logService.error("Failed to save the text as a new note", "NoteGoneModal", e);
        services.notificationService.notify("error", "Failed to save the note.");
        return null;
    }
}

/**
 * An open editor that shows notes: where the prompt reads a gone note's
 * latest text, and whom it tells once that text is saved as a new note.
 */
export interface NoteTextSource {
    /** The note's text as the editor shows it now, or null if it does not show it. */
    text(libraryID: number, noteKey: string): string | null;
    /** The text of `noteKey` was saved as the new note `newKey`. */
    saved?(libraryID: number, noteKey: string, newKey: string): void;
}

const sources = new Set<NoteTextSource>();

/** Registers an editor as a `NoteTextSource`; returns the unregister function. */
export function registerNoteTextSource(source: NoteTextSource): () => void {
    sources.add(source);
    return () => {
        sources.delete(source);
    };
}

/**
 * Prompts for a note an edit found deleted in Zotero (the worker's
 * `noteGone`). What is saved is read when the user chooses, from an editor
 * still showing the note, else the text the edit carried — so neither later
 * typing nor a closed editor loses anything.
 */
export function promptNoteGone(event: GoneNote & { content: string }): void {
    const latest = () => {
        for (const source of sources) {
            const text = source.text(event.libraryID, event.noteKey);
            if (text !== null) return text;
        }
        return event.content;
    };
    NoteGoneModal.show(services.app, {
        libraryID: event.libraryID,
        noteKey: event.noteKey,
        parentKey: event.parentKey,
        parentExists: event.parentExists,
        content: latest,
        onSaved: (newKey) => {
            for (const source of sources) source.saved?.(event.libraryID, event.noteKey, newKey);
        },
    });
}

/**
 * Offered when an edit reaches a note that no longer exists (deleted in
 * Zotero and removed by a sync): the text the user typed is kept until they
 * choose, and can be saved as a new note — under the same parent if it still
 * exists, otherwise as a standalone note.
 *
 * One prompt per note at a time, however many edits arrive meanwhile. After
 * "Not now" the next edit of the gone note prompts again: the prompt is the
 * only way to save the text, so it is never silenced.
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
        this.modalEl.addClass("zotflow-modal", "zotflow-note-gone-modal");
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
        const { contentEl } = this;
        this.setTitle(`Note ${this.noteKey} was deleted in Zotero`);

        // Which note: the item it was under, then its first lines.
        const subtitle = contentEl.createDiv({
            cls: "zotflow-note-gone-subtitle",
            text: this.parentExists ? "Note under an item" : "Standalone note",
        });
        if (this.parentExists) void this.showParentTitle(subtitle);

        const { lines, more } = previewLines(this.content());
        const preview = contentEl.createDiv({ cls: "zotflow-note-gone-preview" });
        if (lines.length === 0) {
            preview.createDiv({ cls: "zotflow-note-gone-preview-empty", text: "(empty note)" });
        }
        for (const line of lines) preview.createDiv({ text: line });
        if (more) preview.createDiv({ cls: "zotflow-note-gone-preview-more", text: "…" });

        contentEl.createEl("p", {
            cls: "zotflow-note-gone-text",
            text: this.parentExists
                ? "Your latest changes could not be saved to it; they are still in the editor. Save them as a new note under the same item?"
                : "Your latest changes could not be saved to it, and its item is gone too; they are still in the editor. Save them as a standalone note?",
        });
        new Setting(contentEl)
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

    private async showParentTitle(el: HTMLElement): Promise<void> {
        try {
            const parent = await workerBridge.dbHelper.getItem(this.libraryID, this.parentKey);
            if (!parent?.title) return;
            const citationKey = parent.citationKey ? ` (${parent.citationKey})` : "";
            el.setText(`Note under “${parent.title}”${citationKey}`);
        } catch {
            // The generic subtitle stays.
        }
    }

    private async save(): Promise<void> {
        const key = await saveGoneNoteText(
            {
                libraryID: this.libraryID,
                noteKey: this.noteKey,
                parentKey: this.parentKey,
                parentExists: this.parentExists,
            },
            this.content(),
        );
        if (key === null) return;
        this.onSaved?.(key);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        NoteGoneModal.open.delete(`${this.libraryID}/${this.noteKey}`);
    }
}

/** Lines of a note shown to say which one it is. */
const PREVIEW_LINES = 5;

/** The first non-empty lines of a note's markdown (its metadata line left out). */
function previewLines(markdown: string): { lines: string[]; more: boolean } {
    const all = stripLeadingNoteMeta(markdown)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    return { lines: all.slice(0, PREVIEW_LINES), more: all.length > PREVIEW_LINES };
}
