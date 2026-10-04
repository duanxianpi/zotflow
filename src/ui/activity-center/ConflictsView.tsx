import React, { useState, useEffect, useCallback } from "react";
import { Platform } from "obsidian";
import { ObsidianIcon } from "../ObsidianIcon";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { startSync } from "ui/start-sync";
import { ConflictPanel, groupConflicts } from "./ConflictPanel";

import type {
    ConflictItemInfo,
    ConflictResolution,
} from "worker/services/conflict";

const RESOLVED_LABEL: Record<ConflictResolution, string> = {
    "keep-local": "kept local",
    "accept-remote": "accepted remote",
    "keep-local-copy": "kept local, all fields",
    "accept-remote-copy": "accepted remote, all fields",
};

/** React component listing merge conflicts and resolving them one by one. */
export const ConflictsView: React.FC<{
    /** Told the number of conflicts whenever the list is (re)loaded. */
    onCountChange?: (count: number) => void;
}> = ({ onCountChange }) => {
    const [conflicts, setConflicts] = useState<ConflictItemInfo[]>([]);
    const [libraryNames, setLibraryNames] = useState<Map<number, string>>(
        new Map(),
    );
    const [selectedConflict, setSelectedConflict] = useState<string | null>(
        null,
    );
    const [loading, setLoading] = useState(true);
    const [hasResolvedConflicts, setHasResolvedConflicts] = useState(false);
    const [syncing, setSyncing] = useState(false);

    const show = useCallback(
        (
            list: ConflictItemInfo[],
            select: (prev: string | null) => string | null,
        ) => {
            setConflicts(list);
            setSelectedConflict(select);
            onCountChange?.(groupConflicts(list).length);
        },
        [onCountChange],
    );

    const refresh = useCallback(async () => {
        try {
            const [conf, libs] = await Promise.all([
                workerBridge.conflict.getItemConflicts(),
                workerBridge.key.getLibraryRows(services.settings),
            ]);
            setLibraryNames(new Map(libs.map((l) => [l.id, l.name])));
            const entries = groupConflicts(conf);
            // Keep the selection; else open the first conflict, so the panel
            // never starts empty — except on a phone, which starts from the list.
            show(conf, (prev) =>
                entries.some((e) => e.id === prev)
                    ? prev
                    : Platform.isPhone
                      ? null
                      : (entries[0]?.id ?? null),
            );
        } catch (e) {
            services.logService.error(
                "Failed to load conflicts",
                "ConflictsView",
                e,
            );
        } finally {
            setLoading(false);
        }
    }, [show]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // A sync can raise or settle conflicts.
    useEffect(
        () =>
            services.eventHub.syncFinished.subscribe((task) => {
                if (task.status === "completed" || task.status === "failed") {
                    void refresh();
                }
            }),
        [refresh],
    );

    const handleResolve = useCallback(
        async (entry: ConflictItemInfo, action: ConflictResolution) => {
            const { libraryID, key } = entry;
            const position = groupConflicts(conflicts).findIndex(
                (e) =>
                    e.primary.libraryID === libraryID && e.primary.key === key,
            );
            try {
                await workerBridge.conflict.resolveItemConflict(
                    libraryID,
                    key,
                    action,
                );

                services.logService.info(
                    `Conflict resolved (${action}): ${key}`,
                    "ConflictsView",
                );
                services.notificationService.notify(
                    "success",
                    `Conflict resolved: ${RESOLVED_LABEL[action]}.`,
                );

                setHasResolvedConflicts(true);

                // Reload: resolving a group member resolves the whole group.
                // Then move on to the conflict that took this one's place.
                const remaining =
                    await workerBridge.conflict.getItemConflicts();
                // Move on to the conflict that took this one's place; a
                // phone goes back to the list instead.
                const entries = groupConflicts(remaining);
                const next = entries[Math.min(position, entries.length - 1)];
                show(remaining, () =>
                    Platform.isPhone ? null : (next?.id ?? null),
                );
            } catch (e) {
                services.logService.error(
                    "Conflict resolution failed",
                    "ConflictsView",
                    e,
                );
                services.notificationService.notify(
                    "error",
                    "Failed to resolve conflict.",
                );
            }
        },
        [conflicts, show],
    );

    const handleSync = useCallback(async () => {
        setSyncing(true);
        try {
            await startSync();
            services.notificationService.notify("success", "Sync started.");
        } catch (e) {
            services.logService.error("Sync all failed", "ConflictsView", e);
            services.notificationService.notify("error", "Sync failed.");
        } finally {
            setSyncing(false);
        }
    }, []);

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
        <div className="zotflow-sync-view zotflow-conflicts-view">
            <ConflictPanel
                entries={groupConflicts(conflicts)}
                libraryNames={libraryNames}
                selectedKey={selectedConflict}
                onSelect={setSelectedConflict}
                onResolve={handleResolve}
            />
            {hasResolvedConflicts && conflicts.length === 0 && (
                <div className="zotflow-sync-reminder">
                    <ObsidianIcon icon="info" />
                    <span>
                        All conflicts resolved. Sync to send the result to
                        Zotero.
                    </span>
                    <button
                        className="mod-cta"
                        disabled={syncing}
                        onClick={() => void handleSync()}
                    >
                        Sync now
                    </button>
                </div>
            )}
        </div>
    );
};
