import { db, getCombinations } from "db/db";
import { Zotero_Item_Types } from "types/zotero-item-const";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type { IParentProxy } from "bridge/types";
import type { LibraryService } from "./library";
import type {
    AnyIDBZoteroItem,
    IDBZoteroItem,
    IDBZoteroCollection,
} from "types/db-schema";
import type { AttachmentData } from "types/zotero-item";
import type { ZotFlowSettings } from "settings/types";

/**
 * Worker-side helper service for general-purpose DB operations that
 * don't belong to a domain-specific service.
 */
export class DbHelperService {
    constructor(
        public settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        private library: LibraryService,
    ) {}

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /**
     * Get filtered library IDs based on settings and API key access.
     */
    async getFilteredLibraryIDs(): Promise<number[]> {
        if (!this.settings.zoteroapikey) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "DbHelperService",
                "API Key is missing in settings",
            );
        }
        return this.library.getActiveLibraryIDs();
    }

    /**
     * Look up any item by library + key.
     * Returns `undefined` if the item doesn't exist.
     */
    async getItem(
        libraryID: number,
        itemKey: string,
    ): Promise<AnyIDBZoteroItem | undefined> {
        return await db.items.get([libraryID, itemKey]);
    }

    /**
     * Look up an attachment item by library + key.
     * Returns `undefined` if the item doesn't exist or isn't an attachment.
     */
    async getAttachmentItem(
        libraryID: number,
        itemKey: string,
    ): Promise<IDBZoteroItem<AttachmentData> | undefined> {
        const item = await db.items.get([libraryID, itemKey]);
        if (!item || item.itemType !== "attachment") return undefined;
        return item as IDBZoteroItem<AttachmentData>;
    }

    /**
     * Get recently accessed items.
     */
    async getRecentItems(limit: number): Promise<AnyIDBZoteroItem[]> {
        const libraryIDs = await this.getFilteredLibraryIDs();
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
        const libraryIDs = await this.getFilteredLibraryIDs();
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
     * Search items by query string.
     */
    async searchItems(
        query: string,
        limit: number,
    ): Promise<AnyIDBZoteroItem[]> {
        const libraryIDs = await this.getFilteredLibraryIDs();
        const lowerQuery = query.toLowerCase();
        const isValidTopLevel = (type: string) =>
            !["note", "annotation"].includes(type);
        const validTopLevelTypeList = Zotero_Item_Types.filter((type) =>
            isValidTopLevel(type),
        );

        return await db.items
            .where(["libraryID", "itemType", "trashed"])
            .anyOf(getCombinations([libraryIDs, validTopLevelTypeList, [0]]))
            .filter((item: AnyIDBZoteroItem) => {
                if (item.parentItem) return false;
                const titleMatch = (item.title || "")
                    .toLowerCase()
                    .includes(lowerQuery);
                const creatorMatch = (item.searchCreators || []).some((c) =>
                    c.toLowerCase().includes(lowerQuery),
                );
                const tagMatch = (item.searchTags || []).some((t) =>
                    t.toLowerCase().includes(lowerQuery),
                );

                return titleMatch || creatorMatch || tagMatch;
            })
            .limit(limit)
            .toArray();
    }

    /**
     * Update an item's access timestamp.
     * If the item is an attachment, also updates the parent item's timestamp.
     */
    async updateLastAccessed(libraryID: number, key: string): Promise<void> {
        const timestamp = new Date().toISOString();
        const item = await db.items.get([libraryID, key]);

        if (item) {
            await db.items.update([libraryID, key], {
                lastAccessedAt: timestamp,
            });

            // If it's a child item (e.g. attachment), also update parent
            if (item.parentItem) {
                await db.items.update([libraryID, item.parentItem], {
                    lastAccessedAt: timestamp,
                });
            }
        }
    }

    /**
     * Get paths (library / collection / ...) for a batch of items.
     * Optimized with Dexie's bulkGet and Level-by-Level Ancestor Resolution.
     */
    async getItemPaths(
        items: { libraryID: number; key: string; collections: string[] }[],
    ): Promise<Record<string, string[]>> {
        const paths: Record<string, string[]> = {};
        if (!items || items.length === 0) return paths;

        // Get unique library IDs and prepare cache
        const uniqueLibIDs = [...new Set(items.map((i) => i.libraryID))];
        const libraryCache: Record<number, string> = {};

        // Dexie bulkGet returns results in the same order as the input array, undefined for missing entries
        const libs = await db.libraries.bulkGet(uniqueLibIDs);
        uniqueLibIDs.forEach((id, index) => {
            libraryCache[id] = libs[index]?.name || `Library ${id}`;
        });

        // Get all collections and prepare cache
        const collectionEntityCache: Record<
            string,
            IDBZoteroCollection | null
        > = {};
        let neededKeysMap = new Map<string, [number, string]>();

        // Collect all lowest-level leaf nodes
        for (const item of items) {
            if (!item.collections) continue;
            for (const collKey of item.collections) {
                if (collKey) {
                    const cacheKey = `${item.libraryID}:${collKey}`;
                    neededKeysMap.set(cacheKey, [item.libraryID, collKey]);
                }
            }
        }

        // BFS: pull parent nodes level by level until all needed nodes are fetched
        while (neededKeysMap.size > 0) {
            // Extract keys to fetch for this round
            const keysToFetch = Array.from(neededKeysMap.values());
            neededKeysMap.clear(); // Clear for next round

            // Fetch all nodes at this level
            const fetchedColls = await db.collections.bulkGet(keysToFetch);

            for (const [i, [libID, collKey]] of keysToFetch.entries()) {
                const cacheKey = `${libID}:${collKey}`;
                const coll = fetchedColls[i];

                // Write to entity cache
                collectionEntityCache[cacheKey] = coll || null;

                // If this node has a parent and it's not in cache, add to next round
                if (coll && coll.parentCollection) {
                    const parentCacheKey = `${libID}:${coll.parentCollection}`;
                    if (
                        collectionEntityCache[parentCacheKey] === undefined &&
                        !neededKeysMap.has(parentCacheKey)
                    ) {
                        neededKeysMap.set(parentCacheKey, [
                            libID,
                            coll.parentCollection,
                        ]);
                    }
                }
            }
        }

        // Build paths in memory
        const collectionPathCache: Record<string, string> = {};

        for (const item of items) {
            const libID = item.libraryID;
            const libName = libraryCache[libID];
            const allCollPaths: string[] = [];

            if (item.collections && item.collections.length > 0) {
                for (const collKey of item.collections) {
                    if (!collKey) continue;

                    const cacheKey = `${libID}:${collKey}`;

                    // If this path has been built by other items, reuse it
                    if (collectionPathCache[cacheKey]) {
                        allCollPaths.push(collectionPathCache[cacheKey]);
                        continue;
                    }

                    // Trace up (all needed nodes are guaranteed to be in collectionEntityCache)
                    const breadcrumbs: string[] = [];
                    let currentKey: string | undefined = collKey;
                    let foundParentPath = "";

                    while (currentKey) {
                        const stepCacheKey: string = `${libID}:${currentKey}`;

                        // If we've built this path before, reuse it
                        if (collectionPathCache[stepCacheKey]) {
                            foundParentPath = collectionPathCache[stepCacheKey];
                            break;
                        }

                        const coll: IDBZoteroCollection | null | undefined =
                            collectionEntityCache[stepCacheKey];
                        if (coll) {
                            breadcrumbs.unshift(coll.name);
                            currentKey = coll.parentCollection || undefined;
                        } else {
                            break;
                        }
                    }

                    const resolvedPath = foundParentPath
                        ? breadcrumbs.length > 0
                            ? `${foundParentPath}/${breadcrumbs.join("/")}`
                            : foundParentPath
                        : breadcrumbs.join("/");

                    collectionPathCache[cacheKey] = resolvedPath;
                    allCollPaths.push(resolvedPath);
                }
            }

            // Assemble the final path for this item
            const resultKey = `${libID}:${item.key}`;
            if (allCollPaths.length > 0) {
                paths[resultKey] = allCollPaths.map((p) => `${libName}/${p}/`);
            } else {
                paths[resultKey] = [`${libName}/`];
            }
        }

        return paths;
    }

    /**
     * Get attachments for a parent item.
     */
    async getAttachments(
        libraryID: number,
        parentKey: string,
    ): Promise<AnyIDBZoteroItem[]> {
        return await db.items
            .where(["libraryID", "parentItem", "itemType", "trashed"])
            .equals([libraryID, parentKey, "attachment", 0])
            .toArray();
    }

    /**
     * Get lightweight annotation candidates for the repair view.
     * Returns all annotations under a parent item (across all its attachments),
     * keyed by annotation key.
     *
     * If `libraryID` is omitted, the item is looked up by key alone across all
     * libraries (keys are unique in practice).
     */
    async getAnnotationCandidates(
        libraryID: number | null,
        parentKey: string,
    ): Promise<
        { key: string; pageLabel: string; text: string; type: string }[]
    > {
        // Resolve libraryID if not provided — try each filtered library
        let resolvedLibraryID = libraryID;
        if (resolvedLibraryID == null) {
            const libraryIDs = await this.getFilteredLibraryIDs();
            for (const lid of libraryIDs) {
                const match = await db.items.get([lid, parentKey]);
                if (match) {
                    resolvedLibraryID = lid;
                    break;
                }
            }
            if (resolvedLibraryID == null) return [];
        }

        // Get child attachments
        const attachments = await db.items
            .where(["libraryID", "parentItem", "itemType", "trashed"])
            .equals([resolvedLibraryID, parentKey, "attachment", 0])
            .toArray();

        // Also check if the item itself is a standalone attachment
        const item = await db.items.get([resolvedLibraryID, parentKey]);
        const attachmentKeys = attachments.map((a) => a.key);
        if (item?.itemType === "attachment") {
            attachmentKeys.push(parentKey);
        }

        // Get all annotations under these attachments
        const results: {
            key: string;
            pageLabel: string;
            text: string;
            type: string;
        }[] = [];

        for (const attKey of attachmentKeys) {
            const annotations = await db.items
                .where(["libraryID", "parentItem", "itemType", "trashed"])
                .equals([resolvedLibraryID, attKey, "annotation", 0])
                .toArray();

            for (const ann of annotations) {
                const data = ann.raw?.data as unknown as Record<
                    string,
                    unknown
                >;
                if (!data) continue;
                results.push({
                    key: ann.key,
                    pageLabel: (data.annotationPageLabel as string) ?? "",
                    text: (data.annotationText as string) ?? "",
                    type: (data.annotationType as string) ?? "",
                });
            }
        }

        return results;
    }
}
