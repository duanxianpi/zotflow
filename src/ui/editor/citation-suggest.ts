import {
    Editor,
    EditorSuggest,
    MarkdownView,
    TFile,
    type EditorPosition,
    type EditorSuggestContext,
    type EditorSuggestTriggerInfo,
} from "obsidian";
import { services } from "services/services";
import { workerBridge } from "bridge";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { CitationFormat } from "settings/types";
import {
    ZoteroItemSuggest,
    type SuggestionItem,
} from "ui/modals/zotero-item-suggest";
import { insertCitationResult } from "ui/editor/citation-helper";

const DEFAULT_TRIGGER = "@@";

/**
 * Inline EditorSuggest for inserting Zotero citations.
 * Auto-triggers when the user types the configured trigger (default `@@`) in the editor.
 * Also triggered via the "Insert Citation" command (Alt+C).
 */
export class CitationSuggest extends EditorSuggest<SuggestionItem> {
    private manualTriggerStart: EditorPosition | null = null;
    private readonly suggest = new ZoteroItemSuggest();

    private resolveInsertionAnchor(
        editor: Editor,
        preferredPos: EditorPosition,
        baselineDoc: string,
    ): EditorPosition {
        return editor.getValue() === baselineDoc
            ? preferredPos
            : editor.getCursor();
    }

    private get triggerPrefix(): string {
        return services.settings.citationTrigger || DEFAULT_TRIGGER;
    }

    constructor() {
        super(services.app);
        this.limit = 20;

        this.setInstructions([
            { command: "↵", purpose: "Insert default format" },
            { command: "⇧ ↵", purpose: "Pandoc [@citekey]" },
            { command: "⌘/Ctrl ↵", purpose: "Footnote [^citekey]" },
            { command: "⌥/Alt ↵", purpose: "Wikilink [[@citekey]]" },
            { command: "⌘/Ctrl ⇧ ↵", purpose: "Citation key @citekey" },
        ]);

        this.scope.register(["Mod", "Shift"], "Enter", (evt) => {
            this.pickWithFormat(evt, "citekey");
            return false;
        });
        this.scope.register(["Shift"], "Enter", (evt) => {
            this.pickWithFormat(evt, "pandoc");
            return false;
        });
        this.scope.register(["Mod"], "Enter", (evt) => {
            this.pickWithFormat(evt, "footnote");
            return false;
        });
        this.scope.register(["Alt"], "Enter", (evt) => {
            this.pickWithFormat(evt, "wikilink");
            return false;
        });
    }

    /** Called from the "Insert Citation" command to open the suggest popup. */
    triggerManually(): void {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return;

        const cursor = view.editor.getCursor();
        const t = this.triggerPrefix;
        view.editor.replaceRange(t, cursor);
        view.editor.setCursor({ line: cursor.line, ch: cursor.ch + t.length });
        this.manualTriggerStart = cursor;
        // Force Obsidian to evaluate onTrigger() immediately
        (this as any).trigger(view.editor, activeFile, true);
    }

    onTrigger(
        cursor: EditorPosition,
        editor: Editor,
        _file: TFile | null,
    ): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const textBefore = line.substring(0, cursor.ch);

        // Find the last occurrence of the trigger before the cursor
        const t = this.triggerPrefix;
        const triggerIdx = textBefore.lastIndexOf(t);
        if (triggerIdx === -1) return null;

        const textAfterTrigger = textBefore.substring(triggerIdx + t.length);

        const query = textAfterTrigger;
        return {
            start: { line: cursor.line, ch: triggerIdx + t.length },
            end: cursor,
            query,
        };
    }

    async getSuggestions(
        context: EditorSuggestContext,
    ): Promise<SuggestionItem[]> {
        return this.suggest.getSuggestions(context.query, 20);
    }

    renderSuggestion(item: SuggestionItem, el: HTMLElement): void {
        this.suggest.renderSuggestion(item, el, this.context?.query ?? "");
    }

    selectSuggestion(
        suggestion: SuggestionItem,
        evt: MouseEvent | KeyboardEvent,
    ): void {
        if (!this.context) return;
        if ("isHeader" in suggestion) return;
        if ("isEmpty" in suggestion) return;

        let format: CitationFormat = services.settings.defaultCitationFormat;
        if (evt instanceof KeyboardEvent) {
            if ((evt.ctrlKey || evt.metaKey) && evt.shiftKey)
                format = "citekey";
            else if (evt.shiftKey) format = "pandoc";
            else if (evt.ctrlKey || evt.metaKey) format = "footnote";
            else if (evt.altKey) format = "wikilink";
        }

        this.insertCitation(suggestion as AnyIDBZoteroItem, format);
    }

    close(): void {
        // If manually triggered and dismissed without selection, clean up the inserted trigger text
        if (this.manualTriggerStart && this.context) {
            const { end, editor } = this.context;
            editor.replaceRange("", this.manualTriggerStart, end);
        }
        this.manualTriggerStart = null;
        super.close();
    }

    // --- Helpers ---

    private pickWithFormat(evt: KeyboardEvent, format: CitationFormat): void {
        // @ts-expect-error
        // Undocumented: PopoverSuggest.suggestions holds the Suggest instance with selectedItem
        const suggestions = this.suggestions;
        const selectedIndex: number | undefined = suggestions?.selectedItem;
        const values: SuggestionItem[] | undefined = suggestions?.values;

        if (
            selectedIndex == null ||
            !values ||
            selectedIndex < 0 ||
            selectedIndex >= values.length
        ) {
            return;
        }

        const suggestion = values[selectedIndex];
        if (
            !suggestion ||
            !this.context ||
            "isHeader" in suggestion ||
            "isEmpty" in suggestion
        ) {
            return;
        }

        this.insertCitation(suggestion as AnyIDBZoteroItem, format);
    }

    /** Dispatch a citation insertion for the given item and format. */
    private insertCitation(
        item: AnyIDBZoteroItem,
        format: CitationFormat,
    ): void {
        // Update last accessed timestamp (fire & forget)
        workerBridge.dbHelper
            .updateLastAccessed(item.libraryID, item.key)
            .catch(() => {});

        if (!this.context) return;

        const { start, end, editor } = this.context;

        // Compute replacement range before closing (start.ch points after the trigger)
        const replaceStart: EditorPosition = {
            line: start.line,
            ch: start.ch - this.triggerPrefix.length,
        };

        // Dismiss the popup
        this.manualTriggerStart = null;
        this.close();

        // Clear the trigger text immediately, then async-resolve the citation
        editor.replaceRange("", replaceStart, end);
        const baselineDoc = editor.getValue();

        services.citationService
            .resolve({ libraryID: item.libraryID, key: item.key }, format)
            .then((result) => {
                if (result) {
                    const insertPos = this.resolveInsertionAnchor(
                        editor,
                        replaceStart,
                        baselineDoc,
                    );
                    insertCitationResult(editor, insertPos, result);
                }
            })
            .catch((error) => {
                services.logService.error(
                    "Failed to resolve citation",
                    "CitationSuggest",
                    error,
                );
                services.notificationService.notify(
                    "error",
                    "Failed to insert citation.",
                );
            });
    }
}
