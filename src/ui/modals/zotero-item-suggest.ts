import { setIcon } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import type { AnyIDBZoteroItem } from "types/db-schema";

export type SuggestionItemFilter = (item: AnyIDBZoteroItem) => boolean;

interface SearchHeader {
    isHeader: true;
    label: string;
}

interface SearchEmptyState {
    isEmpty: true;
    message: string;
}

export type SuggestionItem = AnyIDBZoteroItem | SearchHeader | SearchEmptyState;

/**
 * Shared Zotero item search + rendering logic.
 * Used by both `BaseItemSearchModal` (SuggestModal) and `CitationSuggest` (EditorSuggest)
 * to avoid duplicating query, rendering, and highlight code.
 */
export class ZoteroItemSuggest {
    itemPaths: Record<string, string[]> = {};

    constructor(private readonly itemFilter?: SuggestionItemFilter) {}

    async getSuggestions(
        query: string,
        limit: number,
    ): Promise<SuggestionItem[]> {
        try {
            let items: SuggestionItem[] = [];

            if (!query) {
                const recentItems =
                    await workerBridge.dbHelper.getRecentItems(limit);

                if (recentItems.length > 0) {
                    items = [
                        { isHeader: true, label: "Recent Viewed" },
                        ...recentItems,
                    ];
                } else {
                    const fallbackItems =
                        await workerBridge.dbHelper.getRecentlyAddedItems(
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
                const searchResults = await workerBridge.dbHelper.searchItems(
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
                const firstHeader = items.find((i) => "isHeader" in i) as
                    | SearchHeader
                    | undefined;
                items = [...(firstHeader ? [firstHeader] : []), ...zItems];
            } else {
                items = [];
            }

            if (zItems.length > 0) {
                try {
                    this.itemPaths = await workerBridge.dbHelper.getItemPaths(
                        zItems.map((i) => ({
                            libraryID: i.libraryID,
                            key: i.key,
                            collections: i.collections,
                        })),
                    );
                } catch (pathErr) {
                    services.logService.error(
                        "Failed to fetch item paths",
                        "ZoteroItemSuggest",
                        pathErr,
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
        this.renderHighlight(titleEl, zItem.title || "Untitled", query);

        // Meta + Path Row
        const bottomRow = contentContainer.createDiv({
            cls: "zotflow-row-bottom",
        });

        // Author • Year
        const metaEl = bottomRow.createDiv({ cls: "zotflow-meta" });
        const authors = this.formatCreators(zItem.searchCreators);
        const year = this.extractYear((zItem.raw.data as any).date);

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
        if (!query) {
            el.setText(text);
            return;
        }
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(${escapedQuery})`, "gi");

        text.split(regex).forEach((part) => {
            if (part.toLowerCase() === query.toLowerCase()) {
                el.createSpan({ cls: "suggestion-highlight", text: part });
            } else {
                el.createSpan({ text: part });
            }
        });
    }
}
