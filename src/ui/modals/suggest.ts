import { App, SuggestModal } from "obsidian";
import { workerBridge } from "bridge";
import type { AnyIDBZoteroItem, IDBZoteroItem } from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import { openAttachment } from "utils/viewer";
import type { ZotFlowSettings } from "settings/types";
import { services } from "services/services";
import { AttachmentSelectModal } from "./attachment-suggest";
import { ZoteroItemSuggest } from "./zotero-item-suggest";

import type {
    SuggestionItem,
    SuggestionItemFilter,
} from "./zotero-item-suggest";

/**
 * Abstract base class for Zotero item search modals.
 * Delegates query and rendering to `ZoteroItemSuggest`.
 * Subclasses implement `handleItemSelected()` to define the action.
 */
export abstract class BaseItemSearchModal extends SuggestModal<SuggestionItem> {
    protected readonly suggest: ZoteroItemSuggest;

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
    }

    protected abstract handleItemSelected(
        item: AnyIDBZoteroItem,
        evt: MouseEvent | KeyboardEvent,
    ): void;

    async getSuggestions(query: string): Promise<SuggestionItem[]> {
        return this.suggest.getSuggestions(query, 50);
    }

    renderSuggestion(item: SuggestionItem, el: HTMLElement) {
        this.suggest.renderSuggestion(item, el, this.inputEl.value);
    }

    async onChooseSuggestion(
        item: SuggestionItem,
        evt: MouseEvent | KeyboardEvent,
    ) {}

    selectSuggestion(
        item: SuggestionItem,
        evt: MouseEvent | KeyboardEvent,
    ): void {
        if ("isHeader" in item) return;
        if ("isEmpty" in item) return;

        const zItem = item as AnyIDBZoteroItem;
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
        this.handleSelection(item, evt);
    }

    private async handleSelection(
        item: AnyIDBZoteroItem,
        evt: MouseEvent | KeyboardEvent,
    ) {
        if (item.itemType === "attachment") {
            openAttachment(item.libraryID, item.key, this.app);
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
            openAttachment(
                attachments[0]!.libraryID,
                attachments[0]!.key,
                this.app,
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
