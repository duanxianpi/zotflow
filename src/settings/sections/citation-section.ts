import type ZotFlow from "main";
import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

/** Declarative citation insertion settings. */
export class CitationSection {
    constructor(private readonly plugin: ZotFlow) {}

    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "group",
                heading: "Citation",
                cls: "zotflow-settings-citation",
                items: [
                    {
                        name: "Preview Pandoc Citations",
                        desc: "Display [@citekey] citations in Live Preview and Reading View using the default CSL style. Focus a citation for reference details and source note/PDF links. Select it in the editor to edit the original syntax. Requires synced CSL metadata and an installed style.",
                        control: { type: "toggle", key: "renderPandocCitations" },
                    },
                    {
                        name: "Default Citation Format",
                        desc: "Format used when inserting a citation with Enter (no modifier key).",
                        control: {
                            type: "dropdown",
                            key: "defaultCitationFormat",
                            options: {
                                pandoc: "Pandoc",
                                footnote: "Footnote",
                                wikilink: "Wikilink",
                            },
                        },
                    },
                    {
                        name: "Trigger Character",
                        desc: "Character sequence that triggers the citation suggest popup in the editor.",
                        render: (setting) => {
                            setting.addText((text) => {
                                text.setPlaceholder("e.g. @@")
                                    .setValue(
                                        this.plugin.settings.citationTrigger,
                                    )
                                    .onChange(async (value) => {
                                        this.plugin.settings.citationTrigger =
                                            value || "@@";
                                        await this.plugin.saveSettings();
                                    });
                                text.inputEl.size = 10;
                            });
                        },
                    },
                    {
                        name: "Pandoc Template",
                        desc: "LiquidJS template for pandoc citation text. Root variables are item, notePath, and annotations; Zotero metadata such as title, creators, citationKey, and year is under item. Leave empty to use the built-in template.",
                        control: {
                            type: "textarea",
                            key: "citationPandocTemplate",
                            placeholder:
                                "e.g. [@{{ item.citationKey | default: item.key }}]",
                            rows: 5,
                        },
                    },
                    {
                        name: "Footnote Reference Template",
                        desc: "LiquidJS template for the inline footnote reference. Root variables are item, notePath, and annotations. Leave empty to use the built-in template.",
                        control: {
                            type: "textarea",
                            key: "citationFootnoteRefTemplate",
                            placeholder:
                                "e.g. [^{{ item.citationKey | default: item.key }}]",
                            rows: 5,
                        },
                    },
                    {
                        name: "Footnote Definition Template",
                        desc: "LiquidJS template for the footnote definition(s) appended at the end of the note. Root variables are item, notePath, and annotations. Include the [^marker]: prefix yourself so each definition aligns with its reference — loop over annotations to emit one definition per annotation. A template with no [^marker]: prefix reuses the reference's marker automatically. Leave empty to use the built-in template.",
                        control: {
                            type: "textarea",
                            key: "citationFootnoteTemplate",
                            placeholder:
                                'e.g. [^{{ item.citationKey | default: item.key }}]: {{ item.creators[0].name | default: "Unknown Author" }}, *{{ item.title }}* ({{ item.year }}).',
                            rows: 5,
                        },
                    },
                    {
                        name: "Wikilink Template",
                        desc: "LiquidJS template for wikilink citation text. Root variables are item, notePath, and annotations; Zotero metadata is under item. Leave empty to use the built-in template.",
                        control: {
                            type: "textarea",
                            key: "citationWikilinkTemplate",
                            placeholder:
                                "e.g. [[{{ notePath }}|{{ item.title }}]]",
                            rows: 5,
                        },
                    },
                    {
                        name: "Auto-copy New Annotation",
                        desc: "When you create an annotation in the reader, automatically copy it to the clipboard. Embed inserts ![[note#^id]]; Text copies the highlighted text; Citation uses the default citation format above.",
                        control: {
                            type: "dropdown",
                            key: "autoCopyAnnotation",
                            options: {
                                off: "Off",
                                embed: "Embed",
                                text: "Text",
                                citation: "Citation",
                            },
                        },
                    },
                ],
            },
        ];
    }
}
