import { workerBridge } from "bridge";
import { services } from "services/services";
import { parseSearchQuery, splitHighlight } from "utils/search-query";
import type { SearchResult } from "obsidian";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { SearchFilterField } from "utils/search-query";

export type SuggestionItemFilter = (item: AnyIDBZoteroItem) => boolean;

interface SearchEmptyState {
    isEmpty: true;
    message: string;
}

/** An operator reminder row (e.g. `collection:` — items in a collection). */
export interface SearchValueCompletion {
    isValueCompletion: true;
    field: SearchFilterField;
    value: string;
    match?: SearchResult;
}

export type SuggestionItem =
    AnyIDBZoteroItem | SearchEmptyState | SearchValueCompletion;

/**
 * Shared Zotero item search + rendering logic.
 * Used by both `BaseItemSearchModal` (SuggestModal) and `CitationSuggest` (EditorSuggest)
 * to avoid duplicating query, rendering, and highlight code.
 */
export class ZoteroItemSuggest {
    /**
     * Collection paths and display titles keyed `${libraryID}:${key}`. Lookups
     * merge into them rather than replace them: an outdated lookup finishing
     * late must not take away what the shown results render with.
     */
    itemPaths: Record<string, string[]> = {};
    /** Display titles, from the user's template. */
    displayTitles: Record<string, string> = {};
    /**
     * Group labels ("Best Match", …), keyed by the first suggestion of their
     * group. A label is drawn above that suggestion, not as a row of its own:
     * a row would be one the list can select (the first row starts selected,
     * so Enter would pick the label).
     */
    private groupLabels = new WeakMap<object, string>();

    constructor(private readonly itemFilter?: SuggestionItemFilter) {}

    async getSuggestions(
        query: string,
        limit: number,
    ): Promise<SuggestionItem[]> {
        try {
            let found: AnyIDBZoteroItem[] = [];
            let label = "";

            if (!query) {
                found = await workerBridge.search.getRecentItems(limit);
                label = "Recent Viewed";
                if (found.length === 0) {
                    found =
                        await workerBridge.search.getRecentlyAddedItems(limit);
                    label = "Recently Added";
                }
            } else {
                found = await workerBridge.search.searchItems(query, limit);
                label = "Best Match";
            }

            const zItems = found.filter((item) => this.shouldIncludeItem(item));
            const items: SuggestionItem[] = zItems;
            if (zItems[0]) this.setGroupLabel(zItems[0], label);

            if (zItems.length > 0) {
                const refs = zItems.map((i) => ({
                    libraryID: i.libraryID,
                    key: i.key,
                    collections: i.collections,
                }));
                const [paths, titles] = await Promise.allSettled([
                    workerBridge.dbHelper.getItemPaths(refs),
                    workerBridge.displayTitle.getTitles(refs),
                ]);
                if (paths.status === "fulfilled") {
                    Object.assign(this.itemPaths, paths.value);
                } else {
                    services.logService.error(
                        "Failed to fetch item paths",
                        "ZoteroItemSuggest",
                        paths.reason,
                    );
                }
                if (titles.status === "fulfilled") {
                    Object.assign(this.displayTitles, titles.value);
                } else {
                    services.logService.error(
                        "Failed to fetch display titles",
                        "ZoteroItemSuggest",
                        titles.reason,
                    );
                }
            }

            if (items.length === 0) {
                if (query) {
                    return [
                        { isEmpty: true, message: `No results for "${query}"` },
                    ];
                }
                return [{ isEmpty: true, message: "No items in library" }];
            }

            return items;
        } catch (e) {
            services.logService.error("Search failed", "ZoteroItemSuggest", e);
            return [];
        }
    }

    private shouldIncludeItem(item: AnyIDBZoteroItem): boolean {
        // Hide note items for libraries without notes permission.
        if (
            item.itemType === "note" &&
            !services.libraryCache.hasNotesAccess(item.libraryID)
        ) {
            return false;
        }
        return this.itemFilter ? this.itemFilter(item) : true;
    }

    /** Show `label` above `item`, the first suggestion of its group. */
    setGroupLabel(item: SuggestionItem, label: string): void {
        this.groupLabels.set(item, label);
    }

    /**
     * Draw the group label of `item`, if it starts a group, just before its
     * row. Call it from every `renderSuggestion`, before the row's content.
     */
    renderGroupLabel(item: SuggestionItem, el: HTMLElement): void {
        const label = this.groupLabels.get(item);
        if (!label) return;
        const labelEl = createDiv({
            cls: "zotflow-suggestion-group-label",
            text: label,
        });
        // Outside the row, so the row's selection highlight leaves it out.
        // The list clears its container on every update, labels included.
        if (el.parentElement) el.before(labelEl);
        else el.prepend(labelEl);
    }

    renderSuggestion(
        item: SuggestionItem,
        el: HTMLElement,
        query: string,
    ): void {
        this.renderGroupLabel(item, el);

        // Empty state
        if ("isEmpty" in item && item.isEmpty) {
            el.addClass("zotflow-suggestion-empty");
            el.createSpan({
                cls: "zotflow-empty-message",
                text: item.message,
            });
            return;
        }

        // Zotero Item
        const zItem = item as AnyIDBZoteroItem;

        el.addClass("zotflow-search-item");

        // Main Content Container
        const contentContainer = el.createDiv({ cls: "zotflow-item-content" });

        // Title Row
        const titleRow = contentContainer.createDiv({ cls: "zotflow-row-top" });
        const titleEl = titleRow.createDiv({ cls: "zotflow-title" });
        const title =
            this.displayTitles[`${zItem.libraryID}:${zItem.key}`] ||
            zItem.title;
        this.renderHighlight(titleEl, title || "Untitled", query);

        // Meta + Path Row
        const bottomRow = contentContainer.createDiv({
            cls: "zotflow-row-bottom",
        });

        // Author • Year
        const metaEl = bottomRow.createDiv({ cls: "zotflow-meta" });
        const authors = this.formatCreators(zItem.searchCreators);
        // Only some Zotero item types carry `date`, so it is read off the
        // union rather than assumed present.
        const { date } = zItem.raw.data as { date?: string };
        const year = this.extractYear(date ?? "");

        let metaText = "";
        if (authors && year !== "n.d.") metaText = `${authors} (${year}).`;
        else if (authors) metaText = authors;
        else metaText = year;

        this.renderHighlight(metaEl, metaText, query);

        // Path pills
        const paths = this.itemPaths[`${zItem.libraryID}:${zItem.key}`];
        if (paths && paths.length > 0) {
            const pathsEl = bottomRow.createDiv({ cls: "zotflow-paths" });

            paths.forEach((path) => {
                const pill = pathsEl.createSpan({ cls: "zotflow-path-pill" });

                const segments = path.split("/");
                segments.forEach((seg, i) => {
                    pill.createSpan({ text: seg.trim() });
                    if (i < segments.length - 2) {
                        pill.createSpan({ cls: "path-sep", text: "/" });
                    }
                });
            });
        }
    }

    formatCreators(creators: string[]): string | null {
        if (!creators || creators.length === 0) return null;
        if (creators.length === 1) return creators[0]!;
        if (creators.length === 2) return `${creators[0]} & ${creators[1]}`;
        return `${creators[0]} et al.`;
    }

    extractYear(dateString: string): string {
        if (!dateString) return "n.d.";
        const match = dateString.match(/\d{4}/);
        return match ? match[0] : "n.d.";
    }

    renderHighlight(el: HTMLElement, text: string, query: string): void {
        const { freeTokens } = parseSearchQuery(query);
        const segments = splitHighlight(text, freeTokens);

        // Fast path: nothing to highlight.
        if (segments.length === 1 && !segments[0]!.match) {
            el.setText(text);
            return;
        }

        segments.forEach((seg) => {
            if (seg.match) {
                el.createSpan({ cls: "suggestion-highlight", text: seg.text });
            } else {
                el.createSpan({ text: seg.text });
            }
        });
    }
}
