import { db, getCombinations } from "db/db";
import { Zotero_Item_Types } from "types/zotero-item-const";

import type { AnyIDBZoteroItem } from "types/db-schema";
import type { DbHelperService } from "./db-helper";
import type { SearchMatcher, SearchableRecord } from "./search-matcher";

/**
 * Worker-side item search behind the search modals and their autocomplete:
 * recent items for an empty query, ranked results for a typed one, and the
 * value lists for `library:` / `collection:` completion. Matching itself is
 * the shared `SearchMatcher`, so results rank as the tree view's search does.
 */
export class SearchService {
    constructor(
        private matcher: SearchMatcher,
        private dbHelper: DbHelperService,
    ) {}

    /**
     * Get recently accessed items.
     */
    async getRecentItems(limit: number): Promise<AnyIDBZoteroItem[]> {
        const libraryIDs = await this.dbHelper.getFilteredLibraryIDs();
        const isValidTopLevel = (type: string) =>
            !["note", "annotation"].includes(type);

        return await db.items
            .where("lastAccessedAt")
            .above("")
            .reverse()
            .filter(
                (item: AnyIDBZoteroItem) =>
                    libraryIDs.includes(item.libraryID) &&
                    !item.parentItem &&
                    isValidTopLevel(item.itemType) &&
                    !item.trashed,
            )
            .limit(limit)
            .toArray();
    }

    /**
     * Get recently added items (fallback when no recent access exists).
     */
    async getRecentlyAddedItems(limit: number): Promise<AnyIDBZoteroItem[]> {
        const libraryIDs = await this.dbHelper.getFilteredLibraryIDs();
        const isValidTopLevel = (type: string) =>
            !["note", "annotation"].includes(type);

        return await db.items
            .orderBy("dateModified")
            .reverse()
            .filter(
                (item: AnyIDBZoteroItem) =>
                    libraryIDs.includes(item.libraryID) &&
                    !item.parentItem &&
                    isValidTopLevel(item.itemType) &&
                    !item.trashed,
            )
            .limit(limit)
            .toArray();
    }

    /**
     * Return all library names for the active libraries, sorted alphabetically.
     * Used for `library:` autocomplete.
     */
    async getLibraryNames(): Promise<string[]> {
        const libraryIDs = await this.dbHelper.getFilteredLibraryIDs();
        if (libraryIDs.length === 0) return [];

        const libs = await db.libraries.where("id").anyOf(libraryIDs).toArray();

        const names = libs
            .map((lib) => lib.name || lib.id.toString())
            .sort((a, b) =>
                a.localeCompare(b, undefined, { sensitivity: "accent" }),
            );

        return names;
    }

    /**
     * Return all distinct (non-trashed) collection names across the active
     * libraries, sorted alphabetically. Used for `collection:` autocomplete.
     */
    async getCollectionNames(): Promise<string[]> {
        const libraryIDs = await this.dbHelper.getFilteredLibraryIDs();
        if (libraryIDs.length === 0) return [];

        const colls = await db.collections
            .where(["libraryID", "trashed"])
            .anyOf(getCombinations([libraryIDs, [0]]))
            .toArray();

        const names = new Set<string>();
        for (const c of colls) {
            if (c.name) names.add(c.name);
        }
        return Array.from(names).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "accent" }),
        );
    }

    /**
     * Search items by query string.
     *
     * Supports fuzzy free-text matching (title + creators + tags) plus
     * structured operators: `collection:`, `tag:`, `creator:`, `type:`
     * (with `-` negation). Ranking is delegated to the shared SearchMatcher.
     */
    async searchItems(
        query: string,
        limit: number,
    ): Promise<AnyIDBZoteroItem[]> {
        const libraryIDs = await this.dbHelper.getFilteredLibraryIDs();
        const parsed = this.matcher.parse(query);
        const isValidTopLevel = (type: string) =>
            !["note", "annotation"].includes(type);
        const validTopLevelTypeList = Zotero_Item_Types.filter((type) =>
            isValidTopLevel(type),
        );

        const candidates = await db.items
            .where(["libraryID", "itemType", "trashed"])
            .anyOf(getCombinations([libraryIDs, validTopLevelTypeList, [0]]))
            .filter((item: AnyIDBZoteroItem) => !item.parentItem)
            .toArray();

        // Resolve collection names only when a collection filter is present.
        const needsCollections = parsed.filters.some(
            (f) => f.field === "collection",
        );
        const collectionNames = needsCollections
            ? await this.resolveCollectionNames(candidates)
            : null;

        // Resolve library names for library filter.
        const libraryNames = new Map<number, string>();
        if (parsed.filters.some((f) => f.field === "library")) {
            const libs = await db.libraries
                .where("id")
                .anyOf(libraryIDs)
                .toArray();
            for (const lib of libs) {
                libraryNames.set(lib.id, lib.name);
            }
        }

        const byId = new Map<string, AnyIDBZoteroItem>();
        const records: SearchableRecord[] = candidates.map((item) => {
            const id = `${item.libraryID}:${item.key}`;
            byId.set(id, item);
            return {
                id,
                name: item.title || "",
                creators: item.searchCreators,
                tags: item.searchTags,
                itemType: item.itemType,
                libraryName: libraryNames.get(item.libraryID),
                collections: collectionNames
                    ? (item.collections || []).map(
                          (k) =>
                              collectionNames.get(`${item.libraryID}:${k}`) ||
                              "",
                      )
                    : undefined,
            };
        });

        const ranked = this.matcher.matchAndRank(parsed, records, limit);
        return ranked
            .map((r) => byId.get(r.id))
            .filter((i): i is AnyIDBZoteroItem => i !== undefined);
    }

    /**
     * Build a `${libraryID}:${collectionKey}` → collection name map for every
     * collection referenced by the given items.
     */
    private async resolveCollectionNames(
        items: AnyIDBZoteroItem[],
    ): Promise<Map<string, string>> {
        const keys: [number, string][] = [];
        const seen = new Set<string>();
        for (const item of items) {
            for (const collKey of item.collections || []) {
                const cacheKey = `${item.libraryID}:${collKey}`;
                if (!seen.has(cacheKey)) {
                    seen.add(cacheKey);
                    keys.push([item.libraryID, collKey]);
                }
            }
        }

        const names = new Map<string, string>();
        if (keys.length === 0) return names;

        const colls = await db.collections.bulkGet(keys);
        keys.forEach(([libID, collKey], i) => {
            const coll = colls[i];
            if (coll) names.set(`${libID}:${collKey}`, coll.name);
        });
        return names;
    }
}
