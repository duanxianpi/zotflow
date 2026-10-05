/**
 * The template tester's contexts and where each one's template is saved:
 * a setting, or (source notes) a template file named by a setting. Pure, so
 * the write-back rules are testable without Obsidian.
 */
import type { ZotFlowSettings } from "settings/types";
import type { CitationTemplateFormat } from "worker/services/library-template";

export type TemplateContext =
    | "library"
    | "local"
    | "library-path"
    | "local-path"
    | "citation-pandoc"
    | "citation-wikilink"
    | "citation-footnote-ref"
    | "citation-footnote"
    | "display-title";

export type CitationContext = Extract<TemplateContext, `citation-${string}`>;

export const CONTEXT_LABELS: Record<TemplateContext, string> = {
    library: "Library Source Note",
    local: "Local Source Note",
    "library-path": "Library Source Note Path",
    "local-path": "Local Source Note Path",
    "citation-pandoc": "Citation Pandoc",
    "citation-wikilink": "Citation Wikilink",
    "citation-footnote-ref": "Citation Footnote Reference",
    "citation-footnote": "Citation Footnote Definition",
    "display-title": "Item Display Title",
};

export function isCitationContext(ctx: TemplateContext): ctx is CitationContext {
    return ctx.startsWith("citation-");
}

/** `citation-pandoc` → `pandoc`, and so on. */
export function citationFormat(ctx: CitationContext): CitationTemplateFormat {
    return ctx.slice("citation-".length) as CitationTemplateFormat;
}

/** Contexts rendered against a Zotero item; the rest take a vault file. */
export function needsLibraryItem(ctx: TemplateContext): boolean {
    return ctx !== "local" && ctx !== "local-path";
}

/** Settings that hold a template themselves. */
export type SettingTemplateKey =
    | "librarySourceNotePathTemplate"
    | "localSourceNotePathTemplate"
    | "citationPandocTemplate"
    | "citationWikilinkTemplate"
    | "citationFootnoteRefTemplate"
    | "citationFootnoteTemplate"
    | "itemDisplayTitleTemplate";

/** Settings that hold the path of a template file. */
export type TemplateFileKey =
    | "librarySourceNoteTemplatePath"
    | "localSourceNoteTemplatePath";

export type TemplateTarget =
    | {
          kind: "setting";
          key: SettingTemplateKey;
          /** Where the user finds it in the settings. */
          label: string;
          /** Its settings field is one line: an input drops line breaks when edited there. */
          singleLine: boolean;
      }
    | {
          kind: "file";
          pathKey: TemplateFileKey;
          label: string;
          /** Suggested when no template file is set yet. */
          defaultPath: string;
      };

export const TEMPLATE_TARGETS: Record<TemplateContext, TemplateTarget> = {
    library: {
        kind: "file",
        pathKey: "librarySourceNoteTemplatePath",
        label: "Library source note template file",
        defaultPath: "Templates/ZotFlow Library Source Note.md",
    },
    local: {
        kind: "file",
        pathKey: "localSourceNoteTemplatePath",
        label: "Local source note template file",
        defaultPath: "Templates/ZotFlow Local Source Note.md",
    },
    "library-path": {
        kind: "setting",
        key: "librarySourceNotePathTemplate",
        label: "Source Notes → Library Source Note Path Template",
        singleLine: true,
    },
    "local-path": {
        kind: "setting",
        key: "localSourceNotePathTemplate",
        label: "Source Notes → Local Source Note Path Template",
        singleLine: true,
    },
    "citation-pandoc": {
        kind: "setting",
        key: "citationPandocTemplate",
        label: "Citations → Pandoc Template",
        singleLine: false,
    },
    "citation-wikilink": {
        kind: "setting",
        key: "citationWikilinkTemplate",
        label: "Citations → Wikilink Template",
        singleLine: false,
    },
    "citation-footnote-ref": {
        kind: "setting",
        key: "citationFootnoteRefTemplate",
        label: "Citations → Footnote Reference Template",
        singleLine: false,
    },
    "citation-footnote": {
        kind: "setting",
        key: "citationFootnoteTemplate",
        label: "Citations → Footnote Definition Template",
        singleLine: false,
    },
    "display-title": {
        kind: "setting",
        key: "itemDisplayTitleTemplate",
        label: "General → Display Title Template",
        singleLine: true,
    },
};

/** A context's saved template, as the tester loads it. */
export interface SavedTemplate {
    context: TemplateContext;
    /**
     * What is stored: the setting's value, or the template file's content.
     * Null when nothing is: no template file set, or the file is missing.
     */
    stored: string | null;
    /** The template file's path as set ("" when none). File targets only. */
    filePath: string;
    /** Used while nothing is stored ("" for the display title: the Zotero title). */
    builtIn: string;
}

/** The template in effect: what is stored, or the built-in one while nothing is. */
export function effectiveTemplate(saved: SavedTemplate): string {
    return saved.stored?.trim() ? saved.stored : saved.builtIn;
}

/** Whether `text` is the template in effect (settings are trimmed before use). */
export function matchesSaved(text: string, saved: SavedTemplate): boolean {
    return text.trim() === effectiveTemplate(saved).trim();
}

export type WriteBackPlan =
    | {
          kind: "setting";
          key: SettingTemplateKey;
          value: string;
          /** The text is the built-in template, so the setting is cleared to keep following it. */
          clearsToBuiltIn: boolean;
      }
    | {
          kind: "file";
          path: string;
          content: string;
          /** No template file was set: the path setting is set to `path` too. */
          setsPath: TemplateFileKey | null;
      };

/**
 * What saving `text` as `saved.context`'s template writes. `chosenPath` is
 * the file path the user picked when no template file is set yet.
 */
export function planWriteBack(
    saved: SavedTemplate,
    text: string,
    chosenPath?: string,
): WriteBackPlan {
    const target = TEMPLATE_TARGETS[saved.context];
    if (target.kind === "setting") {
        const value = text.trim();
        const clearsToBuiltIn = value === saved.builtIn.trim();
        return {
            kind: "setting",
            key: target.key,
            value: clearsToBuiltIn ? "" : value,
            clearsToBuiltIn: clearsToBuiltIn && value !== "",
        };
    }
    const path = saved.filePath || (chosenPath ?? target.defaultPath).trim();
    return {
        kind: "file",
        path,
        content: text,
        setsPath: saved.filePath ? null : target.pathKey,
    };
}

/** Warnings to show before a write-back. */
export function writeBackWarnings(saved: SavedTemplate, text: string): string[] {
    const target = TEMPLATE_TARGETS[saved.context];
    const warnings: string[] = [];
    if (target.kind === "setting" && target.singleLine && /\n/.test(text.trim())) {
        warnings.push(
            "This setting's field is one line. The line breaks are saved, but editing the field in the settings removes them.",
        );
    }
    return warnings;
}

/** Read a context's stored value from settings (file targets: the path). */
export function settingValue(
    settings: ZotFlowSettings,
    target: TemplateTarget,
): string {
    return target.kind === "setting"
        ? settings[target.key]
        : settings[target.pathKey];
}
