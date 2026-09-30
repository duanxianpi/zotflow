import { Liquid } from "liquidjs";

import { db } from "db/db";
import { buildItemMetadata } from "utils/zotero-fields";
import { workerClearTimeout, workerSetTimeout } from "worker/timers";

import type { Template } from "liquidjs";
import type { IParentProxy } from "bridge/types";
import type { ZotFlowSettings } from "settings/types";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { WorkerTimeout } from "worker/timers";

/** Child types keep their own names (filename, note first line). */
const CHILD_TYPES = new Set(["attachment", "note", "annotation"]);

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
    private readonly cache = new Map<
        string,
        { version: number; title: string }
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
        if (!this.templates || CHILD_TYPES.has(item.itemType)) return fallback;

        const id = `${item.libraryID}:${item.key}`;
        const cached = this.cache.get(id);
        if (cached && cached.version === item.version) return cached.title;

        const title = this.render(this.templates, item) || fallback;
        this.cache.set(id, { version: item.version, title });
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
                },
            });
            // Titles are one line; collapse whatever whitespace the
            // template's tags left behind.
            return typeof out === "string"
                ? out.replace(/\s+/g, " ").trim()
                : "";
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
}
