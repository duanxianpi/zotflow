import { App, MarkdownView, TFile } from "obsidian";
import { ZOTERO_READER_VIEW_TYPE, ZoteroReaderView } from "../ui/reader/view";
import { NOTE_EDITOR_VIEW_TYPE, NoteEditorView } from "../ui/note-editor/view";
import { workerBridge } from "../bridge";

/**
 * Open an attachment in the default application.
 * @param libraryID The library ID of the attachment.
 * @param key The item key of the attachment.
 * @param app The Obsidian App instance.
 * @param navigationInfo Optional navigation info.
 */
export async function openAttachment(
    libraryID: number,
    key: string,
    app: App,
    navigationInfo?: any,
) {
    // Update last accessed timestamp
    workerBridge.dbHelper.updateLastAccessed(libraryID, key).catch(() => {
        // Silent catch: timestamp update shouldn't block opening
    });

    let activeLeaf;
    const leaves = app.workspace.getLeavesOfType(ZOTERO_READER_VIEW_TYPE);

    for (const leaf of leaves) {
        const view = leaf.view as ZoteroReaderView;
        if (
            view &&
            view.getState().libraryID === libraryID &&
            view.getState().itemKey === key
        ) {
            activeLeaf = leaf;
        }
    }

    if (activeLeaf) {
        app.workspace.setActiveLeaf(activeLeaf);
    } else {
        activeLeaf = app.workspace.getLeaf("tab");

        await activeLeaf.setViewState({
            type: ZOTERO_READER_VIEW_TYPE,
            active: true,
            state: {
                libraryID: libraryID,
                itemKey: key,
            },
        });

        app.workspace.revealLeaf(activeLeaf);
    }

    if (navigationInfo) {
        (activeLeaf.view as ZoteroReaderView).readerNavigate(
            JSON.parse(navigationInfo),
        );
    }
}

/**
 * Open a markdown source note. Reuses an existing leaf already showing the
 * file; otherwise opens it in a new tab.
 */
export async function openSourceNote(file: TFile, app: App): Promise<void> {
    const leaves = app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === file.path) {
            app.workspace.setActiveLeaf(leaf);
            app.workspace.revealLeaf(leaf);
            return;
        }
    }
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    app.workspace.revealLeaf(leaf);
}

/**
 * Open a Zotero child note in the note editor view.
 * Reuses an existing leaf if one is already showing the same note.
 */
export async function openItemNote(
    libraryID: number,
    noteKey: string,
    app: App,
) {
    let activeLeaf;
    const leaves = app.workspace.getLeavesOfType(NOTE_EDITOR_VIEW_TYPE);

    for (const leaf of leaves) {
        const view = leaf.view as NoteEditorView;
        if (view) {
            const state = view.getState();
            if (state.libraryID === libraryID && state.noteKey === noteKey) {
                activeLeaf = leaf;
            }
        }
    }

    if (activeLeaf) {
        app.workspace.setActiveLeaf(activeLeaf);
    } else {
        activeLeaf = app.workspace.getLeaf("tab");
        await activeLeaf.setViewState({
            type: NOTE_EDITOR_VIEW_TYPE,
            active: true,
            state: { libraryID, noteKey },
        });
        app.workspace.revealLeaf(activeLeaf);
    }
}
