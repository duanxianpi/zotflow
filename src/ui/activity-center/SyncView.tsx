import React, { useState, useEffect, useCallback } from "react";
import { ObsidianIcon } from "../ObsidianIcon";
import { workerBridge } from "bridge";
import { services } from "services/services";

import type {
    ConflictItemInfo,
    ConflictAction,
} from "worker/services/conflict";
import type { LibraryRow } from "worker/services/key";

/* ================================================================ */
/*  Helpers                                                         */
/* ================================================================ */

function formatSyncTime(iso: string): string {
    if (!iso) return "Never";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-US", {
        hour12: false,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

/* ================================================================ */
/*  Data loading                                                    */
/* ================================================================ */

async function loadLibraries(): Promise<LibraryRow[]> {
    return workerBridge.key.getLibraryRows(services.settings);
}

/**
 * Load all conflicts via the ConflictService in the worker.
 *
 * Items only: collections are pull-only, so they never conflict.
 */
async function loadConflicts(): Promise<ConflictItemInfo[]> {
    return workerBridge.conflict.getItemConflicts();
}

/* ================================================================ */
/*  Sub-components                                                  */
/* ================================================================ */

const LibraryTable: React.FC<{
    libraries: LibraryRow[];
    syncingAll: boolean;
    syncingLibId: number | null;
    onSyncLibrary: (id: number) => void;
    onSyncAll: () => void;
}> = ({ libraries, syncingAll, syncingLibId, onSyncLibrary, onSyncAll }) => {
    if (libraries.length === 0) {
        return (
            <div className="zotflow-sync-empty">
                <ObsidianIcon icon="info" />
                <span>
                    No libraries found. Verify your API key in Settings.
                </span>
            </div>
        );
    }

    return (
        <>
            <div className="zotflow-sync-actions">
                <button
                    disabled={syncingAll || syncingLibId !== null}
                    onClick={onSyncAll}
                >
                    <span>{syncingAll ? "Syncing..." : "Sync All"}</span>
                </button>
            </div>
            <div className="zotflow-sync-lib-table-wrapper">
                <table className="zotflow-sync-lib-table">
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Name</th>
                            <th>Access</th>
                            <th>Sync Mode</th>
                            <th>Changes</th>
                            <th>Last Synced</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {libraries.map((lib) => {
                            const isSyncing =
                                syncingAll || syncingLibId === lib.id;
                            const isIgnored = lib.mode === "ignored";
                            return (
                                <tr
                                    key={lib.id}
                                    className={
                                        isIgnored
                                            ? "zotflow-sync-lib-row-ignored"
                                            : ""
                                    }
                                >
                                    <td>
                                        <span className="zotflow-sync-lib-type">
                                            <ObsidianIcon
                                                icon={
                                                    lib.type === "user"
                                                        ? "user"
                                                        : "users"
                                                }
                                            />
                                            <span>
                                                {lib.type === "user"
                                                    ? "Personal"
                                                    : "Group"}
                                            </span>
                                        </span>
                                    </td>
                                    <td title={`ID: ${lib.id}`}>{lib.name}</td>
                                    <td>
                                        <span
                                            className={
                                                lib.canWrite
                                                    ? "zotflow-sync-badge zotflow-sync-badge--rw"
                                                    : "zotflow-sync-badge zotflow-sync-badge--ro"
                                            }
                                        >
                                            {lib.canWrite
                                                ? "Read/Write"
                                                : "Read Only"}
                                        </span>
                                    </td>
                                    <td>
                                        <span className="zotflow-sync-mode-label">
                                            {lib.mode === "bidirectional"
                                                ? "Bidirectional"
                                                : lib.mode === "readonly"
                                                  ? "Read-Only"
                                                  : "Ignored"}
                                        </span>
                                    </td>
                                    <td>
                                        {lib.changedCount > 0 ? (
                                            <span className="zotflow-sync-changed-badge">
                                                {lib.changedCount}
                                            </span>
                                        ) : (
                                            <span className="zotflow-sync-changed-none">
                                                —
                                            </span>
                                        )}
                                    </td>
                                    <td className="zotflow-sync-time-cell">
                                        {lib.syncedAt
                                            ? formatSyncTime(lib.syncedAt)
                                            : "Never"}
                                    </td>
                                    <td>
                                        <button
                                            disabled={isSyncing || isIgnored}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onSyncLibrary(lib.id);
                                            }}
                                            title={
                                                isIgnored
                                                    ? "Library is set to Ignored"
                                                    : `Sync ${lib.name}`
                                            }
                                        >
                                            Sync
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </>
    );
};

const ConflictPanel: React.FC<{
    conflicts: ConflictItemInfo[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    onResolve: (entry: ConflictItemInfo, action: ConflictAction) => void;
}> = ({ conflicts, selectedKey, onSelect, onResolve }) => {
    const selected = conflicts.find(
        (c) => `${c.libraryID}:${c.key}` === selectedKey,
    );

    if (conflicts.length === 0) {
        return (
            <div className="zotflow-sync-empty">
                <ObsidianIcon
                    icon="check-circle"
                    iconStyle={{ color: "var(--text-faint)" }}
                />
                <span>No conflicts. Everything is in sync.</span>
            </div>
        );
    }

    return (
        <div className="zotflow-conflict-container">
            {/* Conflict list sidebar */}
            <div className="zotflow-conflict-list">
                {conflicts.map((c, i) => {
                    const id = `${c.libraryID}:${c.key}`;
                    const prev = conflicts[i - 1];
                    // Members of one remote deletion are listed (and
                    // resolved) together, under their group's heading.
                    const groupStart =
                        c.group &&
                        !(
                            prev?.group === c.group &&
                            prev.libraryID === c.libraryID
                        );

                    return (
                        <React.Fragment key={id}>
                            {groupStart && (
                                <div className="zotflow-conflict-group-heading">
                                    <ObsidianIcon icon="folder-x" />
                                    <span>
                                        Deleted in Zotero together (
                                        {c.groupSize ?? 1})
                                    </span>
                                </div>
                            )}
                            <div
                                className={`zotflow-conflict-item ${c.group ? "zotflow-conflict-item--member" : ""} ${selectedKey === id ? "is-selected" : ""}`}
                                onClick={() => onSelect(id)}
                            >
                                <div className="zotflow-conflict-item-header">
                                    <span className="zotflow-conflict-key">
                                        {c.key}
                                    </span>
                                    <span
                                        className={`zotflow-conflict-type-badge zotflow-conflict-type-badge--${c.conflictType}`}
                                    >
                                        {c.conflictType}
                                    </span>
                                </div>
                                <span className="zotflow-conflict-title">
                                    {c.title}
                                </span>
                            </div>
                        </React.Fragment>
                    );
                })}
            </div>

            {/* Diff pane */}
            {selected ? (
                <ConflictDiffPane entry={selected} onResolve={onResolve} />
            ) : (
                <div className="zotflow-conflict-diff zotflow-sync-empty">
                    <ObsidianIcon icon="arrow-left" />
                    <span>Select a conflict to view details.</span>
                </div>
            )}
        </div>
    );
};

/* ================================================================ */
/*  ConflictDiffPane — field-level diff table                       */
/* ================================================================ */

/** Fields hidden by default (noisy / internal metadata). */
const DEFAULT_HIDDEN_FIELDS = new Set([
    // "creators",
    // "tags",
    // "relations",
    // "collections",
    "annotationIsExternal",
    "annotationAuthorName",
    // "dateAdded",
    // "dateModified",
]);

const ConflictDiffPane: React.FC<{
    entry: ConflictItemInfo;
    onResolve: (entry: ConflictItemInfo, action: ConflictAction) => void;
}> = ({ entry, onResolve }) => {
    const fields = entry.fields.filter(
        (f) => !DEFAULT_HIDDEN_FIELDS.has(f.field),
    );

    return (
        <div className="zotflow-conflict-diff">
            <span className="zotflow-conflict-diff-heading">{entry.title}</span>

            {entry.syncError && (
                <div className="zotflow-conflict-sync-error">
                    <ObsidianIcon icon="alert-triangle" />
                    <span>{entry.syncError}</span>
                </div>
            )}

            {fields.length > 0 ? (
                <div className="zotflow-field-diff-wrapper">
                    <table className="zotflow-field-diff-table">
                        <thead>
                            <tr>
                                <th>Field</th>
                                <th className="zotflow-field-diff-local">
                                    Local (Obsidian)
                                </th>
                                <th className="zotflow-field-diff-remote">
                                    Remote (Zotero)
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {fields.map((f) => (
                                <tr key={f.field}>
                                    <td className="zotflow-field-diff-name">
                                        {f.field}
                                    </td>
                                    <td className="zotflow-field-diff-val zotflow-field-diff-val--local">
                                        <pre>{f.localValue}</pre>
                                    </td>
                                    <td className="zotflow-field-diff-val zotflow-field-diff-val--remote">
                                        <pre>{f.remoteValue}</pre>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="zotflow-sync-empty">
                    <ObsidianIcon icon="info" />
                    <span>No field differences detected.</span>
                </div>
            )}

            {entry.group && (entry.groupSize ?? 1) > 1 && (
                <div className="zotflow-conflict-note">
                    <ObsidianIcon icon="info" />
                    <span>
                        This resolves all {entry.groupSize} items deleted in
                        Zotero together: Keep Local re-creates them, Accept
                        Remote removes them here.
                    </span>
                </div>
            )}

            {/* With `keepLocalBlocked` (commented out in ConflictItemInfo):
                {(entry.keepLocalBlocked || entry.acceptRemoteBlocked) && …}
                showing `entry.keepLocalBlocked ?? entry.acceptRemoteBlocked`. */}
            {entry.acceptRemoteBlocked && (
                <div className="zotflow-conflict-note">
                    <ObsidianIcon icon="ban" />
                    <span>{entry.acceptRemoteBlocked}</span>
                </div>
            )}

            <div className="zotflow-conflict-actions">
                <button
                    className="zotflow-conflict-btn zotflow-conflict-btn--local"
                    // disabled={!!entry.keepLocalBlocked}
                    // title={entry.keepLocalBlocked}
                    onClick={() => onResolve(entry, "keep-local")}
                >
                    Keep Local
                </button>
                <button
                    className="zotflow-conflict-btn zotflow-conflict-btn--remote"
                    disabled={!!entry.acceptRemoteBlocked}
                    title={entry.acceptRemoteBlocked}
                    onClick={() => onResolve(entry, "accept-remote")}
                >
                    Accept Remote
                </button>
            </div>
        </div>
    );
};

/* ================================================================ */
/*  Main SyncView                                                   */
/* ================================================================ */

/** React component showing library sync controls and merge conflict resolution UI. */
export const SyncView: React.FC = () => {
    const [libraries, setLibraries] = useState<LibraryRow[]>([]);
    const [conflicts, setConflicts] = useState<ConflictItemInfo[]>([]);
    const [selectedConflict, setSelectedConflict] = useState<string | null>(
        null,
    );
    const [syncingAll, setSyncingAll] = useState(false);
    const [syncingLibId, setSyncingLibId] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [hasResolvedConflicts, setHasResolvedConflicts] = useState(false);

    // Load data on mount
    const refresh = useCallback(async () => {
        try {
            const [libs, conf] = await Promise.all([
                loadLibraries(),
                loadConflicts(),
            ]);
            setLibraries(libs);
            setConflicts(conf);
        } catch (e) {
            services.logService.error(
                "Failed to load sync data",
                "SyncView",
                e,
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Auto-refresh when a sync task completes or fails
    useEffect(
        () =>
            services.eventHub.syncFinished.subscribe((task) => {
                if (task.status === "completed" || task.status === "failed") {
                    void refresh();
                }
            }),
        [refresh],
    );

    // Sync all libraries
    const handleSyncAll = useCallback(async () => {
        setSyncingAll(true);
        try {
            await workerBridge.createSyncTask();
            services.notificationService.notify("success", "Sync started.");
        } catch (e) {
            services.logService.error("Sync all failed", "SyncView", e);
            services.notificationService.notify("error", "Sync failed.");
        } finally {
            setSyncingAll(false);
            // Refresh libraries to get updated sync times
            void refresh();
        }
    }, [refresh]);

    // Sync a single library
    const handleSyncLibrary = useCallback(
        async (libId: number) => {
            setSyncingLibId(libId);
            try {
                await workerBridge.createSyncTask(libId);
                services.notificationService.notify("success", "Sync started.");
            } catch (e) {
                services.logService.error(
                    `Sync library ${libId} failed`,
                    "SyncView",
                    e,
                );
                services.notificationService.notify("error", "Sync failed.");
            } finally {
                setSyncingLibId(null);
                void refresh();
            }
        },
        [refresh],
    );

    // Conflict resolution via ConflictService in worker
    const handleResolve = useCallback(
        async (entry: ConflictItemInfo, action: ConflictAction) => {
            const { libraryID, key } = entry;
            try {
                await workerBridge.conflict.resolveItemConflict(
                    libraryID,
                    key,
                    action,
                );

                services.logService.info(
                    `Conflict resolved (${action}): ${key}`,
                    "SyncView",
                );
                services.notificationService.notify(
                    "success",
                    `Conflict resolved: ${action === "keep-local" ? "kept local" : "accepted remote"}.`,
                );

                setHasResolvedConflicts(true);

                // Reload: resolving a group member resolves the whole group.
                const remaining = await loadConflicts();
                setConflicts(remaining);
                setSelectedConflict((prev) =>
                    remaining.some((c) => `${c.libraryID}:${c.key}` === prev)
                        ? prev
                        : null,
                );
            } catch (e) {
                services.logService.error(
                    "Conflict resolution failed",
                    "SyncView",
                    e,
                );
                services.notificationService.notify(
                    "error",
                    "Failed to resolve conflict.",
                );
            }
        },
        [],
    );

    if (loading) {
        return (
            <div className="zotflow-sync-view">
                <div className="zotflow-sync-empty">
                    <ObsidianIcon icon="loader" className="zotflow-spin" />
                    <span>Loading...</span>
                </div>
            </div>
        );
    }

    return (
        <div className="zotflow-sync-view">
            {/* Section 1: Sync Controls */}
            <div className="zotflow-sync-controls">
                <span className="zotflow-sync-section-header">
                    Sync Libraries
                </span>
                <LibraryTable
                    libraries={libraries}
                    syncingAll={syncingAll}
                    syncingLibId={syncingLibId}
                    onSyncLibrary={(id) => void handleSyncLibrary(id)}
                    onSyncAll={() => void handleSyncAll()}
                />
            </div>

            {/* Section 2: Merge Conflicts */}
            <div className="zotflow-sync-conflicts">
                <span className="zotflow-sync-section-header">
                    Merge Conflicts
                    {conflicts.length > 0 && (
                        <span className="zotflow-sync-conflict-badge">
                            {conflicts.length}
                        </span>
                    )}
                </span>
                <ConflictPanel
                    conflicts={conflicts}
                    selectedKey={selectedConflict}
                    onSelect={setSelectedConflict}
                    onResolve={(entry, action) =>
                        void handleResolve(entry, action)
                    }
                />
                {hasResolvedConflicts && conflicts.length === 0 && (
                    <div className="zotflow-sync-reminder">
                        <ObsidianIcon icon="info" />
                        <span>
                            All conflicts resolved. Run a sync to push your
                            changes to Zotero.
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
};
