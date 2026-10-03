import { db } from "db/db";
import {
    createLocalItems,
    deleteLocalItems,
    mutateItem,
    newLocalItem,
} from "db/mutate";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import {
    zotflowToZoteroLinks,
    zoteroToZotflowLinks,
} from "worker/convert/note-links";
import { createDbNoteLinkResolver } from "./note-link-resolver";

import type { IDBZoteroItem } from "types/db-schema";
import type { NoteData } from "types/zotero-item";
import type { IParentProxy } from "bridge/types";
import type { ConvertService } from "./convert";
import type { LibraryNoteService } from "./library-note";
import type { ZotFlowSettings } from "settings/types";

/**
 * What happened to a note edit. `gone`: the note no longer exists (deleted in
 * Zotero and removed by a sync, or deleted elsewhere) — the caller must keep
 * the user's text and offer to save it as a new note (`saveAsNewNote`).
 */
export type NoteSaveResult =
    | { status: "saved" }
    | { status: "gone"; parentKey: string; parentExists: boolean };

/**
 * CRUD service for Zotero **child note items** (the note items attached to
 * parent items inside a Zotero library).
 *
 * Separated from `LibraryNoteService` (which manages Obsidian source notes
 * rendered from templates) because the two operate on different data:
 *   - ItemNoteService  → IDB `items` table (itemType "note")
 *   - LibraryNoteService → Obsidian vault files
 */
export class ItemNoteService {
    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        private convertService: ConvertService,
        private sourceNoteService: LibraryNoteService,
    ) {}

    updateSettings(newSettings: ZotFlowSettings) {
        this.settings = newSettings;
    }

    /**
     * Return the content of a Zotero child note as Markdown.
     */
    async getNoteAsMarkdown(
        libraryID: number,
        noteKey: string,
    ): Promise<string> {
        const item = await db.items.get([libraryID, noteKey]);

        if (!item || item.itemType !== "note") {
            this.parentHost.log(
                "warn",
                `getNoteAsMarkdown: item ${noteKey} not found or not a note`,
                "ItemNoteService",
            );
            return "";
        }

        const html: string = item.raw.data.note ?? "";
        if (!html.trim()) return "";

        const vaultConfig = await this.parentHost.getVaultConfig();
        let md = await this.convertService.html2md(html, {
            annotationImageFolder:
                this.settings.annotationImageFolder.replace(/\/$/, "") ||
                undefined,
            strictLineBreaks: vaultConfig.strictLineBreaks,
            // Always on: display-only anchors, unconditionally stripped
            // on save — there is no risk for a setting to guard.
            linkCitationSpans: true,
        });

        // Display native zotero:// links as ZotFlow links. Markdown-side on
        // purpose: single-param zotero links pass the markdown serializer
        // unescaped, and the multi-param zotflow links we emit here never
        // go through a serializer again (see note-links.ts).
        if (this.settings.convertNoteLinks) {
            md = await zoteroToZotflowLinks(md, createDbNoteLinkResolver());
        }
        return md;
    }

    /**
     * Create a new empty child note under a parent item and persist it to IDB
     * with `syncStatus: "created"` so the next sync pushes it to Zotero.
     *
     * Returns the generated key for opening the note in the preview view.
     */
    async createChildNote(
        libraryID: number,
        parentKey: string,
    ): Promise<string> {
        const parentItem = await db.items.get([libraryID, parentKey]);
        if (!parentItem) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "ItemNoteService",
                `Parent item ${parentKey} not found in library ${libraryID}`,
            );
        }

        // Zotero only allows child notes under regular items. Guarding here
        // covers every entry point (tree view, command palette, file menu).
        if (
            ["attachment", "note", "annotation"].includes(parentItem.itemType)
        ) {
            throw new ZotFlowError(
                ZotFlowErrorCode.UNKNOWN,
                "ItemNoteService",
                `Cannot create a child note under a ${parentItem.itemType} item`,
            );
        }

        const key = await this.createNote(
            libraryID,
            parentKey,
            "",
            parentItem.raw.library,
        );

        this.parentHost.log(
            "info",
            `Created child note ${key} under ${parentKey}`,
            "ItemNoteService",
        );

        // A new node: the tree is rebuilt.
        this.parentHost.emit("treeChanged");
        this.parentHost.emit(
            "noteChangedByNoteView",
            libraryID,
            key,
            parentKey,
        );

        return key;
    }

    /** Stores a new note (`parentKey` "" for a standalone note) and returns its key. */
    private async createNote(
        libraryID: number,
        parentKey: string,
        html: string,
        library: IDBZoteroItem<NoteData>["raw"]["library"],
    ): Promise<string> {
        const key = this.generateTempKey();
        const now = new Date().toISOString().split(".")[0] + "Z";
        const newItem: IDBZoteroItem<NoteData> = newLocalItem(
            {
                key,
                version: 0,
                library,
                links: {},
                meta: { numChildren: 0 },
                data: {
                    key,
                    itemType: "note",
                    ...(parentKey ? { parentItem: parentKey } : {}),
                    note: html,
                    relations: {},
                    dateAdded: now,
                    dateModified: now,
                    tags: [],
                    deleted: false,
                    version: 0,
                } as unknown as NoteData,
            },
            libraryID,
            "push",
        );
        await createLocalItems(libraryID, [
            newItem,
        ]);
        return key;
    }

    /** Markdown from the editor → the note HTML stored in Zotero. */
    private async noteHtml(content: string): Promise<string> {
        const vaultConfig = await this.parentHost.getVaultConfig();
        let html = await this.convertService.md2html(content, {
            strictLineBreaks: vaultConfig.strictLineBreaks,
        });
        // Canonical storage keeps native zotero:// links so the note
        // navigates with Zotero's reader after sync.
        if (this.settings.convertNoteLinks) {
            html = await zotflowToZoteroLinks(html, createDbNoteLinkResolver());
        }
        return html;
    }

    /**
     * Saves text whose note is gone (see `NoteSaveResult`) as a new note:
     * under `parentKey` if that item still exists, otherwise standalone.
     *
     * @returns the new note's key.
     */
    async saveAsNewNote(
        libraryID: number,
        parentKey: string,
        content: string,
    ): Promise<string> {
        const parent = parentKey
            ? await db.items.get([libraryID, parentKey])
            : undefined;
        const usable =
            parent &&
            !["attachment", "note", "annotation"].includes(parent.itemType);
        const library =
            parent?.raw.library ??
            (await this.anyLibraryStub(libraryID));
        const key = await this.createNote(
            libraryID,
            usable ? parentKey : "",
            await this.noteHtml(content),
            library,
        );
        this.parentHost.log(
            "info",
            `Saved the text of a deleted note as ${key}`,
            "ItemNoteService",
        );
        this.parentHost.emit("treeChanged");
        this.parentHost.emit(
            "noteChangedByNoteView",
            libraryID,
            key,
            usable ? parentKey : "",
        );
        // The parent's source note shows the new note in place of the gone
        // one; an editor open on it then edits the new note.
        if (usable) {
            this.sourceNoteService
                .triggerUpdate(
                    libraryID,
                    parentKey,
                    { forceUpdateContent: true, forceUpdateImages: false },
                    false,
                )
                .catch((e) =>
                    this.parentHost.log(
                        "error",
                        "Failed to update the source note after saving a new note",
                        "ItemNoteService",
                        e,
                    ),
                );
        }
        return key;
    }

    /** The `library` block of an item payload, for a note with no parent to copy it from. */
    private async anyLibraryStub(
        libraryID: number,
    ): Promise<IDBZoteroItem<NoteData>["raw"]["library"]> {
        const lib = await db.libraries.get(libraryID);
        return {
            type: lib?.type ?? "user",
            id: libraryID,
            name: lib?.name ?? "",
            links: {},
        };
    }

    /**
     * Update the content of a Zotero child note item in IDB.
     * Marks the item dirty (see `applyLocalEdit`) so the next sync pushes it to Zotero.
     *
     * @param origin — `"editor"` when called from the source-note editable
     *   region (skips re-rendering the source note to avoid a circular
     *   overwrite); `"note-view"` when called from the standalone
     *   NotePreviewView (triggers a debounced source-note re-render).
     */
    async updateNoteContent(
        libraryID: number,
        noteKey: string,
        content: string,
        origin: "editor" | "note-view" = "note-view",
        parentKeyHint = "",
    ): Promise<NoteSaveResult> {
        const item = await db.items.get([libraryID, noteKey]);

        if (!item || item.itemType !== "note") {
            this.parentHost.log(
                "warn",
                `updateNoteContent: note ${noteKey} is gone; the text was not saved to it`,
                "ItemNoteService",
            );
            return this.gone(libraryID, parentKeyHint);
        }

        const noteHtmlContent = await this.noteHtml(content);

        // Nothing changed (an edit typed and undone, a flush of text already
        // written): no write, so the note is not marked for upload again.
        const current = await db.items.get([libraryID, noteKey]);
        if (current?.itemType === "note" && current.raw.data.note === noteHtmlContent) {
            return { status: "saved" };
        }

        // The conversion above is async, so the row is re-read inside the
        // write transaction rather than written back from `item`.
        const updated = await mutateItem(libraryID, noteKey, "note", (data) => {
            data.note = noteHtmlContent;
        });
        if (!updated) {
            this.parentHost.log(
                "warn",
                `updateNoteContent: note ${noteKey} disappeared during the edit`,
                "ItemNoteService",
            );
            return this.gone(libraryID, item.parentItem);
        }

        this.parentHost.log(
            "debug",
            `Updated note content for ${noteKey}`,
            "ItemNoteService",
        );

        // The tree shows the note's first line: patch that one node.
        this.parentHost.emit("treeChanged", { libraryID, keys: [noteKey] });
        // Notify main thread so the note views can react
        if (origin === "editor") {
            this.parentHost.emit(
                "noteChangedByEditor",
                libraryID,
                noteKey,
                item.parentItem,
            );
        } else {
            this.parentHost.emit(
                "noteChangedByNoteView",
                libraryID,
                noteKey,
                item.parentItem,
            );
        }

        // Re-render the parent source note only when the edit comes from the
        // standalone NotePreviewView.  When the edit originates from the
        // source-note editable region itself, re-rendering would overwrite
        // what the user just typed (circular).
        if (origin === "note-view" && item.parentItem) {
            this.sourceNoteService
                .triggerUpdate(
                    libraryID,
                    item.parentItem,
                    { forceUpdateContent: true, forceUpdateImages: false },
                    true,
                )
                .catch((e) =>
                    this.parentHost.log(
                        "error",
                        `Failed to trigger source note update after note edit`,
                        "ItemNoteService",
                        e,
                    ),
                );
        }
        return { status: "saved" };
    }

    private async gone(
        libraryID: number,
        parentKey: string,
    ): Promise<NoteSaveResult> {
        const parentExists =
            !!parentKey && !!(await db.items.get([libraryID, parentKey]));
        return { status: "gone", parentKey, parentExists };
    }

    /** Generate a temporary 8-character alphanumeric key for locally-created items. */
    private generateTempKey(): string {
        let len = 8;
        let allowedKeyChars = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

        let randomstring = "";
        for (let i = 0; i < len; i++) {
            let rnum = Math.floor(Math.random() * allowedKeyChars.length);
            randomstring += allowedKeyChars.substring(rnum, rnum + 1);
        }
        return randomstring;
    }

    /**
     * Delete or soft-trash a child note.
     */
    async deleteNote(libraryID: number, noteKey: string): Promise<void> {
        const item = await db.items.get([libraryID, noteKey]);
        if (!item || item.itemType !== "note") return;

        // Moves the note to Zotero's trash (`trashed` follows `deleted`); a
        // note Zotero never received is simply removed.
        const { removed } = await deleteLocalItems(libraryID, [noteKey]);

        this.parentHost.log(
            "info",
            `Deleted note ${noteKey} (${removed.length > 0 ? "hard" : "soft"})`,
            "ItemNoteService",
        );
    }
}
