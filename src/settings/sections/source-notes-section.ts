import type { SettingDefinitionItem } from "obsidian";
import type { SettingKey } from "settings/types";

/** Declarative settings for library, local, and shared source-note behavior. */
export class SourceNotesSection {
    getDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "page",
                name: "Library Source Note",
                desc: "Source notes, navigation, and linked attachments for Zotero library items.",
                items: this.getLibraryDefinitions(),
            },
            {
                type: "page",
                name: "Local Source Note",
                desc: "Source notes and annotation storage for files in the vault.",
                items: this.getLocalDefinitions(),
            },
            {
                type: "group",
                heading: "Shared Behavior",
                items: [
                    {
                        name: "Group annotations by category",
                        desc: "Built-in templates only: generate category sections, with uncategorized annotations in Other. Tags take precedence over default-profile color labels. Use force update to refresh existing library notes.",
                        control: { type: "toggle", key: "groupSourceNoteAnnotations" },
                    },
                    {
                        name: "Labeled annotation callout titles",
                        desc: "Built-in templates only, when grouping is off: use the resolved category or color label as the callout title. Custom Liquid templates remain in control of their layout.",
                        control: { type: "toggle", key: "labeledAnnotationCallouts" },
                    },
                    {
                        name: "Lock Editable Regions by Default",
                        desc: "When enabled, editable regions in source notes start locked. Click the lock icon on a region to unlock it for editing.",
                        control: {
                            type: "toggle",
                            key: "defaultEditableRegionLocked",
                        },
                    },
                    {
                        name: "Hide Editable Region Markers",
                        desc: "Hide the ZF_NOTE and ZF_PERSIST comment tags in source notes. The lock icon and region border remain visible.",
                        control: {
                            type: "toggle",
                            key: "hideEditableRegionMarkers",
                        },
                    },
                    {
                        name: "Auto Import Annotation Images",
                        desc: "Auto import annotation images for area and ink annotations from PDF when creating source notes.",
                        control: {
                            type: "toggle",
                            key: "autoImportAnnotationImages",
                        },
                    },
                    {
                        name: "Annotation Image Folder",
                        desc: "Default folder for annotation images (relative to vault root).",
                        control: {
                            type: "text",
                            key: "annotationImageFolder",
                            placeholder: "e.g. Attachments/ZotFlow",
                        },
                    },
                ],
            },
        ];
    }

    private getLibraryDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "group",
                heading: "Source Notes",
                items: [
                    {
                        name: "Template Path",
                        desc: "Path to template file for library source notes (relative to vault root).",
                        control: {
                            type: "text",
                            key: "librarySourceNoteTemplatePath",
                            placeholder: "e.g. templates/SourceNoteTemplate.md",
                        },
                    },
                    {
                        name: "Library Source Note Path Template",
                        desc: "LiquidJS template for library source note file path (without .md extension). Variables work with or without the item. prefix, e.g. {{title}} or {{item.title}}.",
                        control: {
                            type: "text",
                            key: "librarySourceNotePathTemplate",
                            placeholder:
                                "e.g. References/{{libraryName}}/@{{citationKey | default: key}}",
                        },
                    },
                    {
                        name: "Convert Item Note Links",
                        desc: "Show links inside item notes as ZotFlow links in Obsidian while storing and syncing them as native Zotero links — clicks open ZotFlow's reader here and Zotero's reader there.",
                        control: {
                            type: "toggle",
                            key: "convertNoteLinks",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Navigation",
                items: [
                    {
                        name: "Always Open Child Notes in Note Editor",
                        desc: "When enabled, child notes always open in the standalone Note Editor view (experimental). When disabled (default), child notes open in their parent's source note, scrolled to the note's editable region.",
                        control: {
                            type: "toggle",
                            key: "alwaysOpenChildNoteInEditor",
                        },
                    },
                    {
                        name: "Open Items on Single Click",
                        desc: "In the tree view, clicking an item's title directly opens it (source note, attachment, or note preview) and only the chevron expands/collapses. When disabled, a click toggles expansion and a double click opens attachments and notes.",
                        control: {
                            type: "toggle",
                            key: "treeSingleClickOpen",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Linked Attachments",
                items: [
                    {
                        name: "Linked Attachment Base Directory",
                        desc: 'Absolute path to the base directory for Zotero linked attachments (LABD). Set this to match the "Linked Attachment Base Directory" configured in Zotero (Preferences → Advanced → Files and Folders). Required for opening attachments whose path starts with "attachments:".',
                        control: {
                            type: "text",
                            key: "linkedAttachmentBaseDir",
                            placeholder:
                                "e.g. D:\\Papers or /Users/name/Papers",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Zotero Storage",
                items: [
                    {
                        name: "Use Zotero Storage Directory",
                        desc: "Read stored attachments directly from Zotero's local storage directory instead of downloading them. Desktop only; mobile continues to use the configured sync service.",
                        control: {
                            type: "toggle",
                            key: "useZoteroStorage",
                        },
                    },
                    {
                        name: "Zotero Storage Path",
                        desc: "Absolute path to Zotero's storage directory (e.g. C:\\Users\\name\\Zotero\\storage). Enter the complete path without using a home-directory shortcut such as ~.",
                        control: {
                            type: "text",
                            key: "zoteroStoragePath",
                            placeholder:
                                "e.g. C:\\Users\\name\\Zotero\\storage",
                        },
                    },
                ],
            },
        ];
    }

    private getLocalDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                type: "group",
                heading: "Source Notes",
                items: [
                    {
                        name: "Source Note Template Path",
                        desc: "Path to template file for local source notes (relative to vault root).",
                        control: {
                            type: "text",
                            key: "localSourceNoteTemplatePath",
                            placeholder:
                                "e.g. templates/LocalSourceNoteTemplate.md",
                        },
                    },
                    {
                        name: "Local Source Note Path Template",
                        desc: "LiquidJS template for local source note file path (without .md extension). Variables: basename, name, extension, path, and directory.",
                        control: {
                            type: "text",
                            key: "localSourceNotePathTemplate",
                            placeholder: "e.g. Local/@{{basename}}",
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Annotation Storage",
                items: [
                    {
                        name: "Annotation Sidecar Folder",
                        desc: "Folder for local annotation sidecar files (.zf.json), relative to vault root. Leave empty to store sidecars next to each attachment. When set, the original folder structure is mirrored under this folder to avoid filename collisions.",
                        control: {
                            type: "text",
                            key: "localSidecarFolder",
                            placeholder: "e.g. .zotflow/sidecars",
                        },
                    },
                ],
            },
        ];
    }
}
