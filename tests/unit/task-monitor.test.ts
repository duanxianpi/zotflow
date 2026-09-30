/**
 * TaskMonitor — the task-state store behind the Activity Center, and the
 * source of the EventHub's `syncFinished` signal.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";

import { EventHub } from "services/event-hub";
import { TaskMonitor } from "services/task-monitor";

import type { App } from "obsidian";
import type { ITaskInfo, TaskStatus, TaskType } from "types/tasks";

let events: EventHub;
let monitor: TaskMonitor;

function task(
    id: string,
    status: TaskStatus,
    type: TaskType = "sync",
): ITaskInfo {
    return { id, type, status, createdTime: 0 } as ITaskInfo;
}

beforeEach(() => {
    events = new EventHub();
    monitor = new TaskMonitor({} as App, events);
});

describe("syncFinished", () => {
    test("fires once when a sync reaches a terminal state", () => {
        const finished = vi.fn();
        events.syncFinished.subscribe(finished);

        monitor.onTaskUpdate("S1", task("S1", "pending"));
        monitor.onTaskUpdate("S1", task("S1", "running"));
        monitor.onTaskUpdate("S1", task("S1", "completed"));
        // A repeated report of the same state is not a new finish.
        monitor.onTaskUpdate("S1", task("S1", "completed"));

        expect(finished).toHaveBeenCalledTimes(1);
        expect(finished).toHaveBeenCalledWith(task("S1", "completed"));
    });

    test.each<TaskStatus>(["failed", "cancelled"])(
        "fires for a sync that ends %s",
        (status) => {
            const finished = vi.fn();
            events.syncFinished.subscribe(finished);

            monitor.onTaskUpdate("S1", task("S1", "running"));
            monitor.onTaskUpdate("S1", task("S1", status));

            expect(finished).toHaveBeenCalledWith(task("S1", status));
        },
    );

    test("other task types never fire it", () => {
        const finished = vi.fn();
        events.syncFinished.subscribe(finished);

        monitor.onTaskUpdate("B1", task("B1", "running", "batch-create-notes"));
        monitor.onTaskUpdate(
            "B1",
            task("B1", "completed", "batch-create-notes"),
        );

        expect(finished).not.toHaveBeenCalled();
    });

    test("task subscribers see the finished state before it fires", () => {
        const seen: string[] = [];
        monitor.subscribe((tasks) => {
            if (tasks[0]) seen.push(`list:${tasks[0].status}`);
        });
        events.syncFinished.subscribe((t) => seen.push(`finished:${t.status}`));

        monitor.onTaskUpdate("S1", task("S1", "completed"));

        expect(seen).toEqual(["list:completed", "finished:completed"]);
    });

    test("the sync data revision moves with it", () => {
        monitor.onTaskUpdate("S1", task("S1", "running"));
        expect(monitor.getSyncDataRevision()).toBe(0);

        monitor.onTaskUpdate("S1", task("S1", "completed"));
        expect(monitor.getSyncDataRevision()).toBe(1);
    });
});

describe("subscribe", () => {
    test("replays the current task list to a new subscriber", () => {
        monitor.onTaskUpdate("S1", task("S1", "running"));

        const listener = vi.fn();
        monitor.subscribe(listener);

        expect(listener).toHaveBeenCalledWith([task("S1", "running")]);
    });
});
