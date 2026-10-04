import React, { useEffect, useState } from "react";
import { ObsidianIcon } from "../ObsidianIcon";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { SyncView } from "./SyncView";
import { ConflictsView } from "./ConflictsView";
import { groupConflicts } from "./ConflictPanel";
import { TasksView } from "./TasksView";
import { TelemetryView } from "./TelemetryView";
import { TemplateTestView } from "./TemplateTestView";
import { RepairView } from "./RepairView";
import { CslStylesView } from "./CslStylesView";

/** Tab container React component with Sync, Conflicts, Tasks, Template, CSL, Repair and Telemetry tabs. */
export const ZotFlowActivityCenter: React.FC<{ initialTab?: string }> = ({
    initialTab = "sync",
}) => {
    const [activeTab, setActiveTab] = useState(initialTab);
    const [conflictCount, setConflictCount] = useState(0);

    // The Conflicts tab's badge, kept current while the tab is closed too.
    useEffect(() => {
        const load = async () => {
            try {
                setConflictCount(
                    groupConflicts(
                        await workerBridge.conflict.getItemConflicts(),
                    ).length,
                );
            } catch (e) {
                services.logService.error(
                    "Failed to count conflicts",
                    "ActivityCenter",
                    e,
                );
            }
        };
        void load();
        return services.eventHub.syncFinished.subscribe(() => void load());
    }, []);

    const tabs = [
        { id: "sync", label: "Sync", icon: "refresh-cw" },
        {
            id: "conflicts",
            label: "Conflicts",
            icon: "git-merge",
            badge: conflictCount,
        },
        { id: "tasks", label: "Tasks", icon: "list" },
        { id: "template", label: "Template", icon: "code" },
        { id: "csl", label: "CSL", icon: "book-marked" },
        { id: "repair", label: "Repair", icon: "wrench" },
        { id: "telemetry", label: "Telemetry", icon: "activity" },
    ];

    return (
        <>
            <div className="zotflow-ac-tabs">
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.id;
                    return (
                        <div
                            key={tab.id}
                            className={`zotflow-ac-tab ${isActive ? "is-active" : ""}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            <span className="nav-icon">
                                <ObsidianIcon icon={tab.icon} />
                            </span>
                            <span className="zotflow-ac-tab-label">
                                {tab.label}
                            </span>
                            {!!tab.badge && (
                                <span className="zotflow-ac-tab-badge">
                                    {tab.badge}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="zotflow-ac-content">
                {activeTab === "sync" && (
                    <SyncView
                        onOpenConflicts={() => setActiveTab("conflicts")}
                    />
                )}
                {activeTab === "conflicts" && (
                    <ConflictsView onCountChange={setConflictCount} />
                )}
                {activeTab === "tasks" && <TasksView />}
                {activeTab === "telemetry" && <TelemetryView />}
                {activeTab === "template" && <TemplateTestView />}
                {activeTab === "csl" && <CslStylesView />}
                {activeTab === "repair" && <RepairView />}
            </div>
        </>
    );
};
