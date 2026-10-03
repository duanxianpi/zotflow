import React, {
    useState,
    useRef,
    useLayoutEffect,
    useEffect,
    useMemo,
    useCallback,
    createContext,
} from "react";
import { Menu } from "obsidian";
import { NodeApi, Tree } from "react-arborist";
import { workerBridge } from "bridge";
import { ObsidianIcon } from "../ObsidianIcon";
import { NodeItem, INDENT_SIZE } from "./Node";
import { TreeSearchSuggest } from "./search-suggest";
import { services } from "services/services";

import type { EntityMap, TreeTransferPayload } from "worker/services/tree-view";
import type { TreeChange } from "services/event-hub";
import type { CollectionSortOrder, ItemSortOrder } from "settings/types";
import { fireAndForgetIn } from "utils/fire-and-forget";

const ff = fireAndForgetIn("TreeView");

/* ================================================================ */
/*  Types                                                          */
/* ================================================================ */

/** Tree node representing a library, collection, item, or spacer in the tree view. */
export type ViewNode = {
    id: string;
    parent?: string | null;
    children: ViewNode[];
    name: string;
    itemType: string;
    contentType?: string;
    libraryID: number;
    libraryName: string;
    citationKey?: string;
    key: string;
    nodeType: "library" | "collection" | "item" | "spacer";
    dateAdded?: string;
    dateModified?: string;
    syncStatus?: string;
    tags?: string[];
};

/** Shared search state provided to tree nodes for highlighting matched text. */
export interface TreeSearchState {
    matchKeys: Set<string>;
    freeTokens: string[];
}

export const TreeSearchContext = createContext<TreeSearchState>({
    matchKeys: new Set<string>(),
    freeTokens: [],
});

function rebuildTreeFromWorker(payload: TreeTransferPayload): ViewNode[] {
    const { entities, topology } = payload;

    // Lookup table for quick parent node lookup
    const nodeMap = new Map<string, ViewNode>();

    // Root nodes collection
    const roots: ViewNode[] = [];

    // Single pass
    for (let i = 0; i < topology.length; i++) {
        const nodeRef = topology[i]!;

        // Get metadata O(1)
        const entity = entities[nodeRef.key];

        // If data is missing (extreme case), skip
        if (!entity) continue;

        // Create complete ViewNode object
        const node: ViewNode = {
            id: nodeRef.id,
            key: nodeRef.key,
            parent: nodeRef.parentId,
            nodeType: nodeRef.nodeType,

            // Mix in Entity data
            name: entity.name,
            itemType: entity.itemType,
            libraryID: entity.libraryID,
            libraryName: entity.libraryName,
            citationKey: entity.citationKey,
            contentType: entity.contentType,
            dateAdded: entity.dateAdded,
            dateModified: entity.dateModified,
            syncStatus: entity.syncStatus,
            tags: entity.tags,

            // Initialize Children
            children: [],
        };

        // Store in Map
        nodeMap.set(node.id, node);

        // Mount logic
        if (nodeRef.parentId) {
            // Since Worker is DFS generated, when processing child nodes, parent node must already be in Map
            const parent = nodeMap.get(nodeRef.parentId);
            if (parent) {
                parent.children.push(node);
            } else {
                // If parent node not found (possible data consistency issue), handle gracefully by placing at root
                roots.push(node);
            }
        } else {
            // No parentId means root node (Libraries)
            roots.push(node);
        }
    }

    // Add 1 spacer nodes at the bottom
    roots.push({
        id: `spacer`,
        key: `spacer`,
        parent: null,
        nodeType: "spacer",
        name: "",
        itemType: "",
        libraryName: "",
        libraryID: 0,
        children: [],
    });

    return roots;
}

/* ================================================================ */
/*  Sorting                                                        */
/* ================================================================ */

const COLLECTION_SORT_OPTIONS: {
    label: string;
    value: CollectionSortOrder;
}[] = [
    { label: "Name (A to Z)", value: "name-asc" },
    { label: "Name (Z to A)", value: "name-desc" },
];

const ITEM_SORT_OPTIONS: { label: string; value: ItemSortOrder }[] = [
    { label: "Title (A to Z)", value: "title-asc" },
    { label: "Title (Z to A)", value: "title-desc" },
    { label: "Modified time (new to old)", value: "modified-new" },
    { label: "Modified time (old to new)", value: "modified-old" },
    { label: "Created time (new to old)", value: "added-new" },
    { label: "Created time (old to new)", value: "added-old" },
];

/** Compare two strings using natural sort (numeric-aware, case-insensitive). */
function cmpStr(a: string, b: string): number {
    return a.localeCompare(b, undefined, {
        sensitivity: "base",
        numeric: true,
    });
}

/** Compare two ISO date strings. Missing dates sort last. */
function cmpDate(a: string | undefined, b: string | undefined): number {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Recursively sort every `children` array in-place-free (returns new arrays).
 * Libraries (roots) keep their original order.
 * Within a parent: collections always appear before items, then each group is
 * sorted independently by the matching sort order.
 * Spacers always stay at the end.
 */
function sortTree(
    roots: ViewNode[],
    collectionSort: CollectionSortOrder,
    itemSort: ItemSortOrder,
): ViewNode[] {
    const sortChildren = (nodes: ViewNode[]): ViewNode[] => {
        // Partition into collections, items, and spacers
        const collections: ViewNode[] = [];
        const items: ViewNode[] = [];
        const spacers: ViewNode[] = [];

        for (const n of nodes) {
            if (n.nodeType === "spacer") spacers.push(n);
            else if (n.nodeType === "collection") collections.push(n);
            else items.push(n);
        }

        // Sort collections by name
        const colDir = collectionSort === "name-asc" ? 1 : -1;
        collections.sort((a, b) => colDir * cmpStr(a.name, b.name));

        // Sort items
        items.sort((a, b) => {
            switch (itemSort) {
                case "title-asc":
                    return cmpStr(a.name, b.name);
                case "title-desc":
                    return -cmpStr(a.name, b.name);
                case "modified-new":
                    return -cmpDate(a.dateModified, b.dateModified);
                case "modified-old":
                    return cmpDate(a.dateModified, b.dateModified);
                case "added-new":
                    return -cmpDate(a.dateAdded, b.dateAdded);
                case "added-old":
                    return cmpDate(a.dateAdded, b.dateAdded);
                default:
                    return 0;
            }
        });

        // Recurse into children (collections have child collections + items)
        const sorted = [...collections, ...items, ...spacers];
        return sorted.map((node) => {
            if (node.children.length === 0) return node;
            return { ...node, children: sortChildren(node.children) };
        });
    };

    // For root level: keep library order, but sort each library's children
    return roots.map((root) => {
        if (root.nodeType === "spacer" || root.children.length === 0)
            return root;
        return { ...root, children: sortChildren(root.children) };
    });
}

/** Root React component for the Zotero library tree with search, refresh, and virtual scrolling. */
export const ZotFlowTree = () => {
    const [rawData, setRawData] = useState<TreeTransferPayload | null>(null);
    const [term, setTerm] = useState("");
    const [searchState, setSearchState] = useState<{
        term: string;
        matchKeys: Set<string>;
        freeTokens: string[];
    }>({ term: "", matchKeys: new Set<string>(), freeTokens: [] });
    const [loading, setLoading] = useState(true);
    const containerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [dims, setDims] = useState({ w: 300, h: 500 });

    // Sort state — initialised from persisted settings
    const [collectionSort, setCollectionSort] = useState<CollectionSortOrder>(
        () => services.settings.treeCollectionSort,
    );
    const [itemSort, setItemSort] = useState<ItemSortOrder>(
        () => services.settings.treeItemSort,
    );

    // Resize Observer
    useLayoutEffect(() => {
        if (!containerRef.current) return;
        const obs = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) {
                setDims({
                    w: entry.contentRect.width,
                    h: entry.contentRect.height,
                });
            }
        });
        obs.observe(containerRef.current);
        return () => obs.disconnect();
    }, []);

    // Attach operator/value autocomplete to the search input (once).
    useEffect(() => {
        if (!searchInputRef.current) return;
        new TreeSearchSuggest(services.app, searchInputRef.current, (value) =>
            setTerm(value),
        );
    }, []);

    useEffect(() => {
        const loadTree = async () => {
            setLoading(true);
            try {
                const flat = await workerBridge.treeView.getOptimizedTree();
                setRawData(flat);
            } catch (err) {
                services.logService.error(
                    "Failed to load tree",
                    "TreeView",
                    err,
                );
            } finally {
                setLoading(false);
            }
        };

        void loadTree();
    }, []);

    // Debounced worker-side fuzzy search. Results (matched entity keys +
    // highlight tokens) are cached and applied synchronously by `matchNode`.
    useEffect(() => {
        const trimmed = term.trim();
        if (!trimmed) {
            setSearchState({
                term: "",
                matchKeys: new Set<string>(),
                freeTokens: [],
            });
            return;
        }

        let cancelled = false;
        const handle = window.setTimeout(() => {
            void (async () => {
                try {
                    const res = await workerBridge.treeView.searchTree(trimmed);
                    if (!cancelled) {
                        setSearchState({
                            term: trimmed,
                            matchKeys: new Set(res.matchedKeys),
                            freeTokens: res.freeTokens,
                        });
                    }
                } catch (err) {
                    services.logService.error(
                        "Tree search failed",
                        "TreeView",
                        err,
                    );
                }
            })();
        }, 150);

        return () => {
            cancelled = true;
            window.clearTimeout(handle);
        };
    }, [term]);

    // Refresh tree data when the worker reports a change: patch the items
    // named, or rebuild. At most one refresh runs; changes arriving
    // meanwhile are folded into the next one.
    useEffect(() => {
        let running = false;
        let pending: TreeChange[] | "full" | null = null;

        const refresh = async (change: TreeChange[] | "full") => {
            if (change !== "full") {
                const patches = await Promise.all(
                    change.map((c) =>
                        workerBridge.treeView.patchEntities(c.libraryID, c.keys),
                    ),
                );
                if (patches.every((p) => p !== null)) {
                    const merged = Object.assign({}, ...patches) as EntityMap;
                    setRawData((prev) =>
                        prev
                            ? { ...prev, entities: { ...prev.entities, ...merged } }
                            : prev,
                    );
                    return;
                }
            }
            await workerBridge.treeView.refreshTree();
            const flat = await workerBridge.treeView.getOptimizedTree();
            setRawData(flat);
        };

        const onChange = (change?: TreeChange) => {
            if (!change || pending === "full") pending = "full";
            else pending = [...(pending ?? []), change];
            if (running) return;
            running = true;
            void (async () => {
                while (pending) {
                    const next = pending;
                    pending = null;
                    try {
                        await refresh(next);
                    } catch (err) {
                        services.logService.error(
                            "Failed to refresh tree",
                            "TreeView",
                            err,
                        );
                    }
                }
                running = false;
            })();
        };

        return services.eventHub.treeChanged.subscribe(onChange);
    }, []);

    // Prevent react-dnd from interfering with global events
    const voidElement = useMemo(() => createDiv(), []);

    const handleRefresh = async () => {
        try {
            await workerBridge.treeView.refreshTree();
            const flat = await workerBridge.treeView.getOptimizedTree();
            setRawData(flat);
        } catch (err) {
            services.logService.error(
                "Failed to refresh tree",
                "TreeView",
                err,
            );
        }
    };

    /** Open the Obsidian-native sort menu with collection and item sort options. */
    const handleSortMenu = useCallback(
        (e: React.MouseEvent) => {
            const menu = new Menu();

            for (const opt of COLLECTION_SORT_OPTIONS) {
                menu.addItem((item) =>
                    item
                        .setTitle(`Collection: ${opt.label}`)
                        .setChecked(collectionSort === opt.value)
                        .setSection("collections")
                        .onClick(() => {
                            setCollectionSort(opt.value);
                            services.settings.treeCollectionSort = opt.value;
                            ff(services.saveSettings(), "Failed to save settings");
                        }),
                );
            }

            for (const opt of ITEM_SORT_OPTIONS) {
                menu.addItem((item) =>
                    item
                        .setTitle(`Item: ${opt.label}`)
                        .setChecked(itemSort === opt.value)
                        .setSection("items")
                        .onClick(() => {
                            setItemSort(opt.value);
                            services.settings.treeItemSort = opt.value;
                            ff(services.saveSettings(), "Failed to save settings");
                        }),
                );
            }

            menu.showAtMouseEvent(e.nativeEvent);
        },
        [collectionSort, itemSort],
    );

    const treeData = useMemo(() => {
        if (!rawData) return [];
        const tree = rebuildTreeFromWorker(rawData);
        return sortTree(tree, collectionSort, itemSort);
    }, [rawData, collectionSort, itemSort]);

    // The matching logic for the tree view:
    // - All children shown
    // - Leaf matches balloon into attachments
    // - Siblings stay collapsed
    const effectiveMatchKeys = useMemo(() => {
        const base = searchState.matchKeys;
        if (base.size === 0) return base;

        const result = new Set(base);
        const visit = (nodes: ViewNode[]) => {
            for (const n of nodes) {
                if (n.children.length === 0) continue;
                if (n.nodeType === "item") {
                    const selfMatched = base.has(n.key);
                    const childMatched = n.children.some((c) =>
                        base.has(c.key),
                    );
                    if (selfMatched || childMatched) {
                        result.add(n.key);
                        for (const c of n.children) result.add(c.key);
                    }
                }
                visit(n.children);
            }
        };
        visit(treeData);
        return result;
    }, [treeData, searchState.matchKeys]);

    const handleSearch = useCallback(
        (node: NodeApi<ViewNode>): boolean => {
            if (effectiveMatchKeys.size === 0) return false;
            return effectiveMatchKeys.has(node.data.key);
        },
        [effectiveMatchKeys],
    );

    return (
        <div className="zotflow-tree-view-layout">
            <div className="zotflow-tree-view-header">
                <div className="search-input-container global-search-input-container">
                    <input
                        ref={searchInputRef}
                        placeholder="Search..."
                        type="search"
                        value={term}
                        className="zotflow-tree-view-search-input"
                        onChange={(e) => setTerm(e.target.value)}
                    />
                    <div
                        aria-label="Clear search"
                        onClick={() => setTerm("")}
                    ></div>
                </div>
                <div
                    className="clickable-icon"
                    aria-label="Change sort order"
                    onClick={handleSortMenu}
                >
                    <ObsidianIcon icon="arrow-up-narrow-wide" />
                </div>
                <div
                    className="clickable-icon"
                    aria-label="Refresh Tree"
                    onClick={() => void handleRefresh()}
                >
                    <ObsidianIcon icon="rotate-cw" />
                </div>
            </div>
            <div className="zotflow-tree-view-container" ref={containerRef}>
                {loading && (
                    <div
                        style={{
                            position: "absolute",
                            top: "50%",
                            left: "50%",
                            transform: "translate(-50%, -50%)",
                            color: "var(--icon-color)",
                        }}
                    >
                        <ObsidianIcon icon="loader" className="zotflow-spin" />
                    </div>
                )}
                {!loading && (
                    <TreeSearchContext.Provider
                        value={{
                            matchKeys: searchState.matchKeys,
                            freeTokens: searchState.freeTokens,
                        }}
                    >
                        <Tree
                            data={treeData}
                            width={dims.w}
                            height={dims.h}
                            rowHeight={28}
                            indent={INDENT_SIZE}
                            searchTerm={searchState.term}
                            searchMatch={handleSearch}
                            openByDefault={false}
                            disableDrag={true}
                            disableDrop={true}
                            disableMultiSelection={true}
                            dndRootElement={voidElement}
                        >
                            {NodeItem}
                        </Tree>
                    </TreeSearchContext.Provider>
                )}
            </div>
        </div>
    );
};
