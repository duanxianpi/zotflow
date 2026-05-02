import type { NodeRendererProps } from "react-arborist";
import { Menu, setIcon } from "obsidian";
import type { ViewNode } from "./TreeView";
import { ObsidianIcon } from "../ObsidianIcon";
import { getAttachmentFileIcon, getItemTypeIcon } from "ui/icons";
import { services } from "services/services";
import { workerBridge } from "bridge";

import { openAttachment, openItemNote } from "utils/viewer";
import {
    ZOTFLOW_CITATION_MIME,
    type ZotFlowCitationPayload,
} from "ui/editor/citation-helper";

/** Pixel indentation per tree depth level. */
export const INDENT_SIZE = 20;

const Highlight = ({ text, term }: { text: string; term: string }) => {
    if (!term) return <>{text}</>;
    const parts = text.split(new RegExp(`(${term})`, "gi"));
    return (
        <>
            {parts.map((p, i) =>
                p.toLowerCase() === term.toLowerCase() ? (
                    <span key={i} className="search-result-file-matched-text">
                        {p}
                    </span>
                ) : (
                    p
                ),
            )}
        </>
    );
};

/** React component rendering a single tree node with icon, label, drag support, and context menu. */
export const NodeItem = ({
    node,
    style,
    tree,
}: NodeRendererProps<ViewNode>) => {
    const { nodeType, name, children } = node.data;
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

    const handleOnClick = (e: React.MouseEvent) => {
        node.toggle();
    };

    const handleDoubleClick = async (e: React.MouseEvent) => {
        e.stopPropagation();
        node.toggle();

        if (nodeType === "item" && node.data.itemType === "attachment") {
            // Attachment: Open PDF
            await openAttachment(
                node.data.libraryID,
                node.data.key,
                services.app,
            );
        } else if (nodeType === "item" && node.data.itemType === "note") {
            // Child note: Open read-only preview
            await openItemNote(
                node.data.libraryID,
                node.data.key,
                services.app,
            );
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
                            workerBridge.libraryNote.openNote(
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
            menu.addItem((item) => {
                item.setTitle("Delete note")
                    .setIcon("trash-2")
                    .onClick(async () => {
                        try {
                            await workerBridge.itemNote.deleteNote(
                                node.data.libraryID,
                                node.data.key,
                            );
                            services.taskMonitor.treeChanged.emit();
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

        if (
            nodeType === "collection" ||
            nodeType === "library" ||
            (isTopLevelItem && node.data.itemType !== "note") ||
            (nodeType === "item" && node.data.itemType === "note")
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
        const ghost = document.createElement("div");
        ghost.addClass("drag-ghost");

        const self = document.createElement("div");
        self.addClass("drag-ghost-self");

        setIcon(self, iconName || "file");

        const titleSpan = document.createElement("span");
        titleSpan.textContent = node.data.name || "Untitled";

        self.appendChild(titleSpan);

        const action = document.createElement("div");
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

            {/* Arrow */}
            <div className="zotflow-arrow-box">
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
                <Highlight text={name} term={tree.props.searchTerm || ""} />
            </span>

            {/* File Tag */}
            {node.data.itemType === "attachment" && (
                <div className="nav-file-tag">
                    {node.data.name.split(".").pop()}
                </div>
            )}

            {/* Note Tag */}
            {node.data.itemType === "note" && (
                <div className="nav-file-tag">Note</div>
            )}
        </div>
    );
};
