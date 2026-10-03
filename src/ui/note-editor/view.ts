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
import {
    promptNoteGone,
    registerNoteTextSource,
} from "ui/modals/note-gone-modal";

const ff = fireAndForgetIn("NoteEditorView");

export const NOTE_EDITOR_VIEW_TYPE = "zotflow-note-editor-view";

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
    private unsubscribeSyncFinished?: () => void;
    private unsubscribeNoteChanged?: () => void;
    private unregisterOpenHooks: (() => void)[] = [];

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

    async onOpen() {
        const shows = (libraryID: number, noteKey: string) =>
            this.noteItem?.libraryID === libraryID &&
            this.noteItem.key === noteKey;
        this.unregisterOpenHooks = [
            // A gone note's prompt reads the text from here, and once it is
            // saved as a new note, editing continues there.
            registerNoteTextSource({
                text: (libraryID, noteKey) =>
                    shows(libraryID, noteKey) ? this.currentContent() : null,
                saved: (libraryID, noteKey, newKey) => {
                    if (!shows(libraryID, noteKey)) return;
                    ff(
                        this.switchToNote(libraryID, newKey),
                        "Failed to open the new note",
                    );
                },
            }),
            // A written edit can change the note's title (its first line).
            services.eventHub.noteChangedByNoteView.subscribe(
                (libraryID, noteKey) => {
                    if (!shows(libraryID, noteKey)) return;
                    ff(this.refreshTitle(), "Failed to refresh the title");
                },
            ),
        ];
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
                onChange: editable ? () => this.sendContent() : () => {},
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
     * Sends the text (metadata line re-injected) to the worker's edit queue,
     * which writes it once the user pauses — and first, should the source
     * note re-render or a sync start meanwhile.
     */
    private sendContent() {
        const note = this.noteItem;
        if (!note || !this.editor) return;
        workerBridge.editQueue
            .submitNote(
                note.libraryID,
                note.key,
                this.currentContent(),
                "note-view",
                note.parentItem,
                note.parentItem,
            )
            .catch((e: unknown) =>
                services.logService.error(
                    "Failed to send the note to the worker",
                    "NoteEditorView",
                    e,
                ),
            );
    }

    /** Writes this note's waiting edits now (they are in the worker's queue). */
    private async flushSave() {
        const note = this.noteItem;
        if (!note) return;
        await workerBridge.editQueue.flushFor(note.libraryID, note.parentItem);
    }

    private async refreshTitle() {
        if (!this.noteItem) return;
        const updated = await workerBridge.dbHelper.getItem(
            this.noteItem.libraryID,
            this.noteItem.key,
        );
        if (updated && updated.itemType === "note") {
            this.noteItem = updated;
            this.updateTitle();
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
        await this.flushSave();

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
     * the user is asked to save it as a new note — the same prompt as for
     * an edit that finds it gone. Once saved, editing continues on the new
     * note (see `onOpen`).
     */
    private promptGone(parentKey: string, parentExists: boolean) {
        const note = this.noteItem;
        if (!note) return;
        promptNoteGone({
            libraryID: note.libraryID,
            noteKey: note.key,
            parentKey,
            parentExists,
            content: this.currentContent(),
        });
    }

    private currentContent(): string {
        return this.metaLine + (this.editor?.value ?? "");
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
        for (const unregister of this.unregisterOpenHooks) unregister();
        this.unregisterOpenHooks = [];
        this.destroyEditor();
        this.contentEl.empty();
    }
}
