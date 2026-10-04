import React, { useState, useEffect, useCallback } from "react";
import { ObsidianIcon } from "../ObsidianIcon";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { startSync } from "ui/start-sync";
import { CountChip } from "./ConflictPanel";

import type { LibraryRow } from "worker/services/key";

/** A library's pull count: known, being checked, or unreachable. */
type PullCount = number | "loading" | "error";

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

/* ================================================================ */
/*  Sub-components                                                  */
/* ================================================================ */

const LibraryTable: React.FC<{
    libraries: LibraryRow[];
    pullCounts: Map<number, PullCount>;
    onOpenConflicts?: () => void;
    syncingAll: boolean;
    syncingLibId: number | null;
    onSyncLibrary: (id: number) => void;
    onSyncAll: () => void;
}> = ({
    libraries,
    pullCounts,
    onOpenConflicts,
    syncingAll,
    syncingLibId,
    onSyncLibrary,
    onSyncAll,
}) => {
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
                            <th title="Changes to upload (↑), to download (↓), and conflicts">
                                Changes
                            </th>
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
                                        {isIgnored ? (
                                            <span className="zotflow-sync-changed-none">
                                                —
                                            </span>
                                        ) : (
                                            <span className="zotflow-sync-counts">
                                                <CountChip
                                                    direction="push"
                                                    count={lib.pushCount}
                                                    title={`${lib.pushCount} change${lib.pushCount === 1 ? "" : "s"} here to upload`}
                                                />
                                                <CountChip
                                                    direction="pull"
                                                    count={pullCounts.get(
                                                        lib.id,
                                                    )}
                                                    title={pullTitle(
                                                        pullCounts.get(lib.id),
                                                    )}
                                                />
                                                {lib.conflictCount > 0 && (
                                                    <span
                                                        className="zotflow-sync-count zotflow-sync-count--conflict is-link"
                                                        title={`${lib.conflictCount} conflict${lib.conflictCount === 1 ? "" : "s"} to resolve`}
                                                        onClick={
                                                            onOpenConflicts
                                                        }
                                                    >
                                                        <ObsidianIcon icon="git-merge" />
                                                        <span>
                                                            {lib.conflictCount}
                                                        </span>
                                                    </span>
                                                )}
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

function pullTitle(count: PullCount | undefined): string {
    if (count === "loading") return "Checking Zotero for changes…";
    if (count === "error" || count === undefined)
        return "Could not reach Zotero";
    return `${count} change${count === 1 ? "" : "s"} in Zotero to download`;
}

/* ================================================================ */
/*  Main SyncView                                                   */
/* ================================================================ */

/** React component showing library sync controls. */
export const SyncView: React.FC<{
    /** Switches the Activity Center to its Conflicts tab. */
    onOpenConflicts?: () => void;
}> = ({ onOpenConflicts }) => {
    const [libraries, setLibraries] = useState<LibraryRow[]>([]);
    const [pullCounts, setPullCounts] = useState<Map<number, PullCount>>(
        new Map(),
    );
    const [syncingAll, setSyncingAll] = useState(false);
    const [syncingLibId, setSyncingLibId] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);

    // Local state only: libraries, push and conflict counts.
    const refresh = useCallback(async () => {
        try {
            const libs = await loadLibraries();
            setLibraries(libs);
            return libs;
        } catch (e) {
            services.logService.error(
                "Failed to load sync data",
                "SyncView",
                e,
            );
            return [];
        } finally {
            setLoading(false);
        }
    }, []);

    // Ask Zotero what each library would download (one versions request each).
    const checkRemote = useCallback(async (libs: LibraryRow[]) => {
        const active = libs.filter((l) => l.mode !== "ignored");
        setPullCounts(new Map(active.map((l) => [l.id, "loading"])));
        await Promise.all(
            active.map(async (lib) => {
                let count: PullCount;
                try {
                    count = await workerBridge.sync.countRemoteChanges(
                        lib.type,
                        lib.id,
                    );
                } catch (e) {
                    services.logService.warn(
                        `Could not check ${lib.name} for remote changes`,
                        "SyncView",
                        e,
                    );
                    count = "error";
                }
                setPullCounts((prev) => new Map(prev).set(lib.id, count));
            }),
        );
    }, []);

    const refreshAll = useCallback(async () => {
        await checkRemote(await refresh());
    }, [refresh, checkRemote]);

    useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

    // Auto-refresh when a sync task completes or fails
    useEffect(
        () =>
            services.eventHub.syncFinished.subscribe((task) => {
                if (task.status === "completed" || task.status === "failed") {
                    void refreshAll();
                }
            }),
        [refreshAll],
    );

    // Sync all libraries
    const handleSyncAll = useCallback(async () => {
        setSyncingAll(true);
        try {
            await startSync();
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
                await startSync(libId);
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

    const conflictTotal = libraries.reduce((n, l) => n + l.conflictCount, 0);

    return (
        <div className="zotflow-sync-view">
            <div className="zotflow-sync-controls">
                <span className="zotflow-sync-section-header">
                    Sync Libraries
                </span>
                <LibraryTable
                    libraries={libraries}
                    pullCounts={pullCounts}
                    onOpenConflicts={onOpenConflicts}
                    syncingAll={syncingAll}
                    syncingLibId={syncingLibId}
                    onSyncLibrary={(id) => void handleSyncLibrary(id)}
                    onSyncAll={() => void handleSyncAll()}
                />
            </div>
            {conflictTotal > 0 && (
                <div className="zotflow-sync-conflict-callout">
                    <ObsidianIcon icon="git-merge" />
                    <span>
                        {conflictTotal} conflict{conflictTotal === 1 ? "" : "s"}{" "}
                        {conflictTotal === 1 ? "waits" : "wait"} for you.
                        Nothing in conflict is uploaded until you resolve it.
                    </span>
                    <button onClick={onOpenConflicts}>Review conflicts</button>
                </div>
            )}
        </div>
    );
};
