import { App, renderResults, SuggestModal } from "obsidian";
import { workerBridge } from "bridge";
import type { AnyIDBZoteroItem, IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import { openAttachment, openItemNote } from "utils/viewer";
import type { ZotFlowSettings } from "settings/types";
import { services } from "services/services";
import { AttachmentSelectModal } from "./attachment-suggest";
import { ZoteroItemSuggest } from "./zotero-item-suggest";
import { getValueSuggestions } from "ui/search/autocomplete-data";
import { analyzeInput, applyValueCompletion } from "utils/search-query";

import type {
    SuggestionItem,
    SuggestionItemFilter,
} from "./zotero-item-suggest";
import { fireAndForgetIn } from "utils/fire-and-forget";
import { LatestOnly } from "utils/latest-only";

const ff = fireAndForgetIn("SuggestModalBase");

/**
 * Abstract base class for Zotero item search modals.
 * Delegates query and rendering to `ZoteroItemSuggest`.
 * Subclasses implement `handleItemSelected()` to define the action.
 */
export abstract class BaseItemSearchModal extends SuggestModal<SuggestionItem> {
    protected readonly suggest: ZoteroItemSuggest;
    private readonly latest = new LatestOnly();

    constructor(
        app: App,
        placeholder = "Search Zotero Library...",
        itemFilter?: SuggestionItemFilter,
    ) {
        super(app);
        this.suggest = new ZoteroItemSuggest(itemFilter);
        this.setPlaceholder(placeholder);
        this.modalEl.addClass("zotflow-search-modal");
        this.limit = 20;
        this.setInstructions([
            { command: "collection:", purpose: "in a collection" },
            { command: "tag:", purpose: "with a tag" },
            { command: "type:", purpose: "item type" },
            { command: "creator:", purpose: "by author" },
            { command: "-tag:", purpose: "exclude" },
        ]);
    }

    protected abstract handleItemSelected(
        item: AnyIDBZoteroItem,
        evt: MouseEvent | KeyboardEvent,
    ): void;

    getSuggestions(query: string): Promise<SuggestionItem[]> {
        return this.latest.run(this.lookup(query));
    }

    private async lookup(query: string): Promise<SuggestionItem[]> {
        // When the active token is `field:partial`, show value completions.
        const analysis = analyzeInput(query);
        if (analysis.mode === "value") {
            const values = await getValueSuggestions(
                analysis.field,
                analysis.partial,
            );
            if (values.length > 0) {
                const completions = values.map(
                    (suggestion): SuggestionItem => ({
                        isValueCompletion: true,
                        field: analysis.field,
                        value: suggestion.value,
                        match: suggestion.match,
                    }),
                );
                this.suggest.setGroupLabel(completions[0]!, analysis.field);
                return completions;
            }
        }
        return this.suggest.getSuggestions(query, 50);
    }

    renderSuggestion(item: SuggestionItem, el: HTMLElement) {
        if ("isValueCompletion" in item) {
            this.suggest.renderGroupLabel(item, el);
            el.addClass("zotflow-search-value");
            if (item.match) {
                renderResults(el, item.value, item.match);
            } else {
                el.setText(item.value);
            }
            return;
        }
        this.suggest.renderSuggestion(item, el, this.inputEl.value);
    }

    onChooseSuggestion(
        item: SuggestionItem,
        evt: MouseEvent | KeyboardEvent,
    ): void {}

    selectSuggestion(
        item: SuggestionItem,
        evt: MouseEvent | KeyboardEvent,
    ): void {
        if ("isEmpty" in item) return;

        // Value-completion rows rewrite the input and re-query in place.
        if ("isValueCompletion" in item) {
            this.inputEl.value = applyValueCompletion(
                this.inputEl.value,
                item.field,
                item.value,
            );
            this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
            this.inputEl.focus();
            return;
        }

        const zItem = item;
        this.handleItemSelected(zItem, evt);
    }
}

export class ZoteroSearchModal extends BaseItemSearchModal {
    private settings: ZotFlowSettings;

    constructor(
        app: App,
        settings: ZotFlowSettings,
        itemFilter?: SuggestionItemFilter,
    ) {
        super(app, "Search Zotero Library...", itemFilter);
        this.settings = settings;
    }

    protected handleItemSelected(
        item: AnyIDBZoteroItem,
        evt: MouseEvent | KeyboardEvent,
    ): void {
        ff(this.handleSelection(item, evt), "Failed to open the selection");
    }

    private async handleSelection(
        item: AnyIDBZoteroItem,
        evt: MouseEvent | KeyboardEvent,
    ) {
        if (item.itemType === "attachment") {
            ff(
                openAttachment(item.libraryID, item.key, this.app),
                "Failed to open the attachment",
            );
            this.close();
            return;
        }

        // A note has no attachments to open: open the note itself.
        if (item.itemType === "note") {
            ff(
                openItemNote(item.libraryID, item.key, this.app),
                "Failed to open the note",
            );
            this.close();
            return;
        }

        const attachments = await workerBridge.dbHelper.getAttachments(
            item.libraryID,
            item.key,
        );

        if (attachments.length === 0) {
            services.notificationService.notify(
                "warning",
                `No attachments found for item: ${item.title}`,
            );
        } else if (attachments.length === 1) {
            ff(
                openAttachment(
                    attachments[0]!.libraryID,
                    attachments[0]!.key,
                    this.app,
                ),
                "Failed to open the attachment",
            );
            this.close();
        } else {
            new AttachmentSelectModal(
                this.app,
                item,
                attachments as IDBZoteroItem<AttachmentData>[],
                this,
            ).open();
        }
    }
}
