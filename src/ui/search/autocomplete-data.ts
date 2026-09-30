import { prepareFuzzySearch, sortSearchResults } from "obsidian";
import { workerBridge } from "bridge";
import { Zotero_Item_Types } from "types/zotero-item-const";
import { services } from "services/services";

import type { SearchResult } from "obsidian";
import type { SearchFilterField } from "utils/search-query";

/**
 * Main-thread provider of value suggestions for search operators
 * (`collection:`, `tag:`, `type:`). Lists are fetched from the worker on
 * demand and cached until a local mutation or completed sync invalidates them.
 */

type AutocompleteCacheKey = "tag" | "collection" | "library";

export interface ValueSuggestion {
    value: string;
    match?: SearchResult;
}

interface CacheSlot {
    value: string[] | null;
    load: Promise<string[]> | null;
    generation: number;
}

const slots: Record<AutocompleteCacheKey, CacheSlot> = {
    tag: { value: null, load: null, generation: 0 },
    collection: { value: null, load: null, generation: 0 },
    library: { value: null, load: null, generation: 0 },
};

let observedSyncRevision = -1;

/** Item types offered for `type:` completion (annotations is internal). */
const TYPE_VALUES = Zotero_Item_Types.filter((t) => t !== "annotation");

function invalidate(key: AutocompleteCacheKey): void {
    const slot = slots[key];
    slot.value = null;
    slot.load = null;
    slot.generation += 1;
}

/** Clear only tag values after a local tag mutation. */
export function invalidateTagAutocompleteCache(): void {
    invalidate("tag");
}

/** Clear all worker-backed values after a sync changes library data. */
export function invalidateAutocompleteCache(): void {
    invalidate("tag");
    invalidate("collection");
    invalidate("library");
}

/**
 * Return a cached value list, coalescing concurrent cache misses into one load.
 * A result started before invalidation may still reach its original caller,
 * but cannot repopulate the cache with stale data.
 */
async function getCachedValues(
    key: AutocompleteCacheKey,
    loader: () => Promise<string[]>,
): Promise<string[]> {
    const slot = slots[key];
    if (slot.value !== null) return slot.value;
    if (slot.load) return slot.load;

    const generation = slot.generation;
    const load = loader();
    slot.load = load;

    try {
        const values = await load;
        if (slot.generation === generation) {
            slot.value = values;
        }
        return values;
    } finally {
        if (slot.load === load) {
            slot.load = null;
        }
    }
}

function invalidateAfterSyncIfNeeded(): void {
    const revision = services.taskMonitor.getSyncDataRevision();
    if (observedSyncRevision === -1) {
        observedSyncRevision = revision;
        return;
    }
    if (revision !== observedSyncRevision) {
        observedSyncRevision = revision;
        invalidateAutocompleteCache();
    }
}

/**
 * Return up to `limit` value suggestions for the given operator field. Tag
 * values are fuzzy-ranked; other fields use case-insensitive substring
 * matching. Returns `[]` for fields without completion (e.g. `creator`).
 */
export async function getValueSuggestions(
    field: SearchFilterField,
    partial: string,
    limit = 200,
): Promise<ValueSuggestion[]> {
    invalidateAfterSyncIfNeeded();

    let source: string[];
    try {
        switch (field) {
            case "library":
                source = await getCachedValues("library", () =>
                    workerBridge.search.getLibraryNames(),
                );
                break;
            case "tag":
                source = await getCachedValues("tag", () =>
                    workerBridge.tag.getTagNames(),
                );
                break;
            case "collection":
                source = await getCachedValues("collection", () =>
                    workerBridge.search.getCollectionNames(),
                );
                break;
            case "type":
                source = TYPE_VALUES;
                break;
            default:
                return [];
        }
    } catch (err) {
        services.logService.error(
            "Failed to load value suggestions",
            "SearchAutocomplete",
            err,
        );
        return [];
    }

    if (!partial) {
        return source.slice(0, limit).map((value) => ({ value }));
    }

    if (field === "tag") {
        const fuzzySearch = prepareFuzzySearch(partial);
        const matches: Array<{ value: string; match: SearchResult }> = [];
        for (const value of source) {
            const match = fuzzySearch(value);
            if (match) matches.push({ value, match });
        }
        sortSearchResults(matches);
        return matches.slice(0, limit);
    }

    const p = partial.toLowerCase();
    return source
        .filter((value) => value.toLowerCase().includes(p))
        .slice(0, limit)
        .map((value) => ({ value }));
}
