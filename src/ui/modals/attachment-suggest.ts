import { App, SuggestModal, setIcon } from "obsidian";
import { getAttachmentFileIcon } from "ui/icons";
import { openAttachment } from "utils/viewer";

import type { AttachmentData } from "types/zotero-item";
import type { IDBZoteroItem, AnyIDBZoteroItem } from "types/db-schema";
import type { ZoteroSearchModal } from "./suggest";

interface ActionOption {
    label: string;
    description: string;
    item: IDBZoteroItem<AttachmentData>;
}

export class AttachmentSelectModal extends SuggestModal<ActionOption> {
    private didChoose: boolean = false;

    constructor(
        app: App,
        private parentItem: AnyIDBZoteroItem,
        private attachments: IDBZoteroItem<AttachmentData>[],
        private parentModal?: ZoteroSearchModal,
    ) {
        super(app);
        this.setPlaceholder("Select file to open...");
    }

    // When modal opens, hide parent modal
    onOpen() {
        super.onOpen();
        this.parentModal?.containerEl.hide();
    }

    // When modal closes, show parent modal
    onClose() {
        super.onClose();

        if (!this.parentModal) return;

        if (this.didChoose) {
            this.parentModal.close();
        } else {
            if (this.parentModal.containerEl) {
                this.parentModal.containerEl.show();
            }
        }
    }

    // Get suggestions based on query
    getSuggestions(query: string): ActionOption[] {
        const options: ActionOption[] = [];

        this.attachments.forEach((att) => {
            if (att.itemType !== "attachment") return;

            const data = att.raw.data;

            let desc = "";
            switch (data.contentType) {
                case "application/pdf":
                    desc = data.filename || data.path || "PDF";
                    break;
                case "application/epub+zip":
                    desc = data.filename || data.path || "EPUB";
                    break;
                case "text/html":
                    desc = data.url || data.filename || "Snapshot";
                    break;
                default:
                    desc = data.filename || data.path || "Attachment";
                    break;
            }

            options.push({
                label: data.title || data.filename || "Untitled Attachment",
                description: desc,
                item: att,
            });
        });

        if (!query) return options;
        const lowerQ = query.toLowerCase();
        return options.filter((o) => {
            return (
                o.label.toLowerCase().includes(lowerQ) ||
                o.description.toLowerCase().includes(lowerQ)
            );
        });
    }

    renderSuggestion(option: ActionOption, el: HTMLElement) {
        el.addClass("zotflow-search-item");

        // Icon
        // const iconEl = el.createDiv({ cls: "zotflow-item-icon" });
        // const iconName = getAttachmentFileIcon(
        //     option.item.raw.data.contentType,
        // );
        // setIcon(iconEl, iconName);

        // Text
        const contentEl = el.createDiv({ cls: "zotflow-item-content" });
        const titleRow = contentEl.createDiv({ cls: "zotflow-row-top" });
        titleRow.createDiv({
            cls: "zotflow-title",
            text: option.label,
        });

        if (option.description) {
            const bottomRow = contentEl.createDiv({
                cls: "zotflow-row-bottom",
            });
            bottomRow.createDiv({
                cls: "zotflow-meta",
                text: option.description,
            });
        }
    }

    selectSuggestion(option: ActionOption, evt: MouseEvent | KeyboardEvent) {
        this.didChoose = true;

        super.selectSuggestion(option, evt);
    }

    async onChooseSuggestion(
        option: ActionOption,
        evt: MouseEvent | KeyboardEvent,
    ) {
        await openAttachment(option.item.libraryID, option.item.key, this.app);
    }
}
