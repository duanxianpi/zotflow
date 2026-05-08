/** Maps string IDs to entity metadata (name, itemType, libraryID, etc.). */
export type EntityMap = Record<
    string,
    {
        name: string;
        itemType: string;
        libraryID: number;
        libraryName: string;
        citationKey?: string;
        contentType?: string;
        dateAdded?: string;
        dateModified?: string;
        syncStatus?: string;
    }
>;

/** A node in the flattened tree topology (library, collection, or item). */
export type TopologyNode = {
    id: string; // UI Unique ID
    key: string; // Zotero Key (used to query entities)
    parentId: string | null; // Parent UI ID
    nodeType: "library" | "collection" | "item";
};

/** Wire payload sent from the worker to the main thread for rendering the tree view. */
export type TreeTransferPayload = {
    entities: EntityMap;
    topology: TopologyNode[];
};

import { db, getCombinations } from "db/db";
import type { AnyIDBZoteroItem, IDBZoteroCollection } from "types/db-schema";
import type { ZotFlowSettings } from "settings/types";
import type { IParentProxy } from "bridge/types";
import type { LibraryService } from "./library";
import { Zotero_Item_Types } from "types/zotero-item-const";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

export type TreeItemFilter = (
    item: AnyIDBZoteroItem,
    ctx: { hasNotesAccess: boolean },
) => boolean;

/** Builds the flattened tree topology (libraries → collections → items) for the sidebar tree view. */
export class TreeViewService {
    private treeTransferPayload: TreeTransferPayload | null;
    private itemFilter?: TreeItemFilter;

    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        private library: LibraryService,
    ) {
        this.treeTransferPayload = null;
    }

    get tree() {
        return this.getOptimizedTree();
    }

    public updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    public async refreshTree() {
        this.treeTransferPayload = null;
        await this.getOptimizedTree();
    }

    /**
     * Optional custom filter hook for tree items.
     * Useful when callers want additional filtering rules in addition to
     * the built-in permission checks.
     */
    public setItemFilter(filter?: TreeItemFilter) {
        this.itemFilter = filter;
        this.treeTransferPayload = null;
    }

    public async getOptimizedTree(): Promise<TreeTransferPayload> {
        if (this.treeTransferPayload) {
            return this.treeTransferPayload;
        }

        if (!this.settings.zoteroapikey) {
            throw new ZotFlowError(
                ZotFlowErrorCode.CONFIG_MISSING,
                "TreeViewService",
                "API Key is missing in settings",
            );
        }

        let keyInfo;
        try {
            keyInfo = await db.keys.get(this.settings.zoteroapikey);
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.DB_OPEN_FAILED,
                "TreeViewService",
                "Failed to read Key DB",
            );
        }

        if (!keyInfo) {
            throw new ZotFlowError(
                ZotFlowErrorCode.AUTH_INVALID,
                "TreeViewService",
                "Invalid Zotero API key (not found in DB).",
                { api_key: this.settings.zoteroapikey },
            );
        }

        try {
            const filteredLibraryIDs = await this.library.getActiveLibraryIDs();
            const notesAccessEntries = await Promise.all(
                filteredLibraryIDs.map(
                    async (id) =>
                        [id, await this.library.hasNotesAccess(id)] as const,
                ),
            );
            const hasNotesAccessByLibrary = new Map<number, boolean>(
                notesAccessEntries,
            );

            // Valid Item Types
            const validItemTypes = Zotero_Item_Types.filter(
                (t) => t !== "annotation",
            );

            // Fetch all data (DB Operations)
            const [libraries, allCollections, allItems] = await Promise.all([
                db.libraries.where("id").anyOf(filteredLibraryIDs).toArray(),
                db.collections
                    .where(["libraryID", "trashed"])
                    .anyOf(getCombinations([filteredLibraryIDs, [0]]))
                    .toArray(),
                db.items
                    .where(["libraryID", "itemType", "trashed"])
                    .anyOf(
                        getCombinations([
                            filteredLibraryIDs,
                            validItemTypes,
                            [0],
                        ]),
                    )
                    .filter((i) => i.trashed === 0)
                    .toArray(),
            ]);

            // Index Construction (CPU Intensive)
            const collectionsByLib = new Map<number, IDBZoteroCollection[]>();
            allCollections.forEach((c) => {
                const list = collectionsByLib.get(c.libraryID) || [];
                list.push(c);
                collectionsByLib.set(c.libraryID, list);
            });

            // Group Items
            const itemsByCollection = new Map<string, AnyIDBZoteroItem[]>();
            const unfiledItemsByLib = new Map<number, AnyIDBZoteroItem[]>();
            const subItemsByParent = new Map<string, AnyIDBZoteroItem[]>();

            allItems.forEach((item) => {
                const hasNotesAccess =
                    hasNotesAccessByLibrary.get(item.libraryID) ?? false;
                if (item.itemType === "note" && !hasNotesAccess) {
                    return;
                }
                if (
                    this.itemFilter &&
                    !this.itemFilter(item, { hasNotesAccess })
                ) {
                    return;
                }

                // Handle Sub-items
                if (["attachment", "note"].includes(item.itemType)) {
                    if (item.parentItem) {
                        const list =
                            subItemsByParent.get(item.parentItem) || [];
                        list.push(item);
                        subItemsByParent.set(item.parentItem, list);
                        return; // It is a sub-item, not processed separately
                    }
                }

                // Handle Top-level Item
                const isInCollection =
                    item.collections && item.collections.length > 0;

                if (isInCollection) {
                    item.collections.forEach((colKey) => {
                        const list = itemsByCollection.get(colKey) || [];
                        list.push(item);
                        itemsByCollection.set(colKey, list);
                    });
                } else {
                    // Unfiled
                    const list = unfiledItemsByLib.get(item.libraryID) || [];
                    list.push(item);
                    unfiledItemsByLib.set(item.libraryID, list);
                }
            });

            // Build Optimized Tree

            const entities: EntityMap = {};
            const topology: TopologyNode[] = [];

            // Helper: Register Entity Data (De-duplication)
            const registerEntity = (
                key: string,
                name: string,
                itemType: string,
                libraryID: number,
                libraryName: string,
                citationKey?: string,
                contentType?: string,
                dateAdded?: string,
                dateModified?: string,
                syncStatus?: string,
            ) => {
                // Only register when the key is not registered
                if (!entities[key]) {
                    entities[key] = {
                        name,
                        itemType,
                        libraryID,
                        libraryName,
                        citationKey,
                        contentType,
                        dateAdded,
                        dateModified,
                        syncStatus,
                    };
                }
            };

            // Recursive function: Process Item (and its attachments)
            const processItem = (item: AnyIDBZoteroItem, parentId: string) => {
                const itemId = `${parentId}-i-${item.key}`; // Construct unique UI ID
                const attachments = subItemsByParent.get(item.key) || [];

                // Find lib name - Potential crash point if DB is inconsistent
                const libObj = libraries.find(
                    (lib) => lib.id === item.libraryID,
                );
                const libName = libObj ? libObj.name : "Unknown Library";

                if (item.itemType === "attachment") {
                    registerEntity(
                        item.key,
                        item.title,
                        item.itemType,
                        item.libraryID,
                        libName,
                        item.raw.data.contentType,
                        undefined,
                        item.dateAdded,
                        item.dateModified,
                        item.syncStatus,
                    );
                } else {
                    registerEntity(
                        item.key,
                        item.title,
                        item.itemType,
                        item.libraryID,
                        libName,
                        item.citationKey,
                        undefined,
                        item.dateAdded,
                        item.dateModified,
                        item.syncStatus,
                    );
                }

                // Push skeleton
                topology.push({
                    id: itemId,
                    key: item.key,
                    parentId: parentId,
                    nodeType: "item",
                });

                // Process attachments
                attachments.forEach((att) => {
                    const attId = `${itemId}-att-${att.key}`;
                    // Attachment name logic
                    let attName = att.title;
                    let attContentType;
                    if (att.itemType === "attachment") {
                        attContentType = att.raw.data.contentType;
                    }

                    registerEntity(
                        att.key,
                        attName || "Untitled",
                        att.itemType,
                        att.libraryID,
                        libName,
                        "",
                        attContentType,
                        undefined,
                        undefined,
                        att.syncStatus,
                    );

                    topology.push({
                        id: attId,
                        key: att.key,
                        parentId: itemId,
                        nodeType: "item",
                    });
                });
            };

            // Recursive function: Process Collection
            const processCollection = (
                col: IDBZoteroCollection,
                parentId: string,
                libCols: IDBZoteroCollection[],
            ) => {
                const colId = `col-${col.key}`;
                const childCols = libCols.filter(
                    (c) => c.parentCollection === col.key,
                );
                const childItems = itemsByCollection.get(col.key) || [];

                const libObj = libraries.find(
                    (lib) => lib.id === col.libraryID,
                );
                const libName = libObj ? libObj.name : "Unknown Library";

                registerEntity(
                    col.key,
                    col.name,
                    "collection",
                    col.libraryID,
                    libName,
                );

                topology.push({
                    id: colId,
                    key: col.key,
                    parentId: parentId,
                    nodeType: "collection",
                });

                // Recursive call (Pre-order)
                childCols.forEach((c) => processCollection(c, colId, libCols));
                childItems.forEach((i) => processItem(i, colId));
            };

            // Entry: Iterate Libraries
            libraries.forEach((lib) => {
                const libId = `lib-${lib.id}`;
                const libCols = collectionsByLib.get(lib.id) || [];
                const topCols = libCols.filter((c) => !c.parentCollection);
                const unfiled = unfiledItemsByLib.get(lib.id) || [];

                registerEntity(
                    lib.id.toString(),
                    lib.name,
                    "library",
                    lib.id,
                    lib.name,
                );

                topology.push({
                    id: libId,
                    key: lib.id.toString(),
                    parentId: null,
                    nodeType: "library",
                });

                topCols.forEach((c) => processCollection(c, libId, libCols));
                unfiled.forEach((i) => processItem(i, libId));
            });

            this.treeTransferPayload = { entities, topology };
            return this.treeTransferPayload;
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.PARSE_ERROR,
                "TreeViewService",
                "Failed to build library tree",
            );
        }
    }
}
