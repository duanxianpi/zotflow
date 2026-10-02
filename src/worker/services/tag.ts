import { db } from "db/db";
import { mutateItem } from "db/mutate";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { IParentProxy } from "bridge/types";
import type { ZotFlowSettings } from "settings/types";

/** A single tag entry, mirroring Zotero's `{ tag, type? }` shape. */
export interface TagInput {
    tag: string;
    type?: number;
}

/**
 * Worker-side service owning all tag operations across libraries.
 *
 * Tags are not standalone entities in Zotero — they live in each item's
 * `raw.data.tags` array. This service centralizes reading/writing them so the
 * upcoming features (global rename, delete-everywhere, tag browsing) have a
 * single home.
 */
export class TagService {
    constructor(
        public settings: ZotFlowSettings,
        private parentHost: IParentProxy,
    ) {}

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /**
     * Return all distinct tag names known to the database, for autocomplete.
     *
     * Uses the `*searchTags` multi-entry index directly (`uniqueKeys`), so it
     * never deserializes item records — cost is independent of library size,
     * which is why no caching is needed. Spans all libraries (suggesting a tag
     * that exists elsewhere is harmless for autocomplete).
     */
    async getTagNames(): Promise<string[]> {
        const keys = (await db.items
            .orderBy("searchTags")
            .uniqueKeys()) as string[];
        return keys.sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: "accent" }),
        );
    }

    /**
     * Replace the full tag list of a single item.
     *
     * Tags live in `item.raw.data.tags`; `mutateItem` keeps the derived
     * `searchTags` index in sync and marks the item dirty so the existing sync
     * engine pushes the change back to Zotero. Automatic tags (`type: 1`) are
     * preserved; user-added tags default to manual (`type` 0).
     */
    async setItemTags(
        libraryID: number,
        key: string,
        tags: TagInput[],
    ): Promise<void> {
        // Normalize: trim, drop empties, de-duplicate (Zotero tags are
        // case-sensitive, so dedupe on the exact string).
        const seen = new Set<string>();
        const cleanTags: TagInput[] = [];
        for (const t of tags) {
            const name = (t?.tag ?? "").trim();
            if (!name || seen.has(name)) continue;
            seen.add(name);
            const entry: TagInput = { tag: name };
            if (t.type === 1) entry.type = 1; // preserve automatic tags
            cleanTags.push(entry);
        }

        const updated = await mutateItem(libraryID, key, (data) => {
            data.tags = cleanTags;
        });
        if (!updated) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "TagService",
                `Item not found: ${libraryID}/${key}`,
            );
        }
    }
}
