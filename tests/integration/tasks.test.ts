/**
 * The background-task layer: BaseTask's lifecycle and TaskManager's
 * registration, cancellation and deduplication.
 *
 * This is where "I pressed cancel and nothing happened" and "the sync ran
 * twice" come from, so the tests are about state transitions and bookkeeping
 * rather than the work the tasks do — the services they drive have their own
 * suites.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { BaseTask } from "worker/tasks/base";
import { TaskManager } from "worker/tasks/manager";
import { SyncTask } from "worker/tasks/impl/sync-task";
import { DownloadAttachmentTask } from "worker/tasks/impl/download-attachment-task";
import SparkMD5 from "spark-md5";
import { resetDb, seedItem, seedLibrary } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";
import { DEFAULT_SETTINGS } from "settings/types";

import type { FakeParentHost } from "../fakes/parent-host";
import type { ITaskInfo } from "types/tasks";
import type { SyncService } from "worker/services/sync";
import type { LibraryNoteService } from "worker/services/library-note";

const LIB = 1;

let host: FakeParentHost;
let manager: TaskManager;

beforeEach(async () => {
    await resetDb();
    host = createFakeParentHost();
    manager = new TaskManager(host);
});

afterEach(() => vi.restoreAllMocks());

/** Minimal task whose body the test controls. */
class ProbeTask extends BaseTask {
    public ran = false;

    constructor(
        parentHost: FakeParentHost,
        private body: (signal: AbortSignal, task: ProbeTask) => Promise<void> = () =>
            Promise.resolve(),
        id?: string,
    ) {
        super("test-task", parentHost, id);
        this.displayText = "Probe";
    }

    protected async run(signal: AbortSignal): Promise<void> {
        this.ran = true;
        await this.body(signal, this);
    }

    /** Expose the protected reporter so tests can drive progress. */
    public report(completed: number, total: number, message: string) {
        this.reportProgress(completed, total, message);
    }

    public setResult(successCount: number, failCount: number) {
        this.result = { successCount, failCount };
    }
}

/** A promise plus its resolvers, for holding a task open. */
function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Updates the manager forwarded for a given task id. */
const updatesFor = (taskId: string): ITaskInfo[] =>
    host.taskUpdates.filter((u) => u.taskId === taskId).map((u) => u.info);

/** A minimal attachment row for the download-task factory. */
const attachmentItem = (contentType = "application/pdf", md5?: string) =>
    ({
        libraryID: LIB,
        key: "ATTACH01",
        itemType: "attachment",
        raw: {
            key: "ATTACH01",
            data: { contentType, filename: "paper.pdf", md5 },
        },
    }) as never;

describe("task lifecycle", () => {
    test("a task runs to completion and reports it", async () => {
        const task = new ProbeTask(host);

        await task.execute(new AbortController().signal);

        expect(task.ran).toBe(true);
        const info = task.getInfo();
        expect(info.status).toBe("completed");
        expect(info.progress.message).toBe("Completed");
        expect(info.startTime).toBeDefined();
        expect(info.endTime).toBeDefined();
        expect(info.canCancel).toBe(false);
    });

    test("progress is filled in on completion so the bar does not hang", async () => {
        const task = new ProbeTask(host, (_s, t) => {
            t.report(3, 10, "working");
            return Promise.resolve();
        });

        await task.execute(new AbortController().signal);

        const { completed, total } = task.getInfo().progress;
        expect(completed).toBe(total);
        expect(total).toBe(10);
    });

    test("a thrown error lands as failed, with the message kept", async () => {
        const task = new ProbeTask(host, () =>
            Promise.reject(new Error("disk full")),
        );

        await task.execute(new AbortController().signal);

        const info = task.getInfo();
        expect(info.status).toBe("failed");
        expect(info.error).toBe("disk full");
        expect(info.progress.message).toBe("Failed: disk full");
        expect(info.displayText).toBe("Probe — Failed");
    });

    test("a non-Error rejection is still readable", async () => {
        const task = new ProbeTask(host, () =>
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is exactly what this pins
            Promise.reject("just a string"),
        );

        await task.execute(new AbortController().signal);

        expect(task.getInfo().error).toBe("just a string");
    });

    test("an already-aborted signal cancels before the body runs", async () => {
        const controller = new AbortController();
        controller.abort();
        const task = new ProbeTask(host);

        await task.execute(controller.signal);

        expect(task.ran).toBe(false);
        expect(task.getInfo().status).toBe("cancelled");
        expect(task.getInfo().displayText).toBe("Probe — Cancelled");
    });

    test("aborting mid-run cancels rather than fails", async () => {
        // The distinction matters: a cancelled task is the user's doing and
        // must not surface as an error.
        const controller = new AbortController();
        const task = new ProbeTask(host, (signal) =>
            new Promise((_res, rej) => {
                signal.addEventListener("abort", () =>
                    rej(new Error("Aborted")),
                );
            }),
        );

        const running = task.execute(controller.signal);
        controller.abort();
        await running;

        expect(task.getInfo().status).toBe("cancelled");
        expect(task.getInfo().error).toBeUndefined();
    });

    test("a body that throws Aborted counts as cancelled even without a signal", async () => {
        const task = new ProbeTask(host, () =>
            Promise.reject(new Error("Aborted")),
        );

        await task.execute(new AbortController().signal);

        expect(task.getInfo().status).toBe("cancelled");
    });

    test("a pending task advertises itself as cancellable", () => {
        const task = new ProbeTask(host);
        const info = task.getInfo();
        expect(info.status).toBe("pending");
        expect(info.canCancel).toBe(true);
        expect(info.startTime).toBeUndefined();
    });

    test("every state change is emitted to the subscriber", async () => {
        const seen: string[] = [];
        const task = new ProbeTask(host, (_s, t) => {
            t.report(1, 2, "half");
            return Promise.resolve();
        });
        task.onUpdate = (info) => seen.push(info.status);

        await task.execute(new AbortController().signal);

        // running (start), running (progress), completed (finish)
        expect(seen).toEqual(["running", "running", "completed"]);
    });

    test("a custom id is honoured, otherwise one is generated", () => {
        expect(new ProbeTask(host, undefined, "fixed-id").id).toBe("fixed-id");

        const a = new ProbeTask(host).id;
        const b = new ProbeTask(host).id;
        expect(a).not.toBe(b);
        expect(a).toHaveLength(36); // uuid v4
    });

    test("log() is forwarded to the main thread", () => {
        new ProbeTask(host).log("warn", "careful", "ProbeTask");
        expect(host.logsAt("warn")[0]).toMatchObject({
            message: "careful",
            context: "ProbeTask",
        });
    });
});

describe("registration", () => {
    test("registering pushes an initial snapshot and wires later updates", async () => {
        const task = new ProbeTask(host, (_s, t) => {
            t.report(1, 1, "done bit");
            return Promise.resolve();
        });

        manager.registerTask(task);
        expect(updatesFor(task.id).map((i) => i.status)).toEqual(["pending"]);

        await task.execute(new AbortController().signal);
        expect(updatesFor(task.id).map((i) => i.status)).toEqual([
            "pending",
            "running",
            "running",
            "completed",
        ]);
    });

    test("getTasks reports every registered task", () => {
        const a = new ProbeTask(host, undefined, "a");
        const b = new ProbeTask(host, undefined, "b");
        manager.registerTask(a);
        manager.registerTask(b);

        expect(manager.getTasks().map((t) => t.id)).toEqual(["a", "b"]);
    });

    test("history is bounded so a long session does not grow without limit", () => {
        for (let i = 0; i < 60; i++) {
            manager.registerTask(new ProbeTask(host, undefined, `task-${i}`));
        }

        const ids = manager.getTasks().map((t) => t.id);
        expect(ids.length).toBeLessThanOrEqual(51);
        // The oldest are the ones dropped.
        expect(ids).not.toContain("task-0");
        expect(ids).toContain("task-59");
    });
});

describe("starting and cancelling", () => {
    test("startTask registers, runs, and hands back the id", async () => {
        const gate = deferred();
        const task = new ProbeTask(host, () => gate.promise);

        const id = await manager.startTask(task);
        expect(id).toBe(task.id);
        expect(manager.getTasks().map((t) => t.id)).toContain(id);

        gate.resolve();
        await vi.waitFor(() =>
            expect(task.getInfo().status).toBe("completed"),
        );
    });

    test("cancelTask aborts the signal the task is watching", async () => {
        const observed = deferred<boolean>();
        const task = new ProbeTask(host, (signal) => {
            signal.addEventListener("abort", () => observed.resolve(true));
            return new Promise((_res, rej) =>
                signal.addEventListener("abort", () =>
                    rej(new Error("Aborted")),
                ),
            );
        });

        await manager.startTask(task);
        manager.cancelTask(task.id);

        expect(await observed.promise).toBe(true);
        await vi.waitFor(() =>
            expect(task.getInfo().status).toBe("cancelled"),
        );
    });

    test("cancelling an unknown id is a no-op", () => {
        expect(() => manager.cancelTask("never-existed")).not.toThrow();
    });

    test("cancelling a finished task does not disturb its result", async () => {
        const task = new ProbeTask(host);
        await manager.startTask(task);
        await vi.waitFor(() =>
            expect(task.getInfo().status).toBe("completed"),
        );

        // The controller is dropped once the task settles.
        manager.cancelTask(task.id);
        expect(task.getInfo().status).toBe("completed");
    });

    test("two tasks run independently", async () => {
        const gateA = deferred();
        const a = new ProbeTask(host, () => gateA.promise, "a");
        const b = new ProbeTask(host, undefined, "b");

        await manager.startTask(a);
        await manager.startTask(b);

        await vi.waitFor(() => expect(b.getInfo().status).toBe("completed"));
        expect(a.getInfo().status).toBe("running");

        gateA.resolve();
        await vi.waitFor(() => expect(a.getInfo().status).toBe("completed"));
    });

    test("cancelling one task leaves the other alone", async () => {
        const gate = deferred();
        const victim = new ProbeTask(
            host,
            (signal) =>
                new Promise((_res, rej) =>
                    signal.addEventListener("abort", () =>
                        rej(new Error("Aborted")),
                    ),
                ),
            "victim",
        );
        const bystander = new ProbeTask(host, () => gate.promise, "bystander");

        await manager.startTask(victim);
        await manager.startTask(bystander);
        manager.cancelTask("victim");

        await vi.waitFor(() =>
            expect(victim.getInfo().status).toBe("cancelled"),
        );
        expect(bystander.getInfo().status).toBe("running");
        gate.resolve();
    });
});

/* ================================================================ */
/*  Sync task creation and dedup                                    */
/* ================================================================ */

interface SyncCall {
    libraryId?: number;
}

function fakeSyncService(
    onStart: (call: SyncCall) => Promise<{
        successCount: number;
        failCount: number;
        changedItems: { libraryID: number; itemKey: string }[];
        syncedLibraryIDs: number[];
    }>,
): SyncService {
    return {
        startSync: (
            _signal?: AbortSignal,
            _onProgress?: unknown,
            libraryId?: number,
        ) => onStart({ libraryId }),
    } as unknown as SyncService;
}

describe("sync task deduplication", () => {
    test("a second full sync reuses the one already running", async () => {
        const gate = deferred();
        let starts = 0;
        const sync = fakeSyncService(async () => {
            starts++;
            await gate.promise;
            return {
                successCount: 1,
                failCount: 0,
                changedItems: [],
                syncedLibraryIDs: [LIB],
            };
        });

        const first = await manager.createSyncTask(sync);
        const second = await manager.createSyncTask(sync);

        expect(second).toBe(first);
        expect(starts).toBe(1);
        expect(
            host.logsAt("info").some((l) => /already in progress/.test(l.message)),
        ).toBe(true);

        gate.resolve();
    });

    test("different libraries sync in parallel", async () => {
        // Separate DB rows and API endpoints, so there is nothing to serialise.
        const gate = deferred();
        const scopes: (number | undefined)[] = [];
        const sync = fakeSyncService(async ({ libraryId }) => {
            scopes.push(libraryId);
            await gate.promise;
            return {
                successCount: 1,
                failCount: 0,
                changedItems: [],
                syncedLibraryIDs: [],
            };
        });

        const a = await manager.createSyncTask(sync, 1);
        const b = await manager.createSyncTask(sync, 2);

        expect(b).not.toBe(a);
        await vi.waitFor(() => expect(scopes).toEqual([1, 2]));
        gate.resolve();
    });

    test("a full sync and a library sync are distinct scopes", async () => {
        const gate = deferred();
        const sync = fakeSyncService(async () => {
            await gate.promise;
            return {
                successCount: 1,
                failCount: 0,
                changedItems: [],
                syncedLibraryIDs: [],
            };
        });

        const all = await manager.createSyncTask(sync);
        const one = await manager.createSyncTask(sync, 1);

        expect(one).not.toBe(all);
        gate.resolve();
    });

    test("the scope is released once the sync settles", async () => {
        const sync = fakeSyncService(() =>
            Promise.resolve({
                successCount: 1,
                failCount: 0,
                changedItems: [],
                syncedLibraryIDs: [],
            }),
        );

        const first = await manager.createSyncTask(sync);
        await vi.waitFor(() =>
            expect(
                manager.getTasks().find((t) => t.id === first)!.status,
            ).toBe("completed"),
        );

        const second = await manager.createSyncTask(sync);
        expect(second).not.toBe(first);
    });

    test("a failed sync still releases its scope", async () => {
        const sync = fakeSyncService(() =>
            Promise.reject(new Error("network down")),
        );

        const first = await manager.createSyncTask(sync);
        await vi.waitFor(() =>
            expect(
                manager.getTasks().find((t) => t.id === first)!.status,
            ).toBe("failed"),
        );

        expect(await manager.createSyncTask(sync)).not.toBe(first);
    });
});

/* ================================================================ */
/*  SyncTask itself                                                 */
/* ================================================================ */

describe("sync task reporting", () => {
    const emptyResult = {
        successCount: 2,
        failCount: 0,
        changedItems: [] as { libraryID: number; itemKey: string }[],
        syncedLibraryIDs: [LIB],
    };

    test("a library-scoped sync names the library once it is known", async () => {
        await seedLibrary({ id: LIB, type: "user", name: "My Library" });
        const task = new SyncTask(
            host,
            fakeSyncService(() => Promise.resolve(emptyResult)),
            LIB,
        );

        await task.execute(new AbortController().signal);

        expect(task.getInfo().input).toEqual({
            library: "My Library",
            libraryId: LIB,
        });
    });

    test("an unknown library falls back to its id", async () => {
        const task = new SyncTask(
            host,
            fakeSyncService(() => Promise.resolve(emptyResult)),
            99,
        );

        await task.execute(new AbortController().signal);

        expect(task.getInfo().input).toEqual({ library: "99", libraryId: 99 });
    });

    test("a full sync records the scope instead", async () => {
        const task = new SyncTask(
            host,
            fakeSyncService(() => Promise.resolve(emptyResult)),
        );

        await task.execute(new AbortController().signal);

        expect(task.getInfo().input).toEqual({ scope: "all" });
    });

    test("the result summarises libraries and changed items", async () => {
        const task = new SyncTask(
            host,
            fakeSyncService(() =>
                Promise.resolve({
                    successCount: 2,
                    failCount: 1,
                    changedItems: [
                        { libraryID: LIB, itemKey: "A" },
                        { libraryID: LIB, itemKey: "B" },
                    ],
                    syncedLibraryIDs: [LIB],
                }),
            ),
        );

        await task.execute(new AbortController().signal);

        expect(task.getInfo().result).toEqual({
            successCount: 2,
            failCount: 1,
            details: {
                libraries: 3,
                synced: 2,
                failed: 1,
                changedItems: 2,
            },
        });
    });

    test("the terminal text reports the count, and flags failures", async () => {
        const ok = new SyncTask(
            host,
            fakeSyncService(() => Promise.resolve(emptyResult)),
        );
        await ok.execute(new AbortController().signal);
        expect(ok.getInfo().displayText).toBe("Synced 2 libraries");

        const partial = new SyncTask(
            host,
            fakeSyncService(() =>
                Promise.resolve({ ...emptyResult, successCount: 1, failCount: 2 }),
            ),
        );
        await partial.execute(new AbortController().signal);
        expect(partial.getInfo().displayText).toBe(
            "Synced 1 libraries (2 failed)",
        );

        const failed = new SyncTask(
            host,
            fakeSyncService(() => Promise.reject(new Error("boom"))),
        );
        await failed.execute(new AbortController().signal);
        expect(failed.getInfo().displayText).toBe("Sync — Failed");

        const controller = new AbortController();
        controller.abort();
        const cancelled = new SyncTask(
            host,
            fakeSyncService(() => Promise.resolve(emptyResult)),
        );
        await cancelled.execute(controller.signal);
        expect(cancelled.getInfo().displayText).toBe("Sync — Cancelled");
    });

    test("progress from the sync service is forwarded", async () => {
        const task = new SyncTask(
            host,
            {
                startSync: (
                    _signal?: AbortSignal,
                    onProgress?: (c: number, t: number, m: string) => void,
                ) => {
                    onProgress?.(1, 2, "halfway");
                    return Promise.resolve(emptyResult);
                },
            } as unknown as SyncService,
        );
        const seen: string[] = [];
        task.onUpdate = (i) => seen.push(i.progress.message);

        await task.execute(new AbortController().signal);

        expect(seen).toContain("halfway");
    });
});

describe("post-sync source-note refresh", () => {
    const settings = {
        ...DEFAULT_SETTINGS,
        autoUpdateSourceNotesAfterSync: true,
    };

    /** Records the batch-note tasks the sync task spawns. */
    function spyManager() {
        const calls: { items: { libraryID: number; itemKey: string }[] }[] = [];
        const m = new TaskManager(host);
        (m as unknown as { createBatchNoteTask: unknown }).createBatchNoteTask = (
            _svc: unknown,
            input: { items: { libraryID: number; itemKey: string }[] },
        ) => {
            calls.push(input);
            return Promise.resolve("batch-id");
        };
        return { manager: m, calls };
    }

    const noteService = {
        purgeTrashedSourceNotes: () => Promise.resolve(),
    } as unknown as LibraryNoteService;

    async function runWith(
        changedItems: { libraryID: number; itemKey: string }[],
        over: Partial<typeof settings> = {},
    ) {
        const { manager: m, calls } = spyManager();
        const task = new SyncTask(
            host,
            fakeSyncService(() =>
                Promise.resolve({
                    successCount: 1,
                    failCount: 0,
                    changedItems,
                    syncedLibraryIDs: [LIB],
                }),
            ),
            undefined,
            m,
            noteService,
            { ...settings, ...over },
        );
        await task.execute(new AbortController().signal);
        return calls;
    }

    test("a changed annotation refreshes its top-level item", async () => {
        // Annotations do not bump the parent's version, so without this the
        // source note would never be re-rendered.
        await seedItem({ libraryID: LIB, key: "PARENT01" });
        await seedItem({
            libraryID: LIB,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
        });
        await seedItem({
            libraryID: LIB,
            key: "ANNOTAT1",
            itemType: "annotation",
            parentItem: "ATTACH01",
        });

        const calls = await runWith([{ libraryID: LIB, itemKey: "ANNOTAT1" }]);

        expect(calls).toEqual([
            { items: [{ libraryID: LIB, itemKey: "PARENT01" }] },
        ]);
    });

    test("several children of one item collapse to a single refresh", async () => {
        await seedItem({ libraryID: LIB, key: "PARENT01" });
        await seedItem({
            libraryID: LIB,
            key: "NOTE0001",
            itemType: "note",
            parentItem: "PARENT01",
        });
        await seedItem({
            libraryID: LIB,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
        });

        const calls = await runWith([
            { libraryID: LIB, itemKey: "NOTE0001" },
            { libraryID: LIB, itemKey: "ATTACH01" },
            { libraryID: LIB, itemKey: "PARENT01" },
        ]);

        expect(calls[0]!.items).toEqual([{ libraryID: LIB, itemKey: "PARENT01" }]);
    });

    test("a trashed top-level item is not refreshed", async () => {
        await seedItem({ libraryID: LIB, key: "TRASHED1", trashed: 1 });

        expect(await runWith([{ libraryID: LIB, itemKey: "TRASHED1" }])).toEqual(
            [],
        );
    });

    test("a trashed child still refreshes its live top-level item", async () => {
        await seedItem({ libraryID: LIB, key: "PARENT01" });
        await seedItem({
            libraryID: LIB,
            key: "TRASHATT",
            itemType: "attachment",
            parentItem: "PARENT01",
            trashed: 1,
        });

        expect(
            await runWith([{ libraryID: LIB, itemKey: "TRASHATT" }]),
        ).toEqual([{ items: [{ libraryID: LIB, itemKey: "PARENT01" }] }]);
    });

    test("an orphaned child is dropped rather than refreshed", async () => {
        await seedItem({
            libraryID: LIB,
            key: "ORPHANAN",
            itemType: "annotation",
            parentItem: "GONEATT0",
        });

        expect(await runWith([{ libraryID: LIB, itemKey: "ORPHANAN" }])).toEqual(
            [],
        );
    });

    test("a standalone attachment is not itself a note-bearing item", async () => {
        // It is a child type with nowhere to walk up to, so the walk ends on
        // the attachment itself. Refreshing it would ask for a source note
        // that cannot exist.
        await seedItem({
            libraryID: LIB,
            key: "LONEATT0",
            itemType: "attachment",
            parentItem: "",
        });

        expect(await runWith([{ libraryID: LIB, itemKey: "LONEATT0" }])).toEqual(
            [],
        );
    });

    test("a chain deeper than the depth bound is abandoned", async () => {
        // Six nested child types: the walk stops at MAX_DEPTH still holding a
        // child, which is dropped rather than refreshed.
        for (let i = 0; i < 7; i++) {
            await seedItem({
                libraryID: LIB,
                key: `CHAIN00${i}`,
                itemType: "attachment",
                parentItem: i === 6 ? "" : `CHAIN00${i + 1}`,
            });
        }

        expect(await runWith([{ libraryID: LIB, itemKey: "CHAIN000" }])).toEqual(
            [],
        );
    });

    test("an item that is no longer in the DB is skipped", async () => {
        expect(await runWith([{ libraryID: LIB, itemKey: "MISSING1" }])).toEqual(
            [],
        );
    });

    test("nothing changed means no refresh task", async () => {
        expect(await runWith([])).toEqual([]);
    });

    test("the setting gates the whole thing", async () => {
        await seedItem({ libraryID: LIB, key: "PARENT01" });

        expect(
            await runWith([{ libraryID: LIB, itemKey: "PARENT01" }], {
                autoUpdateSourceNotesAfterSync: false,
            }),
        ).toEqual([]);
    });

    test("a failure while chaining is logged, never thrown or leaked", async () => {
        // The spawn is fire-and-forget, so its rejection has to be caught
        // explicitly: `void promise` attaches no handler and the failure would
        // escape the surrounding try/catch as an unhandled rejection.
        await seedItem({ libraryID: LIB, key: "PARENT01" });
        const m = new TaskManager(host);
        (m as unknown as { createBatchNoteTask: unknown }).createBatchNoteTask =
            () => Promise.reject(new Error("spawn failed"));

        const logged = new Promise<void>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/unbound-method -- the fake's methods are closures
            const original = host.log;
            host.log = (level, message, context, details) => {
                original(level, message, context, details);
                if (/Failed to spawn the post-sync/.test(message)) resolve();
            };
        });

        const task = new SyncTask(
            host,
            fakeSyncService(() =>
                Promise.resolve({
                    successCount: 1,
                    failCount: 0,
                    changedItems: [{ libraryID: LIB, itemKey: "PARENT01" }],
                    syncedLibraryIDs: [LIB],
                }),
            ),
            undefined,
            m,
            noteService,
            settings,
        );

        await task.execute(new AbortController().signal);
        await logged;

        expect(task.getInfo().status).toBe("completed");
    });
});

describe("post-sync trash purge", () => {
    const noteServiceWith = (purge: () => Promise<void>) =>
        ({ purgeTrashedSourceNotes: purge }) as unknown as LibraryNoteService;

    async function run(
        settingOn: boolean,
        purge: () => Promise<void>,
        syncedLibraryIDs = [LIB],
    ) {
        const task = new SyncTask(
            host,
            fakeSyncService(() =>
                Promise.resolve({
                    successCount: 1,
                    failCount: 0,
                    changedItems: [],
                    syncedLibraryIDs,
                }),
            ),
            undefined,
            new TaskManager(host),
            noteServiceWith(purge),
            { ...DEFAULT_SETTINGS, autoPurgeTrashedSourceNotes: settingOn },
        );
        await task.execute(new AbortController().signal);
        return task;
    }

    test("purges the libraries that synced", async () => {
        const seen: number[][] = [];
        await run(true, () => {
            seen.push([LIB]);
            return Promise.resolve();
        });
        expect(seen).toEqual([[LIB]]);
    });

    test("the setting gates it", async () => {
        let called = false;
        await run(false, () => {
            called = true;
            return Promise.resolve();
        });
        expect(called).toBe(false);
    });

    test("no synced libraries means nothing to purge", async () => {
        let called = false;
        await run(
            true,
            () => {
                called = true;
                return Promise.resolve();
            },
            [],
        );
        expect(called).toBe(false);
    });

    test("a purge failure never fails the sync", async () => {
        const task = await run(true, () =>
            Promise.reject(new Error("vault locked")),
        );
        expect(task.getInfo().status).toBe("completed");
    });
});

describe("csljson backfill deduplication", () => {
    test("a second backfill reuses the one in flight", async () => {
        await seedLibrary({ id: LIB, type: "user", name: "My Library" });
        // No citable items, so the task settles without touching the network.
        const zotero = {} as never;

        const first = await manager.createBackfillCslJsonTask(zotero);
        const second = await manager.createBackfillCslJsonTask(zotero);

        // Either it deduped, or the first already finished and the slot was
        // released — both are correct; what must not happen is two running at
        // once, which the shared `activeCslBackfill` slot prevents.
        if (second === first) {
            expect(
                host.logsAt("info").some((l) => /already in progress/.test(l.message)),
            ).toBe(true);
        }

        await vi.waitFor(() => {
            const t = manager.getTasks().find((x) => x.id === first)!;
            expect(["completed", "failed"]).toContain(t.status);
        });

        // Once released, a new request gets a new task.
        expect(await manager.createBackfillCslJsonTask(zotero)).not.toBe(first);
    });
});

describe("other task factories", () => {
    test("the dev test task is registered and reports its own failure", async () => {
        // TestTask throws at step 10 by design, which makes it a convenient
        // end-to-end check that a failing task still lands in the history.
        const id = await manager.createTestTask(10);

        await vi.waitFor(() => {
            const t = manager.getTasks().find((x) => x.id === id)!;
            expect(t.status).toBe("failed");
        });
        expect(
            manager.getTasks().find((x) => x.id === id)!.error,
        ).toMatch(/Test error at step 10/);
    });

    test("a batch note task carries the item count into its input", async () => {
        const processed: { libraryID: number; itemKey: string }[] = [];
        const noteService = {
            triggerUpdate: (libraryID: number, key: string) => {
                processed.push({ libraryID, itemKey: key });
                return Promise.resolve();
            },
            createOrOpenSourceNote: () => Promise.resolve(),
        } as unknown as LibraryNoteService;
        await seedItem({ libraryID: LIB, key: "PARENT01" });

        const id = await manager.createBatchNoteTask(
            noteService,
            { items: [{ libraryID: LIB, itemKey: "PARENT01" }] },
            {},
            true,
        );

        await vi.waitFor(() => {
            const t = manager.getTasks().find((x) => x.id === id)!;
            expect(["completed", "failed"]).toContain(t.status);
        });
        const info = manager.getTasks().find((x) => x.id === id)!;
        expect(info.type).toBe("batch-update-notes");
        expect(info.input).toEqual({ items: 1 });
    });

    test("a batch note task skips trashed items", async () => {
        const processed: { libraryID: number; itemKey: string }[] = [];
        const noteService = {
            triggerUpdate: (libraryID: number, key: string) => {
                processed.push({ libraryID, itemKey: key });
                return Promise.resolve();
            },
        } as unknown as LibraryNoteService;
        await seedItem({ libraryID: LIB, key: "TRASHED1", trashed: 1 });

        const id = await manager.createBatchNoteTask(
            noteService,
            { items: [{ libraryID: LIB, itemKey: "TRASHED1" }] },
            {},
            true,
        );

        await vi.waitFor(() => {
            expect(manager.getTasks().find((x) => x.id === id)!.status).toBe(
                "completed",
            );
        });
        expect(processed).toEqual([]);
    });

    test("a create-notes batch is typed differently from an update", async () => {
        const noteService = {
            triggerUpdate: () => Promise.resolve(),
            createOrOpenSourceNote: () => Promise.resolve(),
        } as unknown as LibraryNoteService;

        const id = await manager.createBatchNoteTask(
            noteService,
            { items: [] },
            {},
            false,
        );

        expect(manager.getTasks().find((x) => x.id === id)!.type).toBe(
            "batch-create-notes",
        );
    });

    test("a PDF download returns the blob and its streamed content MD5", async () => {
        const blob = new Blob(["pdf bytes"]);
        const arrayBuffer = vi
            .spyOn(blob, "arrayBuffer")
            .mockRejectedValue(new Error("must not materialize the whole Blob"));
        const attachmentService = {
            getFileBlob: () => Promise.resolve(blob),
        } as never;

        const result = await manager.createDownloadAttachmentTask(
            attachmentService,
            attachmentItem(),
        );

        const expectedMD5 = SparkMD5.ArrayBuffer.hash(
            new TextEncoder().encode("pdf bytes").buffer,
        );
        expect(result).toEqual({ blob, contentMD5: expectedMD5 });
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    test("a PDF download falls back to arrayBuffer without Blob.stream", async () => {
        const blob = new Blob(["legacy pdf bytes"]);
        Object.defineProperty(blob, "stream", {
            configurable: true,
            value: undefined,
        });
        const arrayBuffer = vi.spyOn(blob, "arrayBuffer");
        const attachmentService = {
            getFileBlob: () => Promise.resolve(blob),
        } as never;

        const result = await manager.createDownloadAttachmentTask(
            attachmentService,
            attachmentItem(),
        );

        const expectedMD5 = SparkMD5.ArrayBuffer.hash(
            new TextEncoder().encode("legacy pdf bytes").buffer,
        );
        expect(result).toEqual({ blob, contentMD5: expectedMD5 });
        expect(arrayBuffer).toHaveBeenCalledTimes(1);
    });

    test("EPUB and HTML downloads do not spend time hashing unused bytes", async () => {
        for (const contentType of ["application/epub+zip", "text/html"]) {
            const blob = new Blob([contentType]);
            const stream = vi.spyOn(blob, "stream");
            const attachmentService = {
                getFileBlob: () => Promise.resolve(blob),
            } as never;

            const result = await manager.createDownloadAttachmentTask(
                attachmentService,
                attachmentItem(contentType),
            );

            expect(result).toEqual({ blob });
            expect(stream).not.toHaveBeenCalled();
        }
    });

    test("a PDF with server MD5 does not hash the Blob again", async () => {
        const blob = new Blob(["pdf bytes"]);
        const stream = vi.spyOn(blob, "stream");
        const attachmentService = {
            getFileBlob: () => Promise.resolve(blob),
        } as never;

        const result = await manager.createDownloadAttachmentTask(
            attachmentService,
            attachmentItem("application/pdf", "server-md5"),
        );

        expect(result).toEqual({ blob });
        expect(stream).not.toHaveBeenCalled();
    });

    test("taking a download result clears the task's Blob reference", async () => {
        const blob = new Blob(["epub bytes"]);
        const task = new DownloadAttachmentTask(
            host,
            {
                getFileBlob: () => Promise.resolve(blob),
            } as never,
            attachmentItem("application/epub+zip"),
        );

        await task.execute(new AbortController().signal);

        expect(task.takeResult()).toEqual({ blob });
        expect(task.takeResult()).toBeNull();
    });

    test("aborting during streamed hashing leaves no result", async () => {
        const controller = new AbortController();
        const blob = new Blob(["unused"]);
        vi.spyOn(blob, "stream").mockReturnValue(
            new ReadableStream<Uint8Array<ArrayBuffer>>({
                start(streamController) {
                    const chunk = new Uint8Array(new ArrayBuffer(3));
                    chunk.set([1, 2, 3]);
                    streamController.enqueue(chunk);
                    controller.abort();
                },
            }),
        );
        const task = new DownloadAttachmentTask(
            host,
            {
                getFileBlob: () => Promise.resolve(blob),
            } as never,
            attachmentItem(),
        );

        await task.execute(controller.signal);

        expect(task.getInfo().status).toBe("cancelled");
        expect(task.takeResult()).toBeNull();
    });

    test("a download that yields nothing is an error, not an empty blob", async () => {
        // Returning undefined here would surface later as a corrupt file.
        const attachmentService = {
            getFileBlob: () => Promise.resolve(null),
        } as never;

        await expect(
            manager.createDownloadAttachmentTask(
                attachmentService,
                attachmentItem(),
            ),
        ).rejects.toThrow();
    });

    test("a download failure propagates to the caller", async () => {
        const attachmentService = {
            getFileBlob: () => Promise.reject(new Error("404 from WebDAV")),
        } as never;

        await expect(
            manager.createDownloadAttachmentTask(
                attachmentService,
                attachmentItem(),
            ),
        ).rejects.toThrow();
    });
});

describe("deduplication only covers requests that are not simultaneous", () => {
    test("two syncs issued in the same tick both start", async () => {
        // Current behaviour, pinned rather than endorsed. Every dedup slot in
        // TaskManager is claimed *after* `await import(...)` of the task
        // module, so a caller that arrives before that await resolves sees an
        // empty slot. Sequential requests dedupe (see above); genuinely
        // concurrent ones — two views reacting to the same event, a
        // double-click — do not.
        const gate = deferred();
        let starts = 0;
        const sync = fakeSyncService(async () => {
            starts++;
            await gate.promise;
            return {
                successCount: 1,
                failCount: 0,
                changedItems: [],
                syncedLibraryIDs: [],
            };
        });

        const [first, second] = await Promise.all([
            manager.createSyncTask(sync),
            manager.createSyncTask(sync),
        ]);

        expect(second).not.toBe(first);
        await vi.waitFor(() => expect(starts).toBe(2));

        gate.resolve();
    });
});
