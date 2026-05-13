import { SettingGroup } from "obsidian";

import type ZotFlow from "main";
import type { AutoCopyAnnotationMode, CitationFormat } from "settings/types";

/** Settings section for citation insertion format. */
export class CitationSection {
    constructor(
        private plugin: ZotFlow,
        private refreshUI: () => void,
    ) {}

    render(containerEl: HTMLElement) {
        const citationGroup = new SettingGroup(containerEl);
        citationGroup.setHeading("Citation");

        citationGroup.addSetting((setting) => {
            setting
                .setName("Default Citation Format")
                .setDesc(
                    "Format used when inserting a citation with Enter (no modifier key).",
                )
                .addDropdown((dropdown) => {
                    dropdown
                        .addOption("pandoc", "Pandoc")
                        .addOption("footnote", "Footnote")
                        .addOption("wikilink", "Wikilink")
                        .setValue(this.plugin.settings.defaultCitationFormat)
                        .onChange(async (value) => {
                            this.plugin.settings.defaultCitationFormat =
                                value as CitationFormat;
                            await this.plugin.saveSettings();
                        });
                });
        });
        citationGroup.addSetting((setting) => {
            setting
                .setName("Trigger Character")
                .setDesc(
                    "Character sequence that triggers the citation suggest popup in the editor.",
                )
                .addText((text) => {
                    text.setPlaceholder("e.g. @@")
                        .setValue(this.plugin.settings.citationTrigger)
                        .onChange(async (value) => {
                            this.plugin.settings.citationTrigger =
                                value || "@@";
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.size = 10;
                });
        });

        citationGroup.addSetting((setting) => {
            setting
                .setName("Pandoc Template")
                .setDesc(
                    "LiquidJS template for pandoc citation text. " +
                        "Available variables: title, creators, citationKey, year, notePath, and all item metadata fields. " +
                        "Leave empty for default [@citekey].",
                )
                .addTextArea((ta) => {
                    ta.setPlaceholder("e.g. [@{{item.citationKey}}]")
                        .setValue(this.plugin.settings.citationPandocTemplate)
                        .onChange(async (value) => {
                            this.plugin.settings.citationPandocTemplate = value;
                            await this.plugin.saveSettings();
                        });
                    ta.inputEl.rows = 5;
                    ta.inputEl.cols = 60;
                });
        });

        citationGroup.addSetting((setting) => {
            setting
                .setName("Footnote Reference Template")
                .setDesc(
                    "LiquidJS template for the inline footnote reference (e.g. [^item.citationKey]). " +
                        "Annotation data is available here for page-specific citations. " +
                        "Leave empty for default [^item.citationKey].",
                )
                .addTextArea((ta) => {
                    ta.setPlaceholder("e.g. [^{{item.citationKey}}]")
                        .setValue(
                            this.plugin.settings.citationFootnoteRefTemplate,
                        )
                        .onChange(async (value) => {
                            this.plugin.settings.citationFootnoteRefTemplate =
                                value;
                            await this.plugin.saveSettings();
                        });
                    ta.inputEl.rows = 5;
                    ta.inputEl.cols = 60;
                });
        });

        citationGroup.addSetting((setting) => {
            setting
                .setName("Footnote Definition Template")
                .setDesc(
                    "LiquidJS template for footnote definition text appended at the end of the note. " +
                        "Available variables: title, creators, citationKey, year, notePath, and all item metadata fields. " +
                        "Leave empty to insert footnote reference only.",
                )
                .addTextArea((ta) => {
                    ta.setPlaceholder(
                        "e.g. {{item.creators[0].name}}, *{{item.title}}*, {{item.year}}",
                    )
                        .setValue(this.plugin.settings.citationFootnoteTemplate)
                        .onChange(async (value) => {
                            this.plugin.settings.citationFootnoteTemplate =
                                value;
                            await this.plugin.saveSettings();
                        });
                    ta.inputEl.rows = 5;
                    ta.inputEl.cols = 60;
                });
        });

        citationGroup.addSetting((setting) => {
            setting
                .setName("Wikilink Template")
                .setDesc(
                    "LiquidJS template for wikilink citation text. " +
                        "Available variables: title, creators, citationKey, year, notePath, and all item metadata fields. " +
                        "Leave empty to use Obsidian's default markdown link format.",
                )
                .addTextArea((ta) => {
                    ta.setPlaceholder(
                        "e.g. [[{{item.notePath}}|{{item.title}}]]",
                    )
                        .setValue(this.plugin.settings.citationWikilinkTemplate)
                        .onChange(async (value) => {
                            this.plugin.settings.citationWikilinkTemplate =
                                value;
                            await this.plugin.saveSettings();
                        });
                    ta.inputEl.rows = 5;
                    ta.inputEl.cols = 60;
                });
        });

        citationGroup.addSetting((setting) => {
            setting
                .setName("Auto-copy New Annotation")
                .setDesc(
                    "When you create an annotation in the reader, automatically copy it to the clipboard. " +
                        "Embed inserts ![[note#^id]]; Text copies the highlighted text; Citation uses the default citation format above.",
                )
                .addDropdown((dropdown) => {
                    dropdown
                        .addOption("off", "Off")
                        .addOption("embed", "Embed")
                        .addOption("text", "Text")
                        .addOption("citation", "Citation")
                        .setValue(this.plugin.settings.autoCopyAnnotation)
                        .onChange(async (value) => {
                            this.plugin.settings.autoCopyAnnotation =
                                value as AutoCopyAnnotationMode;
                            await this.plugin.saveSettings();
                        });
                });
        });
    }
}
