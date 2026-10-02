import { ReaderSection } from "settings/sections/reader-section";
import { SourceNotesSection } from "settings/sections/source-notes-section";

import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

/** Declarative entry point for source-note, reader and item display settings. */
export class GeneralSection {
    constructor(private readonly plugin: ZotFlow) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "page",
                name: "Source Notes",
                desc: "Templates, paths, editable regions, and annotation assets for library and local source notes.",
                items: new SourceNotesSection().getDefinitions(),
            },
            {
                type: "page",
                name: "Reader",
                desc: "Reader integration, annotation tools, fonts, and color themes.",
                items: new ReaderSection(this.plugin).getDefinitions(),
            },
            {
                type: "group",
                heading: "Item Display",
                items: [
                    {
                        name: "Display Title Template",
                        desc: "LiquidJS template for how Zotero items and attachments are titled in the library tree and in item search, using the same item variables as citation templates; attachments also have item.filename, item.contentType and item.linkMode (check item.itemType == \"attachment\"). Notes and annotations keep their own names. Sorting by title follows it. Leave empty to show the Zotero title.",
                        control: {
                            type: "text",
                            key: "itemDisplayTitleTemplate",
                            placeholder:
                                "e.g. {{ item.creatorSummary }} ({{ item.year }}) {{ item.title }}",
                        },
                    },
                ],
            },
        ];
    }
}
