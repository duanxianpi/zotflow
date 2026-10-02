import type { NodeRendererProps } from "react-arborist";
import { useContext } from "react";
import { Menu, setIcon } from "obsidian";
import type { ViewNode } from "./TreeView";
import { TreeSearchContext } from "./TreeView";
import { ObsidianIcon } from "../ObsidianIcon";
import {
    getAttachmentFileIcon,
    getAttachmentFileTag,
    getItemTypeIcon,
} from "ui/icons";
import { services } from "services/services";
import { invalidateTagAutocompleteCache } from "ui/search/autocomplete-data";
import { workerBridge } from "bridge";

import {
    openAttachment,
    openItemNote,
    openItemNoteInEditor,
    openItemNoteInSourceNote,
} from "utils/viewer";
import {
    ZOTFLOW_CITATION_MIME,
    type ZotFlowCitationPayload,
} from "ui/editor/citation-helper";
import { TagEditModal } from "ui/modals/tag-edit";
import { zoteroLibraryPrefix, zoteroSelectItemUri } from "utils/zotero-uri";
import { splitHighlight } from "utils/search-query";

/** Pixel indentation per tree depth level. */
export const INDENT_SIZE = 20;

const Highlight = ({ text, tokens }: { text: string; tokens: string[] }) => {
    if (!tokens.length) return <>{text}</>;
    const segments = splitHighlight(text, tokens);
    return (
        <>
            {segments.map((seg, i) =>
                seg.match ? (
                    <span key={i} className="search-result-file-matched-text">
                        {seg.text}
                    </span>
                ) : (
                    seg.text
                ),
            )}
        </>
    );
};

/** React component rendering a single tree node with icon, label, drag support, and context menu. */
export const NodeItem = ({ node, style }: NodeRendererProps<ViewNode>) => {
    const { nodeType, name, children } = node.data;
    const { freeTokens: searchTokens } = useContext(TreeSearchContext);
    const isTopLevelItem =
        nodeType === "item" &&
        (node.parent?.data.nodeType === "library" ||
            node.parent?.data.nodeType === "collection");
    const isFolder = children.length > 0;

    if (nodeType === "spacer") {
        return <div style={style} className="zotflow-spacer" />;
    }

    // Icon Selection using Obsidian icons
    let iconName = "";
    switch (nodeType) {
        case "library":
            iconName = "landmark";
            break;
        case "collection":
            iconName = "folder";
            break;
        case "item":
            if (node.data.itemType === "attachment") {
                iconName = getAttachmentFileIcon(node.data.contentType);
            } else {
                iconName = getItemTypeIcon(node.data.itemType);
            }
            break;
    }

    const handleArrowClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        node.toggle();
    };

    const openPrimaryTarget = () => {
        if (nodeType === "item" && node.data.itemType === "attachment") {
            void openAttachment(
                node.data.libraryID,
                node.data.key,
                services.app,
            ).catch((err) => {
                services.logService.error(
                    "Failed to open attachment",
                    "TreeView",
                    err,
                );
                services.notificationService.notify(
                    "error",
                    "Failed to open attachment.",
                );
            });
        } else if (nodeType === "item" && node.data.itemType === "note") {
            void openItemNote(
                node.data.libraryID,
                node.data.key,
                services.app,
            ).catch((err) => {
                services.logService.error(
                    "Failed to open note preview",
                    "TreeView",
                    err,
                );
                services.notificationService.notify(
                    "error",
                    "Failed to open note.",
                );
            });
        } else if (isTopLevelItem) {
            void workerBridge.libraryNote
                .openNote(node.data.libraryID, node.data.key, {
                    forceUpdateContent: true,
                    forceUpdateImages: false,
                })
                .catch((err) => {
                    services.logService.error(
                        "Failed to create/open note",
                        "TreeView",
                        err,
                    );
                    services.notificationService.notify(
                        "error",
                        "Failed to open source note.",
                    );
                });
        } else {
            node.toggle();
        }
    };

    // The setting is read at event time so toggling it applies live.
    const handleOnClick = (e: React.MouseEvent) => {
        if (!services.settings.treeSingleClickOpen) {
            node.toggle();
            return;
        }
        openPrimaryTarget();
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        if (services.settings.treeSingleClickOpen) return;
        e.stopPropagation();
        node.toggle();

        if (nodeType === "item" && node.data.itemType === "attachment") {
            void openAttachment(
                node.data.libraryID,
                node.data.key,
                services.app,
            );
        } else if (nodeType === "item" && node.data.itemType === "note") {
            void openItemNote(node.data.libraryID, node.data.key, services.app);
        }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        node.select();

        const menu = new Menu();

        if (nodeType === "collection" || nodeType === "library") {
            menu.addItem((item) => {
                item.setTitle("Create source note for all child items")
                    .setIcon("file-plus")
                    .onClick(async () => {
                        try {
                            const items: {
                                libraryID: number;
                                itemKey: string;
                            }[] = [];
                            const collectItems = (n: ViewNode) => {
                                if (
                                    n.nodeType === "item" &&
                                    n.itemType !== "note"
                                ) {
                                    items.push({
                                        libraryID: n.libraryID,
                                        itemKey: n.key,
                                    });
                                }
                                if (
                                    n.nodeType === "collection" ||
                                    n.nodeType === "library"
                                ) {
                                    n.children.forEach(collectItems);
                                }
                            };
                            node.data.children.forEach(collectItems);

                            const taskId =
                                await workerBridge.createBatchNoteTask(
                                    { items },
                                    {},
                                    false,
                                );
                            services.notificationService.notify(
                                "success",
                                `Batch note creation started (task ${taskId.slice(0, 8)})`,
                            );
                        } catch (err) {
                            services.logService.error(
                                "Failed to start batch note task",
                                "TreeView",
                                err,
                            );
                            services.notificationService.notify(
                                "error",
                                "Failed to start batch note creation.",
                            );
                        }
                    });
            });

            menu.addItem((item) => {
                item.setTitle("Extract anno images for all child items")
                    .setIcon("image")
                    .onClick(async () => {
                        try {
                            const items: {
                                libraryID: number;
                                itemKey: string;
                            }[] = [];
                            const collectItems = (n: ViewNode) => {
                                if (
                                    n.nodeType === "item" &&
                                    n.itemType !== "note"
                                ) {
                                    items.push({
                                        libraryID: n.libraryID,
                                        itemKey: n.key,
                                    });
                                }
                                if (
                                    n.nodeType === "collection" ||
                                    n.nodeType === "library"
                                ) {
                                    n.children.forEach(collectItems);
                                }
                            };
                            node.data.children.forEach(collectItems);
                            const taskId =
                                await workerBridge.createBatchExtractImagesTask(
                                    {
                                        items,
                                        forceUpdate: true,
                                    },
                                );
                            services.notificationService.notify(
                                "success",
                                `Batch image extraction started (task ${taskId.slice(0, 8)})`,
                            );
                        } catch (err) {
                            services.logService.error(
                                "Failed to start batch image extraction task",
                                "TreeView",
                                err,
                            );
                            services.notificationService.notify(
                                "error",
                                "Failed to start batch image extraction.",
                            );
                        }
                    });
            });
        } else if (isTopLevelItem && node.data.itemType !== "note") {
            menu.addItem((item) => {
                item.setTitle("Open source note")
                    .setIcon("file-badge")
                    .onClick(async () => {
                        try {
                            await workerBridge.libraryNote.openNote(
                                node.data.libraryID,
                                node.data.key,
                                {
                                    forceUpdateContent: true,
                                    forceUpdateImages: false,
                                },
                            );
                        } catch (err) {
                            services.logService.error(
                                "Failed to create/open note",
                                "TreeView",
                                err,
                            );
                            services.notificationService.notify(
                                "error",
                                "Failed to open source note.",
                            );
                        }
                    });
            });
            menu.addItem((item) => {
                item.setTitle("Extract annotation images")
                    .setIcon("image")
                    .onClick(async () => {
                        try {
                            // Open/update the note file (foreground)
                            await workerBridge.libraryNote.openNote(
                                node.data.libraryID,
                                node.data.key,
                                {
                                    forceUpdateContent: true,
                                    forceUpdateImages: false,
                                },
                            );
                            // Extract images as a background task
                            const taskId =
                                await workerBridge.createBatchExtractImagesTask(
                                    {
                                        items: [
                                            {
                                                libraryID: node.data.libraryID,
                                                itemKey: node.data.key,
                                            },
                                        ],
                                        forceUpdate: true,
                                    },
                                );
                            services.notificationService.notify(
                                "success",
                                `Image extraction started (task ${taskId.slice(0, 8)})`,
                            );
                        } catch (err) {
                            services.logService.error(
                                "Failed to start image extraction",
                                "TreeView",
                                err,
                            );
                            services.notificationService.notify(
                                "error",
                                "Failed to start image extraction.",
                            );
                        }
                    });
            });
            // Standalone attachments (no parent item) cannot have child notes
            // Hide the action when the library doesn't allow note edits
            // (read-only mode or API key lacks notes/write permission).
            if (
                node.data.itemType !== "attachment" &&
                services.libraryCache.canEditNotes(node.data.libraryID)
            ) {
                menu.addItem((item) => {
                    item.setTitle("Create child note")
                        .setIcon("sticky-note")
                        .onClick(async () => {
                            try {
                                const noteKey =
                                    await workerBridge.itemNote.createChildNote(
                                        node.data.libraryID,
                                        node.data.key,
                                    );
                                await workerBridge.libraryNote.triggerUpdate(
                                    node.data.libraryID,
                                    node.data.key,
                                    { forceUpdateContent: true },
                                );
                                await openItemNote(
                                    node.data.libraryID,
                                    noteKey,
                                    services.app,
                                );
                            } catch (err) {
                                services.logService.error(
                                    "Failed to create child note",
                                    "TreeView",
                                    err,
                                );
                                services.notificationService.notify(
                                    "error",
                                    "Failed to create child note.",
                                );
                            }
                        });
                });
            }
        } else if (nodeType === "item" && node.data.itemType === "note") {
            // A standalone note has no parent, so no source note to locate.
            if (!isTopLevelItem)
                menu.addItem((item) => {
                    item.setTitle("Locate in Source Note")
                        .setIcon("file-badge")
                        .onClick(async () => {
                            try {
                                const located = await openItemNoteInSourceNote(
                                    node.data.libraryID,
                                    node.data.key,
                                    services.app,
                                );
                                if (!located) {
                                    services.notificationService.notify(
                                        "warning",
                                        "No source note found for this note.",
                                    );
                                }
                            } catch (err) {
                                services.logService.error(
                                    "Failed to locate note in source note",
                                    "TreeView",
                                    err,
                                );
                                services.notificationService.notify(
                                    "error",
                                    "Failed to locate note in source note.",
                                );
                            }
                        });
                });
            menu.addItem((item) => {
                item.setTitle("Open in Note Editor (Experimental)")
                    .setIcon("pencil")
                    .onClick(async () => {
                        try {
                            await openItemNoteInEditor(
                                node.data.libraryID,
                                node.data.key,
                                services.app,
                            );
                        } catch (err) {
                            services.logService.error(
                                "Failed to open note in Note Editor",
                                "TreeView",
                                err,
                            );
                            services.notificationService.notify(
                                "error",
                                "Failed to open note in Note Editor.",
                            );
                        }
                    });
            });
            menu.addItem((item) => {
                item.setTitle("Delete note")
                    .setIcon("trash-2")
                    .onClick(async () => {
                        try {
                            // Capture the parent before deletion so we can
                            // re-render its source note afterwards.
                            const note = await workerBridge.dbHelper.getItem(
                                node.data.libraryID,
                                node.data.key,
                            );
                            const parentKey = note?.parentItem;
                            await workerBridge.itemNote.deleteNote(
                                node.data.libraryID,
                                node.data.key,
                            );
                            services.eventHub.treeChanged.emit();
                            // Re-render the parent source note so the deleted
                            // note's editable region is removed.
                            if (parentKey) {
                                await workerBridge.libraryNote.triggerUpdate(
                                    node.data.libraryID,
                                    parentKey,
                                    { forceUpdateContent: true },
                                );
                            }
                            services.notificationService.notify(
                                "success",
                                "Note deleted.",
                            );
                        } catch (err) {
                            services.logService.error(
                                "Failed to delete note",
                                "TreeView",
                                err,
                            );
                            services.notificationService.notify(
                                "error",
                                "Failed to delete note.",
                            );
                        }
                    });
            });
        }

        if (nodeType === "item") {
            menu.addItem((item) => {
                item.setTitle("Open in Zotero")
                    .setIcon("external-link")
                    .onClick(() => {
                        try {
                            const prefix = zoteroLibraryPrefix(
                                services.libraryCache.isGroup(
                                    node.data.libraryID,
                                ),
                                node.data.libraryID,
                            );
                            const url = zoteroSelectItemUri(
                                prefix,
                                node.data.key,
                            );
                            window.open(url, "_blank", "noopener,noreferrer");
                        } catch (err) {
                            services.logService.error(
                                "Failed to open item in Zotero",
                                "TreeView",
                                err,
                            );
                            services.notificationService.notify(
                                "error",
                                "Failed to open item in Zotero.",
                            );
                        }
                    });
            });
            menu.addItem((item) => {
                item.setTitle("Edit tags…")
                    .setIcon("tag")
                    .onClick(async () => {
                        try {
                            const dbItem = await workerBridge.dbHelper.getItem(
                                node.data.libraryID,
                                node.data.key,
                            );
                            const current = dbItem?.raw?.data?.tags ?? [];
                            const all = await workerBridge.tag.getTagNames();

                            new TagEditModal(services.app, {
                                itemTitle: node.data.name,
                                initialTags: current,
                                suggestions: all,
                                onSave: async (tags) => {
                                    await workerBridge.tag.setItemTags(
                                        node.data.libraryID,
                                        node.data.key,
                                        tags,
                                    );
                                    invalidateTagAutocompleteCache();

                                    // Refresh the tree so chip display updates.
                                    services.eventHub.treeChanged.emit();

                                    // Re-render the owning source note if one
                                    // already exists (never create a new one).
                                    const noteKey =
                                        dbItem?.parentItem || node.data.key;
                                    try {
                                        if (
                                            services.indexService.getFileByKey(
                                                noteKey,
                                            )
                                        ) {
                                            await workerBridge.libraryNote.triggerUpdate(
                                                node.data.libraryID,
                                                noteKey,
                                                { forceUpdateContent: true },
                                            );
                                        }
                                    } catch {
                                        // Index not ready / no note — ignore.
                                    }

                                    services.notificationService.notify(
                                        "success",
                                        "Tags updated.",
                                    );
                                },
                            }).open();
                        } catch (err) {
                            services.logService.error(
                                "Failed to open tag editor",
                                "TreeView",
                                err,
                            );
                            services.notificationService.notify(
                                "error",
                                "Failed to open tag editor.",
                            );
                        }
                    });
            });
        }

        if (
            nodeType === "collection" ||
            nodeType === "library" ||
            nodeType === "item"
        ) {
            menu.showAtMouseEvent(e.nativeEvent);
        }
    };

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
        const isCitationDrag =
            nodeType === "item" && node.data.itemType !== "attachment";
        let plainText = node.data.name || "Untitled";

        if (node.data.itemType === "attachment") {
            const url = `obsidian://zotflow?type=open-attachment&libraryID=${node.data.libraryID}&key=${node.data.key}`;
            plainText = `[${node.data.name}](${url})`;
        } else if (isCitationDrag) {
            // Only set the structured citation payload — CitationService.resolve()
            // (invoked by the drop handler) handles note creation, link generation,
            // and all format logic.
            const citationPayload: ZotFlowCitationPayload = {
                type: "zotflow-citation",
                libraryID: node.data.libraryID,
                key: node.data.key,
            };
            e.dataTransfer.setData(
                ZOTFLOW_CITATION_MIME,
                JSON.stringify(citationPayload),
            );
        }

        // Custom Drag Ghost using Obsidian classes
        const ghost = createDiv();
        ghost.addClass("drag-ghost");

        const self = createDiv();
        self.addClass("drag-ghost-self");

        setIcon(self, iconName || "file");

        const titleSpan = createSpan();
        titleSpan.textContent = node.data.name || "Untitled";

        self.appendChild(titleSpan);

        const action = createDiv();
        action.addClass("drag-ghost-action");
        action.textContent = isCitationDrag
            ? "Insert citation here"
            : "Insert link here";

        ghost.appendChild(self);
        ghost.appendChild(action);

        document.body.appendChild(ghost);

        // text/plain serves as fallback for non-ZotFlow drop targets
        e.dataTransfer.setData("text/plain", plainText);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        e.dataTransfer.effectAllowed = "copy";

        // requestAnimationFrame(() => {
        //     document.body.removeChild(ghost);
        // });
    };

    return (
        <div
            style={style}
            className={`zotflow-node ${node.isSelected ? "selected" : ""}`}
            onClick={handleOnClick}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
            draggable={nodeType === "item" && node.data.itemType !== "note"}
            onDragStart={handleDragStart}
        >
            {/* Indent Lines */}
            {Array.from({ length: node.level }).map((_, i) => (
                <div
                    key={i}
                    className="zotflow-indent-line"
                    style={{ left: `${i * INDENT_SIZE + 10}px` }}
                />
            ))}

            {/* Arrow: own click zone; leaf placeholders stay row body */}
            <div
                className="zotflow-arrow-box"
                onClick={isFolder ? handleArrowClick : undefined}
            >
                <ObsidianIcon
                    icon={node.isOpen ? "chevron-down" : "chevron-right"}
                    containerStyle={{
                        visibility: isFolder ? "visible" : "hidden",
                    }}
                />
            </div>
            {iconName !== "" && (
                <ObsidianIcon
                    icon={iconName}
                    className={
                        isFolder ? "zotflow-folder-icon" : "zotflow-file-icon"
                    }
                />
            )}
            <span
                style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                }}
            >
                <Highlight text={name} tokens={searchTokens} />
            </span>

            {/* File Tag */}
            {node.data.itemType === "attachment" &&
                getAttachmentFileTag(node.data.contentType) && (
                    <div className="nav-file-tag">
                        {getAttachmentFileTag(node.data.contentType)}
                    </div>
                )}

            {/* Note Tag */}
            {node.data.itemType === "note" && (
                <div className="nav-file-tag">Note</div>
            )}
        </div>
    );
};
