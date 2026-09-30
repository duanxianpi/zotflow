import { App } from "obsidian";
import type { EventHub } from "services/event-hub";
import type { ITaskInfo } from "types/tasks";

type TaskUpdateCallback = (tasks: ITaskInfo[]) => void;

/**
 * Tracks worker task state for the UI. `subscribe` replays the current task
 * list, so a view opened mid-sync shows it at once. Data-change signals that
 * tasks produce (e.g. a sync finishing) go out on the EventHub instead.
 */
export class TaskMonitor {
    private tasks: Map<string, ITaskInfo> = new Map();
    private subscribers: Set<TaskUpdateCallback> = new Set();
    private syncDataRevision = 0;

    constructor(
        private app: App,
        private readonly events: EventHub,
    ) {}

    /**
     * Called by ParentHost when a task updates in the worker
     */
    public onTaskUpdate(taskId: string, info: ITaskInfo) {
        const previous = this.tasks.get(taskId);
        this.tasks.set(taskId, info);
        const syncFinished =
            info.type === "sync" &&
            info.status !== "pending" &&
            info.status !== "running" &&
            previous?.status !== info.status;
        if (syncFinished) this.syncDataRevision += 1;
        this.notifySubscribers();
        if (syncFinished) this.events.syncFinished.emit(info);

        // Cleanup completed/failed tasks after delay (optional, handled by UI mostly)
    }

    public getTasks(): ITaskInfo[] {
        return Array.from(this.tasks.values()).sort(
            (a, b) => b.createdTime - a.createdTime,
        );
    }

    /** Revision incremented whenever a sync reaches a terminal state. */
    public getSyncDataRevision(): number {
        return this.syncDataRevision;
    }

    public subscribe(callback: TaskUpdateCallback): () => void {
        this.subscribers.add(callback);
        // Initial call
        callback(this.getTasks());

        return () => {
            this.subscribers.delete(callback);
        };
    }

    private notifySubscribers() {
        const list = this.getTasks();
        this.subscribers.forEach((cb) => cb(list));
    }
}
