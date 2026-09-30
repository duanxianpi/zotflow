import { workerBridge } from "bridge";
import { services } from "services/services";
import { parseSearchQuery, splitHighlight } from "utils/search-query";
import type { SearchResult } from "obsidian";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { SearchFilterField } from "utils/search-query";

export type SuggestionItemFilter = (item: AnyIDBZoteroItem) => boolean;

interface SearchHeader {
    isHeader: true;
    label: string;
}

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
    AnyIDBZoteroItem | SearchHeader | SearchEmptyState | SearchValueCompletion;

/**
 * Shared Zotero item search + rendering logic.
 * Used by both `BaseItemSearchModal` (SuggestModal) and `CitationSuggest` (EditorSuggest)
 * to avoid duplicating query, rendering, and highlight code.
 */
export class ZoteroItemSuggest {
    itemPaths: Record<string, string[]> = {};
    /** Display titles keyed `${libraryID}:${key}`, from the user's template. */
    displayTitles: Record<string, string> = {};

    constructor(private readonly itemFilter?: SuggestionItemFilter) {}

    async getSuggestions(
        query: string,
        limit: number,
    ): Promise<SuggestionItem[]> {
        try {
            let items: SuggestionItem[] = [];

            if (!query) {
                const recentItems =
                    await workerBridge.search.getRecentItems(limit);

                if (recentItems.length > 0) {
                    items = [
                        { isHeader: true, label: "Recent Viewed" },
                        ...recentItems,
                    ];
                } else {
                    const fallbackItems =
                        await workerBridge.search.getRecentlyAddedItems(
                            limit,
                        );

                    if (fallbackItems.length > 0) {
                        items = [
                            { isHeader: true, label: "Recently Added" },
                            ...fallbackItems,
                        ];
                    }
                }
            } else {
                const searchResults = await workerBridge.search.searchItems(
                    query,
                    limit,
                );

                if (searchResults.length > 0) {
                    items = [
                        { isHeader: true, label: "Best Match" },
                        ...searchResults,
                    ];
                }
            }

            const zItems = items
                .filter((i) => !("isHeader" in i) && !("isEmpty" in i))
                .map((i) => i as AnyIDBZoteroItem)
                .filter((item) => this.shouldIncludeItem(item));

            if (zItems.length > 0) {
                const firstHeader = items.find((i) => "isHeader" in i);
                items = [...(firstHeader ? [firstHeader] : []), ...zItems];
            } else {
                items = [];
            }

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
                    this.itemPaths = paths.value;
                } else {
                    services.logService.error(
                        "Failed to fetch item paths",
                        "ZoteroItemSuggest",
                        paths.reason,
                    );
                }
                if (titles.status === "fulfilled") {
                    this.displayTitles = titles.value;
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

    renderSuggestion(
        item: SuggestionItem,
        el: HTMLElement,
        query: string,
    ): void {
        // Header
        if ("isHeader" in item && item.isHeader) {
            el.addClass("zotflow-suggestion-header");
            el.setText(item.label);
            return;
        }

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
