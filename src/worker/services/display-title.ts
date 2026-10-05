import { Liquid } from "liquidjs";

import { db } from "db/db";
import { buildItemMetadata } from "utils/zotero-fields";
import { workerClearTimeout, workerSetTimeout } from "worker/timers";

import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import {
    liquidErrorInfo,
    previewResult,
    TemplatePreviewError,
} from "worker/services/liquid-support";

import type { Template } from "liquidjs";
import type { TemplatePreviewResult } from "types/template-preview";
import type { IParentProxy } from "bridge/types";
import type { ZotFlowSettings } from "settings/types";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { WorkerTimeout } from "worker/timers";

/** Types that keep their own names (a note's first line, an annotation's text). */
const UNTEMPLATED_TYPES = new Set(["note", "annotation"]);

/**
 * Whether a template titles attachments too: only one written for them,
 * i.e. one that looks at `item.itemType` or `contentType` and names
 * "attachment" (`{% if item.itemType == "attachment" %}`). A template
 * written for regular items would otherwise turn every attachment into
 * " - " or "(n.d.)"; those keep their file names.
 */
export function templatesAttachments(source: string): boolean {
    return /item\.itemType|contentType/.test(source) && source.includes("attachment");
}

/**
 * Pause after the last template edit before it takes effect. The settings
 * field saves on every keystroke; applying once typing stops keeps the tree
 * from rebuilding per character, and the tree and search switch together.
 */
export const DISPLAY_TITLE_APPLY_DELAY = 1000;

/**
 * Renders the user's display-title template for regular items, as shown in
 * the tree view and the item search modals. With no template, or when it
 * renders empty or fails, the stored Zotero title is used.
 *
 * Rendering is synchronous and cached per item version, since the tree and
 * each search keystroke title every item in the active libraries.
 */
export class DisplayTitleService {
    private readonly engine = new Liquid({ greedy: false });
    /** The template in effect. */
    private source = "";
    /** The template waiting out the apply delay. */
    private pendingSource: string | null = null;
    private applyTimer: WorkerTimeout | null = null;
    private templates: Template[] | null = null;
    /** Whether the template in effect titles attachments (`templatesAttachments`). */
    private forAttachments = false;
    /**
     * Rendered titles, for this session. A row's title changes with a
     * download (`version`) or a local edit (`localRevision`, e.g. its tags).
     */
    private readonly cache = new Map<
        string,
        { version: number; localRevision: number; title: string }
    >();
    private readonly listeners = new Set<() => void>();
    /** Render failures are logged once per template, not once per item. */
    private reportedRenderError = false;

    constructor(
        settings: ZotFlowSettings,
        private readonly parentHost: IParentProxy,
    ) {
        // The first template applies at once; only later edits wait.
        this.apply(settings.itemDisplayTitleTemplate.trim());
    }

    /** Schedule a template change; repeated calls restart the delay. */
    updateSettings(settings: ZotFlowSettings): void {
        const source = settings.itemDisplayTitleTemplate.trim();
        if (source === (this.pendingSource ?? this.source)) return;

        this.cancelPending();
        // Typing back to the template in effect needs no rebuild.
        if (source === this.source) return;

        this.pendingSource = source;
        this.applyTimer = workerSetTimeout(() => {
            this.applyTimer = null;
            this.pendingSource = null;
            this.apply(source);
            for (const listener of this.listeners) listener();
            this.parentHost.emit("treeChanged");
        }, DISPLAY_TITLE_APPLY_DELAY);
    }

    /** Called after a new template takes effect. Returns an unsubscribe. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** The title to show for `item`. */
    get(item: AnyIDBZoteroItem): string {
        const fallback = item.title || "";
        if (!this.templates || UNTEMPLATED_TYPES.has(item.itemType)) return fallback;
        if (item.itemType === "attachment" && !this.forAttachments) return fallback;

        const id = `${item.libraryID}:${item.key}`;
        const localRevision = item.localRevision ?? 0;
        const cached = this.cache.get(id);
        if (cached && cached.version === item.version && cached.localRevision === localRevision) return cached.title;

        const title = this.render(this.templates, item) || fallback;
        this.cache.set(id, { version: item.version, localRevision, title });
        return title;
    }

    /**
     * Display titles for the given items, keyed `${libraryID}:${key}`, for
     * the search modals. Missing items are omitted.
     */
    async getTitles(
        refs: { libraryID: number; key: string }[],
    ): Promise<Record<string, string>> {
        const items = await db.items.bulkGet(
            refs.map((r) => [r.libraryID, r.key] as [number, string]),
        );
        const titles: Record<string, string> = {};
        for (const item of items) {
            if (item) titles[`${item.libraryID}:${item.key}`] = this.get(item);
        }
        return titles;
    }

    /**
     * Name fields for a search record: the display title, plus the Zotero
     * title as an alias when the display title does not already contain it,
     * so a `{{ item.citationKey }}` template still finds items by title.
     */
    searchNames(item: AnyIDBZoteroItem): { name: string; aliases?: string[] } {
        const name = this.get(item);
        const title = item.title || "";
        return title && !name.includes(title)
            ? { name, aliases: [title] }
            : { name };
    }

    dispose(): void {
        this.cancelPending();
        this.listeners.clear();
    }

    private cancelPending(): void {
        if (this.applyTimer !== null) workerClearTimeout(this.applyTimer);
        this.applyTimer = null;
        this.pendingSource = null;
    }

    private apply(source: string): void {
        this.source = source;
        this.forAttachments = templatesAttachments(source);
        this.cache.clear();
        this.reportedRenderError = false;
        this.templates = null;
        if (!source) return;

        try {
            this.templates = this.engine.parse(source);
        } catch (e) {
            this.parentHost.log(
                "warn",
                "Display title template is invalid; showing Zotero titles",
                "DisplayTitleService",
                e,
            );
        }
    }

    private render(templates: Template[], item: AnyIDBZoteroItem): string {
        try {
            return collapseTitle(this.renderRaw(templates, item));
        } catch (e) {
            if (!this.reportedRenderError) {
                this.reportedRenderError = true;
                this.parentHost.log(
                    "warn",
                    "Display title template failed to render; showing Zotero titles",
                    "DisplayTitleService",
                    e,
                );
            }
            return "";
        }
    }

    private renderRaw(templates: Template[], item: AnyIDBZoteroItem): string {
        const out: unknown = this.engine.renderSync(templates, {
            item: {
                ...buildItemMetadata(item),
                key: item.key,
                version: item.version,
                libraryID: item.libraryID,
                itemType: item.itemType,
                dateAdded: item.dateAdded,
                dateModified: item.dateModified,
                tags: item.raw?.data?.tags || [],
                ...attachmentFields(item),
            },
        });
        return typeof out === "string" ? out : "";
    }

    /**
     * Preview `source` on one item for the template tester, following the
     * same rules as `get()`; the hints say which rule decided the title.
     */
    async preview(
        libraryID: number,
        key: string,
        source: string,
    ): Promise<TemplatePreviewResult> {
        const item = await db.items.get([libraryID, key]);
        if (!item) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "DisplayTitleService",
                `Item not found: ${libraryID}/${key}`,
            );
        }
        const fallback = item.title || "";
        return previewResult(async (hints) => {
            if (!source.trim()) {
                hints.push("The template is empty; the Zotero title is shown.");
                return { output: fallback };
            }
            // Parsed untrimmed so errors point where the user typed them;
            // the surrounding whitespace is collapsed away either way.
            let templates: Template[];
            try {
                templates = this.engine.parse(source);
            } catch (e) {
                throw new TemplatePreviewError(liquidErrorInfo(e));
            }
            if (UNTEMPLATED_TYPES.has(item.itemType)) {
                hints.push(
                    "Notes and annotations keep their own names; the template does not apply to them.",
                );
                return { output: fallback };
            }
            if (item.itemType === "attachment" && !templatesAttachments(source)) {
                hints.push(
                    'Attachments keep their file names unless the template checks item.itemType == "attachment".',
                );
                return { output: fallback };
            }
            let raw: string;
            try {
                raw = this.renderRaw(templates, item);
            } catch (e) {
                throw new TemplatePreviewError(liquidErrorInfo(e));
            }
            const title = collapseTitle(raw);
            if (!title) {
                hints.push("The template renders empty; the Zotero title is shown.");
                return { output: fallback };
            }
            if (/\n/.test(raw.trim())) {
                hints.push("Line breaks are collapsed: a display title is one line.");
            }
            return { output: title };
        });
    }
}

/** Titles are one line; collapse whatever whitespace the template's tags left behind. */
function collapseTitle(out: string): string {
    return out.replace(/\s+/g, " ").trim();
}

/** An attachment's file properties (not Zotero schema fields); {} otherwise. */
function attachmentFields(item: AnyIDBZoteroItem): Record<string, string> {
    if (item.itemType !== "attachment") return {};
    const data = item.raw?.data as
        | { filename?: string; contentType?: string; linkMode?: string }
        | undefined;
    return {
        filename: data?.filename ?? "",
        contentType: data?.contentType ?? "",
        linkMode: data?.linkMode ?? "",
    };
}
