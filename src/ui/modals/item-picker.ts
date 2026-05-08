import type { App } from "obsidian";
import type { AnyIDBZoteroItem } from "types/db-schema";
import { BaseItemSearchModal } from "./suggest";
import type { SuggestionItemFilter } from "./zotero-item-suggest";

/** Item picker modal that calls a callback when a Zotero item is selected. */
export class ItemPickerModal extends BaseItemSearchModal {
    private onPick: (item: AnyIDBZoteroItem) => void;

    constructor(
        app: App,
        onPick: (item: AnyIDBZoteroItem) => void,
        itemFilter?: SuggestionItemFilter,
    ) {
        super(app, "Pick a Zotero item...", itemFilter);
        this.onPick = onPick;
    }

    protected handleItemSelected(item: AnyIDBZoteroItem): void {
        this.onPick(item);
        this.close();
    }
}
