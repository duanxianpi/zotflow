import { ItemView, WorkspaceLeaf } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { matchLeadingNoteMeta, stripLeadingNoteMeta } from "utils/note-meta";
import {
    createEmbeddableMarkdownEditor,
    type EmbeddableMarkdownEditor,
} from "ui/editor/markdown-editor";

import type { ViewStateResult } from "obsidian";
import type { NoteData } from "types/zotero-item";
import type { IDBZoteroItem } from "types/db-schema";
import { fireAndForgetIn } from "utils/fire-and-forget";
import { NoteGoneModal } from "ui/modals/note-gone-modal";

const ff = fireAndForgetIn("NoteEditorView");

export const NOTE_EDITOR_VIEW_TYPE = "zotflow-note-editor-view";

const SAVE_DEBOUNCE_MS = 2000;

interface NoteEditorState extends Record<string, unknown> {
    libraryID: number;
    noteKey: string;
}

/** Editable Obsidian `ItemView` for a Zotero child note, using the embeddable markdown editor. */
export class NoteEditorView extends ItemView {
    private noteItem?: IDBZoteroItem<NoteData>;
    private editor?: EmbeddableMarkdownEditor;
    /** Stripped `<!-- ZF_NOTE_META ... -->` line to re-inject on save. */
    private metaLine = "";
    /** `window.setTimeout` handle — a number, unlike Node's `Timeout`. */
    private saveTimer?: number;
    private unsubscribeSyncFinished?: () => void;
    private unsubscribeNoteChanged?: () => void;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType() {
        return NOTE_EDITOR_VIEW_TYPE;
    }

    getDisplayText() {
        const base = this.noteItem?.title ?? "Zotero Note";
        return this.isReadOnly() ? `${base} (READ ONLY)` : base;
    }

    getIcon() {
        return "sticky-note";
    }

    async setState(
        state: NoteEditorState,
        result: ViewStateResult,
    ): Promise<void> {
        if (!state.libraryID || !state.noteKey) return;

        const item = await workerBridge.dbHelper.getItem(
            state.libraryID,
            state.noteKey,
        );

        if (!item || item.itemType !== "note") {
            services.logService.error(
                `Note item ${state.noteKey} not found or not a note`,
                "NoteEditorView",
            );
            services.notificationService.notify(
                "error",
                "Failed to open note preview: item not found",
            );
            return;
        }

        this.noteItem = item;

        // Update tab title
        this.updateTitle();

        await this.renderContent();
        this.subscribeToSyncEvents();
        this.subscribeToNoteChanges();
        return super.setState(state, result);
    }

    getState(): NoteEditorState {
        return {
            libraryID: this.noteItem?.libraryID ?? 0,
            noteKey: this.noteItem?.key ?? "",
        };
    }

    private async renderContent() {
        this.destroyEditor();
        this.contentEl.empty();

        if (!this.noteItem) return;

        try {
            let editableContent = "";
            this.metaLine = "";

            const noteHtml: string = this.noteItem.raw.data.note || "";

            if (noteHtml.trim()) {
                const markdown = await workerBridge.itemNote.getNoteAsMarkdown(
                    this.noteItem.libraryID,
                    this.noteItem.key,
                );

                // Strip and store the metadata comment so the user cannot edit it
                const metaMatch = matchLeadingNoteMeta(markdown);
                if (metaMatch) {
                    this.metaLine = metaMatch.raw;
                }
                editableContent = stripLeadingNoteMeta(markdown);
            }

            const wrapper = this.contentEl.createDiv({
                cls: "zotflow-note-preview-content",
            });

            const editable = !this.isReadOnly();

            this.editor = createEmbeddableMarkdownEditor(this.app, wrapper, {
                value: editableContent,
                readableLineLength: true,
                readOnly: !editable,
                onChange: editable ? () => this.scheduleSave() : () => {},
            });
        } catch (e) {
            services.logService.error(
                "Failed to render note editor",
                "NoteEditorView",
                e,
            );
            services.notificationService.notify(
                "error",
                "Failed to render note content",
            );
        }
    }

    /**
     * True when this note's library is not editable (read-only sync mode
     * or the API key lacks notes write permission).
     */
    private isReadOnly(): boolean {
        if (!this.noteItem) return false;
        return !services.libraryCache.canEditNotes(this.noteItem.libraryID);
    }

    /**
     * Debounced save: re-inject the metadata line and push to IDB via the worker.
     */
    private scheduleSave() {
        if (this.saveTimer !== undefined) {
            window.clearTimeout(this.saveTimer);
        }
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = undefined;
            ff(this.saveContent(), "Failed to save the note");
        }, SAVE_DEBOUNCE_MS);
    }

    private async saveContent() {
        if (!this.noteItem || !this.editor) return;

        const content = this.metaLine + this.editor.value;

        try {
            const result = await workerBridge.itemNote.updateNoteContent(
                this.noteItem.libraryID,
                this.noteItem.key,
                content,
                "note-view",
                this.noteItem.parentItem,
            );
            if (result.status === "gone") {
                this.promptGone(result.parentKey, result.parentExists);
                return;
            }

            // Re-fetch to pick up the derived title
            const updated = await workerBridge.dbHelper.getItem(
                this.noteItem.libraryID,
                this.noteItem.key,
            );
            if (updated && updated.itemType === "note") {
                this.noteItem = updated;
                this.updateTitle();
            }

            services.logService.debug(
                `Saved note ${this.noteItem.key}`,
                "NoteEditorView",
            );
        } catch (e) {
            services.logService.error(
                "Failed to save note content",
                "NoteEditorView",
                e,
            );
            services.notificationService.notify("error", "Failed to save note");
        }
    }

    /**
     * Subscribe to sync completion events. When a sync finishes for this
     * note's library, re-fetch the item from IDB and refresh the editor.
     */
    private subscribeToSyncEvents() {
        this.unsubscribeSyncFinished?.();

        this.unsubscribeSyncFinished = services.eventHub.syncFinished.subscribe(
            (task) => {
                if (task.status !== "completed") return;

                // Only refresh if the sync covers this note's library
                const taskLibId = task.input?.["libraryId"] as
                    number | undefined;
                if (
                    taskLibId !== undefined &&
                    taskLibId !== this.noteItem?.libraryID
                ) {
                    return;
                }

                ff(this.refreshAfterSync(), "Failed to refresh after sync");
            },
        );
    }

    /**
     * Subscribe to note-changed events fired when the source-note
     * editable region updates this note.  We only listen to
     * `noteChangedByEditor`
     */
    private subscribeToNoteChanges() {
        this.unsubscribeNoteChanged?.();

        this.unsubscribeNoteChanged =
            services.eventHub.noteChangedByEditor.subscribe(
                (_libraryID, noteKey, _parentItemKey) => {
                    if (noteKey !== this.noteItem?.key) return;
                    ff(this.refreshAfterSync(), "Failed to refresh after sync");
                },
            );
    }

    private async refreshAfterSync() {
        if (!this.noteItem) return;

        // Flush pending saves before overwriting with synced content
        if (this.saveTimer !== undefined) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
            await this.saveContent();
        }

        const item = await workerBridge.dbHelper.getItem(
            this.noteItem.libraryID,
            this.noteItem.key,
        );

        if (!item || item.itemType !== "note") {
            // Deleted in Zotero: keep what is on screen and say so.
            const parentKey = this.noteItem.parentItem;
            const parent = parentKey
                ? await workerBridge.dbHelper.getItem(
                      this.noteItem.libraryID,
                      parentKey,
                  )
                : undefined;
            this.promptGone(parentKey, !!parent);
            return;
        }

        this.noteItem = item;
        this.updateTitle();

        await this.renderContent();
    }

    /**
     * The note is gone (deleted in Zotero): the text stays in the editor and
     * the user is asked to save it as a new note — the same prompt as the
     * source-note editor. Once saved, editing continues on the new note.
     */
    private promptGone(parentKey: string, parentExists: boolean) {
        const note = this.noteItem;
        if (!note) return;
        NoteGoneModal.show(this.app, {
            libraryID: note.libraryID,
            noteKey: note.key,
            parentKey,
            parentExists,
            content: () => this.metaLine + (this.editor?.value ?? ""),
            onSaved: (key) =>
                ff(
                    this.switchToNote(note.libraryID, key),
                    "Failed to open the new note",
                ),
        });
    }

    private async switchToNote(libraryID: number, key: string) {
        const item = await workerBridge.dbHelper.getItem(libraryID, key);
        if (!item || item.itemType !== "note") return;
        this.noteItem = item;
        this.updateTitle();
    }

    private updateTitle() {
        const base = this.noteItem?.title || "Zotero Note";
        const title = this.isReadOnly() ? `${base} (READ ONLY)` : base;
        this.containerEl
            .getElementsByClassName("view-header-title")[0]
            ?.setText(title);
        this.leaf.tabHeaderInnerTitleEl?.setText(title);
    }

    private destroyEditor() {
        if (this.saveTimer !== undefined) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        if (this.editor) {
            this.editor.destroy();
            this.editor = undefined;
        }
    }

    async onClose() {
        this.unsubscribeSyncFinished?.();
        this.unsubscribeSyncFinished = undefined;
        this.unsubscribeNoteChanged?.();
        this.unsubscribeNoteChanged = undefined;
        // Flush any pending save before closing
        if (this.saveTimer !== undefined) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
            await this.saveContent();
        }
        this.destroyEditor();
        this.contentEl.empty();
    }
}
