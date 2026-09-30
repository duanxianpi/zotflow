import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getTagNames: vi.fn<() => Promise<string[]>>(),
    getCollectionNames: vi.fn<() => Promise<string[]>>(),
    getLibraryNames: vi.fn<() => Promise<string[]>>(),
    getSyncDataRevision: vi.fn(() => 0),
    logError: vi.fn(),
}));

vi.mock("bridge", () => ({
    workerBridge: {
        tag: { getTagNames: mocks.getTagNames },
        search: {
            getCollectionNames: mocks.getCollectionNames,
            getLibraryNames: mocks.getLibraryNames,
        },
    },
}));

vi.mock("services/services", () => ({
    services: {
        taskMonitor: {
            getSyncDataRevision: mocks.getSyncDataRevision,
        },
        logService: { error: mocks.logError },
    },
}));

vi.mock("obsidian", () => ({
    prepareFuzzySearch: (query: string) => (text: string) => {
        const needle = query.toLowerCase();
        const haystack = text.toLowerCase();
        const matches: Array<[number, number]> = [];
        let needleIndex = 0;
        for (
            let i = 0;
            i < haystack.length && needleIndex < needle.length;
            i++
        ) {
            if (haystack[i] === needle[needleIndex]) {
                matches.push([i, i + 1]);
                needleIndex += 1;
            }
        }
        return needleIndex === needle.length
            ? { score: text.length - query.length, matches }
            : null;
    },
    sortSearchResults: (results: Array<{ match: { score: number } }>): void => {
        results.sort((a, b) => a.match.score - b.match.score);
    },
}));

import {
    getValueSuggestions,
    invalidateAutocompleteCache,
    invalidateTagAutocompleteCache,
} from "ui/search/autocomplete-data";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSyncDataRevision.mockReturnValue(0);
    invalidateAutocompleteCache();
});

describe("search autocomplete cache", () => {
    test("caches values and coalesces concurrent loads", async () => {
        let resolveLoad: (values: string[]) => void = () => undefined;
        const pending = new Promise<string[]>((resolve) => {
            resolveLoad = resolve;
        });
        mocks.getTagNames.mockReturnValue(pending);

        const first = getValueSuggestions("tag", "");
        const second = getValueSuggestions("tag", "");

        expect(mocks.getTagNames).toHaveBeenCalledTimes(1);
        resolveLoad(["alpha"]);
        await expect(first).resolves.toEqual([{ value: "alpha" }]);
        await expect(second).resolves.toEqual([{ value: "alpha" }]);
        await expect(getValueSuggestions("tag", "")).resolves.toEqual([
            { value: "alpha" },
        ]);
        expect(mocks.getTagNames).toHaveBeenCalledTimes(1);
    });

    test("tag invalidation preserves other cached value lists", async () => {
        mocks.getTagNames.mockResolvedValue(["old-tag"]);
        mocks.getLibraryNames.mockResolvedValue(["My Library"]);

        await getValueSuggestions("tag", "");
        await getValueSuggestions("library", "");
        invalidateTagAutocompleteCache();

        await getValueSuggestions("tag", "");
        await getValueSuggestions("library", "");
        expect(mocks.getTagNames).toHaveBeenCalledTimes(2);
        expect(mocks.getLibraryNames).toHaveBeenCalledTimes(1);
    });

    test("an invalidated in-flight result cannot restore stale data", async () => {
        let resolveOld: (values: string[]) => void = () => undefined;
        const oldLoad = new Promise<string[]>((resolve) => {
            resolveOld = resolve;
        });
        mocks.getTagNames
            .mockReturnValueOnce(oldLoad)
            .mockResolvedValue(["new-tag"]);

        const oldRequest = getValueSuggestions("tag", "");
        invalidateTagAutocompleteCache();
        await expect(getValueSuggestions("tag", "")).resolves.toEqual([
            { value: "new-tag" },
        ]);

        resolveOld(["old-tag"]);
        await expect(oldRequest).resolves.toEqual([{ value: "old-tag" }]);
        await expect(getValueSuggestions("tag", "")).resolves.toEqual([
            { value: "new-tag" },
        ]);
        expect(mocks.getTagNames).toHaveBeenCalledTimes(2);
    });

    test("a completed sync revision invalidates all cached values", async () => {
        mocks.getTagNames
            .mockResolvedValueOnce(["old-tag"])
            .mockResolvedValueOnce(["new-tag"]);

        await expect(getValueSuggestions("tag", "")).resolves.toEqual([
            { value: "old-tag" },
        ]);
        mocks.getSyncDataRevision.mockReturnValue(1);
        await expect(getValueSuggestions("tag", "")).resolves.toEqual([
            { value: "new-tag" },
        ]);
        expect(mocks.getTagNames).toHaveBeenCalledTimes(2);
    });

    test("fuzzy-ranks tag values and returns highlight metadata", async () => {
        mocks.getTagNames.mockResolvedValue([
            "draft",
            "transformer",
            "transfer-learning",
        ]);

        const suggestions = await getValueSuggestions("tag", "tfo");

        expect(suggestions.map((suggestion) => suggestion.value)).toEqual([
            "transformer",
        ]);
        expect(suggestions[0]?.match?.matches).toEqual([
            [0, 1],
            [5, 6],
            [6, 7],
        ]);
    });
});
