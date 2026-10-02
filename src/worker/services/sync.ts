import Dexie from "dexie";

import { db } from "db/db";
import { normalizeCollection } from "db/normalize";
import {

    deleteQueueEntry,
    getDescendants,
    putGroup,
    putQueueEntry,
    readKey,
    setNeedsFullSync,
    syncTransaction,
    SyncWriter,
} from "db/sync/commit";
import {
    afterWrite,
    beforeSend,
    fromServer,
    hasPendingChanges,
    isLocalRecreation,
    joinGroup,
    markForRecreation,
    onRemoteObject,
    settleJournal,
} from "db/sync/decide";
import { workerClearTimeout, workerSetTimeout } from "worker/timers";
import {
    errorMessage,
    errorStatus,
    ZotFlowError,
    ZotFlowErrorCode,
} from "utils/error";

import type { ZoteroAPIService } from "./zotero";
import type { LibraryService } from "./library";
import type { ZotFlowSettings, LibrarySyncMode } from "settings/types";
import type { IParentProxy } from "bridge/types";
import type { ItemIdentifier } from "worker/tasks/impl/batch-extract-images-task";
import type { AnyZoteroItem, ZoteroCollection } from "types/zotero";
import type { AnyIDBZoteroItem, IDBZoteroCollection, ItemDataJSON } from "types/db-schema";
import type { FollowUp, WriteObject, WriteResult } from "db/sync/decide";
import type { KeyState } from "db/sync/model";

/* ================================================================ */
/*  Constants (docs/sync-architecture.md §7.5)                       */
/* ================================================================ */

/** Keys per `itemKey=` request; the server silently truncates beyond 100. */
const FETCH_BULK_SIZE = 100;
/** Objects per write request (API limit). */
const WRITE_BULK_SIZE = 50;
/** Keys per batch DELETE. */
const DELETE_BULK_SIZE = 50;
/** Upload/download rounds per library per sync (Zotero's `maxUploadTries`). */
const MAX_SYNC_ATTEMPTS = 5;
/** Waits before retrying after the library changed under us, in seconds (Zotero's `conflictDelayIntervals`). */
const CONFLICT_DELAYS_S = [10, 20, 40, 60, 120, 240, 300];
/** Restarts of a download whose library changed mid-way before the library's sync fails. */
const MAX_DOWNLOAD_RESTARTS = 3;
/** Waits after a 429, in seconds (Zotero's `rateDelayIntervals`). */
const RATE_DELAYS_S = [30, 60, 300];
/** Retry intervals for queued objects, in hours (Zotero's `_syncQueueIntervals`). */
const QUEUE_INTERVALS_H = [0.5, 1, 4, 16, 16, 16, 16, 16, 16, 16, 64];

/** How an upload pass ended (§4.1). */
type UploadOutcome = "success" | "nothing" | "library-conflict" | "object-conflict" | "restart";

/** Zotero's multi-write response body, keyed by the object's index in the request. */
interface WriteResponse {
    successful?: Record<string, AnyZoteroItem>;
    unchanged?: Record<string, unknown>;
    failed?: Record<string, { code?: number; message?: string }>;
}

/** The library changed while a download was reading it: start the download again. */
class DownloadRestart extends Error {}

/** Options a test may override. */
export interface SyncServiceOptions {
    /** Waits `ms`, rejecting if `signal` aborts. Tests pass a no-op. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** The clock (epoch ms), for the retry queue. */
    now?: () => number;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Aborted"));
            return;
        }
        const timer = workerSetTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            workerClearTimeout(timer);
            reject(new Error("Aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function chunk<T>(array: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

function libraryRange(libraryID: number): [[number, unknown], [number, unknown]] {
    return [
        [libraryID, Dexie.minKey],
        [libraryID, Dexie.maxKey],
    ];
}

/**
 * Bidirectional sync engine, after Zotero's (docs/sync-architecture.md §4):
 * per library, upload first and download after; a download is consistent
 * (one library version throughout) and moves the cursor only when complete;
 * every decision is a pure function in `db/sync/decide.ts`, applied in a
 * Dexie transaction that re-reads the object's state first.
 */
export class SyncService {
    private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private now: () => number;

    constructor(
        private zotero: ZoteroAPIService,
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        private library: LibraryService,
        options: SyncServiceOptions = {},
    ) {
        this.sleep = options.sleep ?? abortableSleep;
        this.now = options.now ?? (() => Date.now());
    }

    public updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /**
     * Start the synchronization process.
     * This is the main entry point for the worker sync task.
     */
    async startSync(
        signal?: AbortSignal,
        onProgress?: (completed: number, total: number, message: string) => void,
        libraryId?: number,
    ): Promise<{
        successCount: number;
        failCount: number;
        changedItems: ItemIdentifier[];
        syncedLibraryIDs: number[];
    }> {
        const nothing = { successCount: 0, failCount: 0, changedItems: [], syncedLibraryIDs: [] };
        if (signal?.aborted) return nothing;

        if (!navigator.onLine) {
            throw new ZotFlowError(ZotFlowErrorCode.NETWORK_ERROR, "SyncService", "Device is offline");
        }

        const apiKey = this.settings.zoteroapikey;
        const librariesConfig = this.settings.librariesConfig;

        if (!apiKey) {
            throw new ZotFlowError(ZotFlowErrorCode.CONFIG_MISSING, "SyncService", "API Key missing");
        }

        let keyInfo;
        try {
            keyInfo = await db.keys.get(apiKey);
        } catch (e) {
            throw ZotFlowError.wrap(e, ZotFlowErrorCode.DB_OPEN_FAILED, "SyncService", "Failed to query Key DB");
        }

        if (!keyInfo) {
            throw new ZotFlowError(ZotFlowErrorCode.AUTH_INVALID, "SyncService", "API Key not found in local DB");
        }

        const libraries = [...(keyInfo.joinedGroups || [])];
        libraries.unshift(keyInfo.userID);

        if (!librariesConfig) {
            this.parentHost.log("warn", "No libraries configured for sync.", "SyncService");
            return nothing;
        }

        const activeLibraries: number[] = [];
        if (libraryId !== undefined) {
            const libConfig = librariesConfig[libraryId];
            const lib = await db.libraries.get(libraryId);
            if (lib && libConfig && libConfig.mode !== "ignored") {
                activeLibraries.push(libraryId);
            } else {
                this.parentHost.log("warn", `Library ${libraryId} is ignored or not found.`, "SyncService");
                return nothing;
            }
        } else {
            for (const libKey of libraries) {
                const libConfig = librariesConfig[libKey];
                const lib = await db.libraries.get(libKey);
                if (lib && libConfig && libConfig.mode !== "ignored") activeLibraries.push(libKey);
            }
        }

        let successCount = 0;
        let failCount = 0;
        const changedItems: ItemIdentifier[] = [];

        this.parentHost.log("debug", "Starting sync", "SyncService");

        try {
            const totalLibs = activeLibraries.length;
            for (let i = 0; i < activeLibraries.length; i++) {
                const libKey = activeLibraries[i]!;
                if (signal?.aborted) throw new Error("Aborted");
                const libConfig = librariesConfig[libKey];
                const lib = await db.libraries.get(libKey);
                if (!lib || !libConfig || libConfig.mode === "ignored") continue;

                onProgress?.(i, totalLibs, `Syncing library: ${lib.name}`);

                try {
                    await this.syncLibrary(lib.type, libKey, libConfig.mode, changedItems, signal);
                    await db.libraries.update(libKey, {
                        syncedAt: new Date().toISOString().split(".")[0] + "Z",
                    });
                    successCount++;
                } catch (error: unknown) {
                    if (signal?.aborted) throw error;
                    failCount++;
                    const msg = errorMessage(error);
                    this.parentHost.log("error", msg, "SyncService", error);
                    this.parentHost.notify("error", `Library ${libKey} Sync Failed: ${msg}`);
                }
            }

            onProgress?.(totalLibs, totalLibs, "Sync completed");

            if (failCount === 0) {
                this.parentHost.notify("success", "Sync completed successfully!");
            } else {
                this.parentHost.notify("info", `Sync finished with ${failCount} errors.`);
            }

            return { successCount, failCount, changedItems, syncedLibraryIDs: activeLibraries };
        } catch (error) {
            this.parentHost.log("error", errorMessage(error), "SyncService", error);
            this.parentHost.notify("error", `Critical Sync Failure: ${errorMessage(error)}`);
            throw error;
        } finally {
            this.parentHost.log("info", "Sync finished.", "SyncService");
        }
    }

    /* ================================================================ */
    /*  One library (§4.1)                                              */
    /* ================================================================ */

    /**
     * Syncs one library: collections, then (bidirectional) upload and
     * download rounds until nothing is left to upload, or (read-only) a
     * download.
     */
    async syncLibrary(
        libraryType: "user" | "group",
        libraryID: number,
        mode: LibrarySyncMode,
        changedItems: ItemIdentifier[] = [],
        signal?: AbortSignal,
    ): Promise<void> {
        await this.pullCollections(libraryType, libraryID);

        const lib = await db.libraries.get(libraryID);
        const hasLocalData = (await db.items.where("[libraryID+key]").between(...libraryRange(libraryID)).count()) > 0;
        if (lib?.needsFullSync || (!lib?.itemVersion && hasLocalData)) {
            await this.fullSync(libraryType, libraryID, changedItems, signal);
        }

        if (mode !== "bidirectional") {
            await this.download(libraryType, libraryID, changedItems, signal);
            return;
        }

        for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
            if (signal?.aborted) throw new Error("Aborted");
            const outcome = await this.upload(libraryType, libraryID, signal);
            switch (outcome) {
                case "success":
                case "nothing": {
                    const more = await this.download(libraryType, libraryID, changedItems, signal);
                    if (!more) return;
                    break;
                }
                case "library-conflict":
                    this.parentHost.log(
                        "info",
                        `Library ${libraryID} changed during upload (412, attempt ${attempt + 1}/${MAX_SYNC_ATTEMPTS}); downloading before retrying`,
                        "SyncService",
                    );
                    if (attempt > 0) await this.sleep(CONFLICT_DELAYS_S[attempt - 1]! * 1000, signal);
                    await this.download(libraryType, libraryID, changedItems, signal);
                    break;
                case "object-conflict":
                    await this.fullSync(libraryType, libraryID, changedItems, signal);
                    break;
                case "restart":
                    break;
            }
        }
        this.parentHost.log(
            "warn",
            `Library ${libraryID}: changes still waiting after ${MAX_SYNC_ATTEMPTS} rounds; they will sync next time.`,
            "SyncService",
        );
    }

    /* ================================================================ */
    /*  API helpers                                                     */
    /* ================================================================ */

    private lib(libraryType: "user" | "group", libraryID: number) {
        return this.zotero.client.library(libraryType, libraryID);
    }

    /** Runs a request, waiting out 429s and 503s with the server's or Zotero's delays. */
    private async request<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (e) {
                const status = errorStatus(e);
                if ((status !== 429 && status !== 503) || attempt >= RATE_DELAYS_S.length) throw e;
                const headers = (e as { response?: { headers?: Headers } }).response?.headers;
                const retryAfter = Number(headers?.get?.("Retry-After") ?? headers?.get?.("Backoff") ?? NaN);
                const wait = Number.isFinite(retryAfter) ? retryAfter : RATE_DELAYS_S[attempt]!;
                this.parentHost.log("warn", `Zotero asked to slow down (${status}); waiting ${wait}s`, "SyncService");
                await this.sleep(wait * 1000, signal);
            }
        }
    }

    private nowISO(): string {
        return new Date(this.now()).toISOString();
    }

    /* ================================================================ */
    /*  Collections (pull-only)                                         */
    /* ================================================================ */

    private async pullCollections(libraryType: "user" | "group", libraryID: number) {
        try {
            const libHandle = this.lib(libraryType, libraryID);
            const libState = await db.libraries.get(libraryID);
            const localVersion = libState?.collectionVersion || 0;

            this.parentHost.log("debug", `Pulling collections from v${localVersion}...`, "SyncService");

            const response = await this.request(() =>
                libHandle.collections().get({ format: "versions", since: localVersion, includeTrashed: true }),
            );
            const versionsMap = (await (response.raw as Response).json()) as Record<string, number>;
            const serverHeaderVersion = response.getVersion() || 0;

            if (serverHeaderVersion <= localVersion) {
                this.parentHost.log("debug", "Collections are up to date.", "SyncService");
                return;
            }

            const keysToFetch = Object.keys(versionsMap);
            for (const slice of chunk(keysToFetch, FETCH_BULK_SIZE)) {
                const batchRes = await this.request(() =>
                    libHandle.collections().get({ collectionKey: slice.join(","), includeTrashed: true }),
                );
                const newCollections = batchRes.raw as ZoteroCollection[];
                if (newCollections.length > 0) {
                    // Collections are pull-only: nothing in the plugin edits
                    // one locally, so the server copy always wins.
                    await db.transaction("rw", db.collections, async () => {
                        await db.collections.bulkPut(newCollections.map((c) => normalizeCollection(c, libraryID)));
                    });
                }
            }

            if (localVersion > 0) {
                const delResponse = await this.request(() => libHandle.deleted(localVersion).get());
                const deletedKeys = (delResponse.getData() as { collections: string[] }).collections;
                if (deletedKeys.length > 0) await this.deleteCollections(libraryID, deletedKeys);
            }

            await db.libraries.update(libraryID, { collectionVersion: serverHeaderVersion });
        } catch (e) {
            throw ZotFlowError.wrap(e, ZotFlowErrorCode.NETWORK_ERROR, "SyncService", "Pull Collections failed");
        }
    }

    private async deleteCollections(libraryID: number, keys: string[]) {
        await db.transaction("rw", db.collections, async () => {
            for (const key of keys) {
                if (!(await db.collections.get([libraryID, key]))) continue;
                const family = [key, ...(await this.collectionDescendants(libraryID, key))];
                await db.collections.bulkDelete(family.map((k) => [libraryID, k]));
            }
        });
    }

    private async collectionDescendants(libraryID: number, key: string): Promise<string[]> {
        const out: string[] = [];
        const seen = new Set([key]);
        let frontier = [key];
        while (frontier.length > 0) {
            const next: string[] = [];
            for (const parent of frontier) {
                const children: IDBZoteroCollection[] = await db.collections
                    .where({ libraryID, parentCollection: parent })
                    .toArray();
                for (const c of children) {
                    if (seen.has(c.key)) continue;
                    seen.add(c.key);
                    out.push(c.key);
                    next.push(c.key);
                }
            }
            frontier = next;
        }
        return out;
    }

    /* ================================================================ */
    /*  Download (§4.2)                                                 */
    /* ================================================================ */

    /**
     * Downloads every change since the cursor and moves the cursor.
     *
     * @returns whether rows remain to upload.
     */
    async download(
        libraryType: "user" | "group",
        libraryID: number,
        changedItems: ItemIdentifier[] = [],
        signal?: AbortSignal,
    ): Promise<boolean> {
        for (let restart = 0; ; restart++) {
            try {
                return await this.downloadOnce(libraryType, libraryID, changedItems, signal);
            } catch (e) {
                if (!(e instanceof DownloadRestart)) {
                    throw ZotFlowError.wrap(e, ZotFlowErrorCode.NETWORK_ERROR, "SyncService", "Pull Items failed");
                }
                if (restart >= MAX_DOWNLOAD_RESTARTS) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.NETWORK_ERROR,
                        "SyncService",
                        `Library ${libraryID} kept changing during the download; try again later`,
                    );
                }
                this.parentHost.log(
                    "info",
                    `Library ${libraryID} changed during the download; restarting (${restart + 1}/${MAX_DOWNLOAD_RESTARTS})`,
                    "SyncService",
                );
                await this.sleep(CONFLICT_DELAYS_S[restart]! * 1000, signal);
            }
        }
    }

    private async downloadOnce(
        libraryType: "user" | "group",
        libraryID: number,
        changedItems: ItemIdentifier[],
        signal?: AbortSignal,
    ): Promise<boolean> {
        const libHandle = this.lib(libraryType, libraryID);
        const since = (await db.libraries.get(libraryID))?.itemVersion || 0;

        this.parentHost.log("debug", `Pulling items from v${since}...`, "SyncService");

        const response = await this.request(
            () => libHandle.items().get({ format: "versions", since, includeTrashed: true }),
            signal,
        );
        const versions = (await (response.raw as Response).json()) as Record<string, number>;
        const v0 = response.getVersion() || 0;

        const dueQueue = await this.dueQueueKeys(libraryID);
        const keys = await this.keysToFetch(libraryID, versions);
        for (const k of dueQueue) if (!keys.includes(k)) keys.push(k);

        this.parentHost.log("debug", `Found ${keys.length} items to update.`, "SyncService");
        const queued = await this.fetchAndProcess(libraryType, libraryID, keys, v0, changedItems, signal);

        let deleted: string[] = [];
        if (since > 0 && v0 > since) {
            const delResponse = await this.request(() => libHandle.deleted(since).get(), signal);
            if ((delResponse.getVersion() ?? v0) !== v0) throw new DownloadRestart();
            deleted = (delResponse.getData() as { items?: string[] }).items ?? [];
            await this.processDeletions(libraryID, deleted, changedItems);
        }

        await this.settleJournals(libraryID, queued);
        await db.libraries.update(libraryID, { itemVersion: v0 });
        this.parentHost.log("debug", `Item sync finished. New Version: ${v0}`, "SyncService");

        return (await this.uploadCandidates(libraryID)).length > 0 || (await this.pendingDeletes(libraryID)).length > 0;
    }

    /** Keys from a versions listing whose newer version this device lacks. */
    private async keysToFetch(libraryID: number, versions: Record<string, number>): Promise<string[]> {
        const keys = Object.keys(versions);
        const ids = keys.map((k): [number, string] => [libraryID, k]);
        const [rows, logs, conflicts] = await Promise.all([
            db.items.bulkGet(ids),
            db.syncDeleteLog.bulkGet(ids),
            db.syncConflicts.bulkGet(ids),
        ]);
        return keys.filter((key, i) => {
            const v = versions[key]!;
            const conflict = conflicts[i];
            if (conflict) return v > conflict.remoteVersion;
            const row = rows[i];
            if (row) return v > row.version;
            const log = logs[i];
            if (log) return v > log.version;
            return true;
        });
    }

    /**
     * Fetches `keys` (in requests of 100, each required to answer at
     * library version `v0`) and processes them parents first.
     *
     * @returns the keys put on the retry queue.
     */
    private async fetchAndProcess(
        libraryType: "user" | "group",
        libraryID: number,
        keys: string[],
        v0: number,
        changedItems: ItemIdentifier[],
        signal?: AbortSignal,
    ): Promise<Set<string>> {
        const libHandle = this.lib(libraryType, libraryID);
        const objects: AnyZoteroItem[] = [];
        for (const slice of chunk(keys, FETCH_BULK_SIZE)) {
            if (signal?.aborted) throw new Error("Aborted");
            const res = await this.request(
                () =>
                    libHandle.items().get({
                        itemKey: slice.join(","),
                        includeTrashed: true,
                        // csljson: server-side CSL-JSON, stored for the
                        // citation template filters.
                        include: "data,csljson",
                    }),
                signal,
            );
            if ((res.getVersion() ?? v0) !== v0) throw new DownloadRestart();
            // Only what was asked for (see fetchServerCopy).
            const asked = new Set(slice);
            objects.push(...(res.raw as AnyZoteroItem[]).filter((o) => asked.has(o.key)));
        }

        // Parents before children, so a child never waits for a parent
        // that is in the same download.
        const byKey = new Map(objects.map((o) => [o.key, o]));
        const depth = (o: AnyZoteroItem, seen = new Set<string>()): number => {
            const parent = o.data.parentItem;
            if (!parent || seen.has(o.key)) return 0;
            seen.add(o.key);
            const p = byKey.get(parent);
            return p ? 1 + depth(p, seen) : 1;
        };
        objects.sort((a, b) => depth(a) - depth(b));

        const queued = new Set<string>();
        const now = this.nowISO();
        // One transaction per slice: a subtree's fingerprint is recomputed
        // once per slice, not once per object (a PDF with k annotations
        // would otherwise cost k² row reads on its first download).
        for (const slice of chunk(objects, FETCH_BULK_SIZE)) {
            const outcomes = await syncTransaction(async () => {
                const writer = new SyncWriter(libraryID);
                const out: string[] = [];
                for (const remote of slice) {
                    const state = await readKey(libraryID, remote.key);
                    const parent = remote.data.parentItem;
                    const parentExists = !parent || !!(await db.items.get([libraryID, parent]));
                    const result = onRemoteObject(state, remote, { libraryID, parentExists, now });
                    out.push(result.outcome);
                    const entry = await db.syncQueue.get([libraryID, remote.key]);
                    if (result.outcome === "queue") {
                        await putQueueEntry({
                            libraryID,
                            key: remote.key,
                            reason: "missing-parent",
                            tries: (entry?.tries ?? 0) + 1,
                            lastCheck: this.now(),
                        });
                        continue;
                    }
                    await writer.commit(remote.key, state, result.next);
                    if (result.leftGroup) await this.leaveGroup(libraryID, result.leftGroup, remote.key);
                    if (entry) await deleteQueueEntry(libraryID, remote.key);
                }
                return out;
            });
            slice.forEach((remote, i) => {
                const outcome = outcomes[i];
                if (outcome === "queue") {
                    queued.add(remote.key);
                    this.parentHost.log(
                        "warn",
                        `Item ${remote.key} arrived before its parent; it will be retried later.`,
                        "SyncService",
                    );
                } else if (outcome !== "ignored") {
                    changedItems.push({ libraryID, itemKey: remote.key });
                }
            });
        }
        return queued;
    }

    private async leaveGroup(libraryID: number, group: string, key: string) {
        const record = await db.syncGroups.get([libraryID, group]);
        if (record) await putGroup({ ...record, members: record.members.filter((m) => m !== key) });
    }

    /** Queued download keys whose retry is due. */
    private async dueQueueKeys(libraryID: number): Promise<string[]> {
        const now = this.now();
        const entries = await db.syncQueue.where("[libraryID+key]").between(...libraryRange(libraryID)).toArray();
        return entries
            .filter((e) => e.reason === "missing-parent" && this.isDue(e.tries, e.lastCheck, now))
            .map((e) => e.key);
    }

    private isDue(tries: number, lastCheck: number, now: number): boolean {
        const hours = QUEUE_INTERVALS_H[Math.min(tries, QUEUE_INTERVALS_H.length) - 1] ?? 0;
        return now - lastCheck >= hours * 3600_000;
    }

    /**
     * Applies remote deletions (§4.4). A deleted subtree with nothing
     * pending goes; one holding local changes becomes one conflict group
     * (§5.4) whose members are the changed rows and their ancestors.
     */
    private async processDeletions(libraryID: number, keys: string[], changedItems: ItemIdentifier[]) {
        if (keys.length === 0) return;
        const deleted = new Set(keys);
        const imageKeys: string[] = [];

        // Keys with no row: only bookkeeping is left.
        await syncTransaction(async () => {
            const writer = new SyncWriter(libraryID);
            for (const key of keys) {
                const state = await readKey(libraryID, key);
                if (state.row) continue;
                if (state.cache || state.deleteLog || state.journal || state.conflict) {
                    await writer.commit(key, state, {});
                }
                await deleteQueueEntry(libraryID, key);
            }
        });

        const present = (await db.items.bulkGet(keys.map((k): [number, string] => [libraryID, k]))).filter(
            (r): r is AnyIDBZoteroItem => !!r,
        );
        const presentKeys = new Set(present.map((r) => r.key));
        const roots = present.filter((r) => !(r.parentItem && deleted.has(r.parentItem) && presentKeys.has(r.parentItem)));

        for (const root of roots) {
            // The top-level item that survives, for its source note.
            const survivor = root.parentItem ? await this.topLevelAncestor(libraryID, root.parentItem) : undefined;
            const removed = await syncTransaction(async () => {
                const writer = new SyncWriter(libraryID);
                const rootState = await readKey(libraryID, root.key);
                if (!rootState.row || isLocalRecreation(rootState)) return [];

                const subtree = [rootState.row, ...(await getDescendants(libraryID, root.key))];
                const states = new Map<string, KeyState>();
                for (const r of subtree) states.set(r.key, await readKey(libraryID, r.key));
                const rowOf = new Map(subtree.map((r) => [r.key, r]));

                const members = new Set<string>();
                for (const r of subtree) {
                    if (!hasPendingChanges(states.get(r.key)!)) continue;
                    // The changed row and every ancestor up to the root,
                    // kept so it can be restored with them.
                    for (let k: string | undefined = r.key; k && rowOf.has(k) && !members.has(k); k = rowOf.get(k)?.parentItem) {
                        members.add(k);
                        if (k === root.key) break;
                    }
                }

                const gone: AnyIDBZoteroItem[] = [];
                const now = this.nowISO();
                for (const r of subtree) {
                    const state = states.get(r.key)!;
                    if (members.has(r.key)) {
                        const old = state.conflict?.group;
                        if (old && old !== root.key) await this.leaveGroup(libraryID, old, r.key);
                        await writer.commit(r.key, state, joinGroup(state, libraryID, r.key, root.key, now));
                    } else if (r.localOnly && members.has(r.parentItem)) {
                        // A local-only row under a kept member stays with it.
                    } else {
                        if (state.conflict?.group) await this.leaveGroup(libraryID, state.conflict.group, r.key);
                        await writer.commit(r.key, state, {});
                        await deleteQueueEntry(libraryID, r.key);
                        gone.push(r);
                    }
                }

                if (members.size > 0) {
                    const existing = await db.syncGroups.get([libraryID, root.key]);
                    await putGroup({
                        libraryID,
                        id: root.key,
                        root: root.key,
                        members: [...new Set([...(existing?.members ?? []), ...members])],
                    });
                    this.parentHost.log(
                        "warn",
                        `${root.key} was deleted in Zotero but holds local changes; kept as a conflict.`,
                        "SyncService",
                    );
                }
                return gone;
            });

            for (const r of removed) {
                if (r.itemType === "annotation" && ["image", "ink"].includes(String(r.raw?.data?.annotationType))) {
                    imageKeys.push(r.key);
                }
            }
            if (removed.length > 0) {
                this.parentHost.log("debug", `Deleted ${root.key} and ${removed.length - 1} descendants.`, "SyncService");
                if (survivor) changedItems.push({ libraryID, itemKey: survivor });
            }
        }

        // File I/O never runs inside a Dexie transaction.
        for (const key of imageKeys) await this.deleteAnnotationImageFile(key);
    }

    private async topLevelAncestor(libraryID: number, key: string): Promise<string | undefined> {
        const seen = new Set<string>();
        let row = await db.items.get([libraryID, key]);
        while (row?.parentItem && !seen.has(row.key)) {
            seen.add(row.key);
            row = await db.items.get([libraryID, row.parentItem]);
        }
        return row?.key;
    }

    /**
     * After a complete download, a write still in the journal did not land:
     * if it had, the download would have returned its object (§4.5).
     */
    private async settleJournals(libraryID: number, skip: Set<string>) {
        const journals = await db.uploadJournal.where("[libraryID+key]").between(...libraryRange(libraryID)).toArray();
        if (journals.length === 0) return;
        await syncTransaction(async () => {
            const writer = new SyncWriter(libraryID);
            for (const j of journals) {
                if (skip.has(j.key)) continue;
                const state = await readKey(libraryID, j.key);
                if (!state.journal) continue;
                const next = settleJournal(state);
                await writer.commit(j.key, state, next);
                const group = state.conflict?.group;
                if (group && !next.conflict) await this.leaveGroup(libraryID, group, j.key);
            }
        });
    }

    /**
     * Delete a rendered annotation image (`{folder}/{key}.png`) from the vault,
     * if it exists. Best-effort — failures are logged, never thrown.
     */
    private async deleteAnnotationImageFile(annotationKey: string) {
        const folder = this.settings.annotationImageFolder.replace(/\/$/, "");
        const path = `${folder}/${annotationKey}.png`;
        try {
            const exists = await this.parentHost.checkFile(path);
            if (exists.exists) {
                await this.parentHost.deleteFile(path);
                this.parentHost.log("debug", `Deleted orphaned annotation image: ${path}`, "SyncService");
            }
        } catch (e) {
            this.parentHost.log("warn", `Failed to delete annotation image ${annotationKey}`, "SyncService", e);
        }
    }

    /* ================================================================ */
    /*  Full sync (§4.7)                                                */
    /* ================================================================ */

    /**
     * Compares every object with the server: after an object-level 404/412,
     * or when local data exists without a cursor.
     */
    async fullSync(
        libraryType: "user" | "group",
        libraryID: number,
        changedItems: ItemIdentifier[] = [],
        signal?: AbortSignal,
    ): Promise<void> {
        for (let restart = 0; ; restart++) {
            try {
                await this.fullSyncOnce(libraryType, libraryID, changedItems, signal);
                return;
            } catch (e) {
                if (!(e instanceof DownloadRestart)) {
                    throw ZotFlowError.wrap(e, ZotFlowErrorCode.NETWORK_ERROR, "SyncService", "Full sync failed");
                }
                if (restart >= MAX_DOWNLOAD_RESTARTS) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.NETWORK_ERROR,
                        "SyncService",
                        `Library ${libraryID} kept changing during the full sync; try again later`,
                    );
                }
                await this.sleep(CONFLICT_DELAYS_S[restart]! * 1000, signal);
            }
        }
    }

    private async fullSyncOnce(
        libraryType: "user" | "group",
        libraryID: number,
        changedItems: ItemIdentifier[],
        signal?: AbortSignal,
    ) {
        this.parentHost.log("info", `Full sync of library ${libraryID}`, "SyncService");
        const libHandle = this.lib(libraryType, libraryID);
        const response = await this.request(
            () => libHandle.items().get({ format: "versions", includeTrashed: true }),
            signal,
        );
        const versions = (await (response.raw as Response).json()) as Record<string, number>;
        const v0 = response.getVersion() || 0;

        const keys = await this.keysToFetch(libraryID, versions);
        const queued = await this.fetchAndProcess(libraryType, libraryID, keys, v0, changedItems, signal);

        // Rows the server does not have: deleted remotely (the deletion log
        // may have expired), or — with unsynced changes and nothing deleted
        // above them — to be created again.
        const rows = await db.items.where("[libraryID+key]").between(...libraryRange(libraryID)).toArray();
        const missing = rows.filter((r) => !r.localOnly && r.version > 0 && !(r.key in versions));
        const missingKeys = new Set(missing.map((r) => r.key));
        const recreate: string[] = [];
        const removed: string[] = [];
        for (const r of missing) {
            const state = await readKey(libraryID, r.key);
            const underMissing = r.parentItem && missingKeys.has(r.parentItem);
            if (r.synced === 0 && !state.conflict && !underMissing) recreate.push(r.key);
            else removed.push(r.key);
        }
        if (recreate.length > 0) {
            await syncTransaction(async () => {
                const writer = new SyncWriter(libraryID);
                for (const key of recreate) await writer.update(key, markForRecreation);
            });
        }
        await this.processDeletions(libraryID, removed, changedItems);

        // Pending deletes the server no longer has anything to apply to.
        const deletedRes = await this.request(() => libHandle.deleted(0).get(), signal);
        if ((deletedRes.getVersion() ?? v0) !== v0) throw new DownloadRestart();
        const deletedRemotely = new Set((deletedRes.getData() as { items?: string[] }).items ?? []);
        const logs = await db.syncDeleteLog.where("[libraryID+key]").between(...libraryRange(libraryID)).toArray();
        const settled = logs.filter((l) => deletedRemotely.has(l.key) || !(l.key in versions));
        if (settled.length > 0) {
            await syncTransaction(async () => {
                const writer = new SyncWriter(libraryID);
                for (const l of settled) {
                    const state = await readKey(libraryID, l.key);
                    if (!state.row) await writer.commit(l.key, state, {});
                }
            });
        }

        await this.settleJournals(libraryID, queued);
        await db.libraries.update(libraryID, { itemVersion: v0, needsFullSync: false });
    }

    /* ================================================================ */
    /*  Upload (§4.6)                                                   */
    /* ================================================================ */

    /**
     * Rows to upload, parents first: unsynced, not in conflict, no write of
     * unknown outcome, not waiting on the retry queue, and not under a new
     * item that cannot be created yet.
     */
    private async uploadCandidates(libraryID: number): Promise<AnyIDBZoteroItem[]> {
        const dirty = await db.items
            .where("[libraryID+syncStatus]")
            .anyOf([
                [libraryID, "created"],
                [libraryID, "updated"],
            ])
            .toArray();
        if (dirty.length === 0) return [];

        const hasNotesAccess = await this.library.hasNotesAccess(libraryID);
        const ids = dirty.map((r): [number, string] => [libraryID, r.key]);
        const [journals, queue] = await Promise.all([db.uploadJournal.bulkGet(ids), db.syncQueue.bulkGet(ids)]);
        const now = this.now();
        let heldNotes = 0;
        const eligible = dirty.filter((r, i) => {
            if (journals[i]) return false;
            const q = queue[i];
            if (q && !this.isDue(q.tries, q.lastCheck, now)) return false;
            if (!hasNotesAccess && r.itemType === "note") {
                heldNotes++;
                return false;
            }
            return true;
        });
        if (heldNotes > 0) {
            this.parentHost.log(
                "warn",
                `Skipping ${heldNotes} dirty note item(s) on push for library ${libraryID} (no notes permission).`,
                "SyncService",
            );
        }

        // A child of a new item can be created only after it; if the parent
        // is held back, so is the child.
        const eligibleKeys = new Set(eligible.map((r) => r.key));
        const depthOf = new Map<string, number>();
        const blocked = async (r: AnyIDBZoteroItem): Promise<boolean> => {
            let parentKey = r.parentItem;
            let depth = 0;
            const seen = new Set([r.key]);
            while (parentKey && !seen.has(parentKey)) {
                seen.add(parentKey);
                depth++;
                const parent = await db.items.get([libraryID, parentKey]);
                if (!parent) break;
                if (parent.version === 0 && !eligibleKeys.has(parent.key)) return true;
                parentKey = parent.parentItem;
            }
            depthOf.set(r.key, depth);
            return false;
        };
        const out: AnyIDBZoteroItem[] = [];
        for (const r of eligible) if (!(await blocked(r))) out.push(r);
        return out.sort((a, b) => (depthOf.get(a.key) ?? 0) - (depthOf.get(b.key) ?? 0) || a.key.localeCompare(b.key));
    }

    private async pendingDeletes(libraryID: number): Promise<string[]> {
        const logs = await db.syncDeleteLog.where("[libraryID+key]").between(...libraryRange(libraryID)).toArray();
        if (logs.length === 0) return [];
        const conflicts = await db.syncConflicts.bulkGet(logs.map((l): [number, string] => [libraryID, l.key]));
        return logs.filter((_, i) => !conflicts[i]).map((l) => l.key);
    }

    /** Uploads unsynced rows, then pending deletes, along one precondition chain. */
    async upload(libraryType: "user" | "group", libraryID: number, signal?: AbortSignal): Promise<UploadOutcome> {
        if (!this.settings.zoteroapikey) {
            throw new ZotFlowError(ZotFlowErrorCode.CONFIG_MISSING, "SyncService", "No API key found for push.");
        }
        const candidates = await this.uploadCandidates(libraryID);
        const deletes = await this.pendingDeletes(libraryID);
        if (candidates.length === 0 && deletes.length === 0) return "nothing";

        this.parentHost.log(
            "debug",
            `Pushing changes: ${deletes.length} deletions, ${candidates.length} upserts.`,
            "SyncService",
        );

        let version = (await db.libraries.get(libraryID))?.itemVersion || 0;
        let fullSyncNeeded = false;
        let restart = false;
        const libHandle = this.lib(libraryType, libraryID);

        for (const batch of chunk(candidates.map((r) => r.key), WRITE_BULK_SIZE)) {
            if (signal?.aborted) throw new Error("Aborted");

            // Built from the rows as they are now, not as they were listed.
            const now = this.nowISO();
            const sent = await syncTransaction(async () => {
                const writer = new SyncWriter(libraryID);
                const out: { key: string; payload: WriteObject; revision: number; data: ItemDataJSON }[] = [];
                for (const key of batch) {
                    const state = await readKey(libraryID, key);
                    const row = state.row;
                    if (!row || row.synced === 1 || row.localOnly || state.conflict || state.journal) continue;
                    if (row.parentItem) {
                        const parent = await db.items.get([libraryID, row.parentItem]);
                        if (parent?.version === 0 && !out.some((o) => o.key === parent.key)) continue;
                    }
                    const { next, payload } = beforeSend(state, key, now);
                    await writer.commit(key, state, next);
                    out.push({ key, payload, revision: next.journal!.revision, data: next.journal!.sent });
                }
                return out;
            });
            if (sent.length === 0) continue;

            let response;
            try {
                response = await this.request(
                    () => libHandle.items().post(sent.map((s) => s.payload), { ifUnmodifiedSinceVersion: version }),
                    signal,
                );
            } catch (e) {
                const status = errorStatus(e);
                // An HTTP error answer means nothing in the request was
                // applied; a dropped connection leaves it unknown, and the
                // journal keeps the question for the next download.
                if (status >= 400) await this.dropJournals(libraryID, sent.map((s) => s.key));
                if (status === 412) {
                    this.parentHost.log("warn", "Library modified during push (412). Retry needed.", "SyncService");
                    return "library-conflict";
                }
                throw e;
            }

            version = response.getVersion() ?? version;
            const body = response.raw as WriteResponse;
            const followUps: { key: string; followUp: FollowUp }[] = [];
            const doneAt = this.nowISO();
            await syncTransaction(async () => {
                const writer = new SyncWriter(libraryID);
                for (let i = 0; i < sent.length; i++) {
                    const { key, revision, data } = sent[i]!;
                    const slot = String(i);
                    let result: WriteResult;
                    const echo = body.successful?.[slot];
                    if (echo) result = { type: "success", echo };
                    else if (body.unchanged?.[slot] !== undefined) result = { type: "unchanged" };
                    else {
                        const f = body.failed?.[slot];
                        result = { type: "failed", code: f?.code ?? 500, message: f?.message ?? "No result" };
                    }

                    if (result.type === "success" && result.echo.key !== key) {
                        await this.adoptServerKey(writer, libraryID, key, result.echo);
                        continue;
                    }
                    const state = await readKey(libraryID, key);
                    const { next, followUp } = afterWrite(state, { revision, data }, result, libraryID, doneAt);
                    await writer.commit(key, state, next);
                    if (result.type === "failed") {
                        this.parentHost.log("warn", `Item failed ${key}:`, "SyncService", result);
                    }
                    if (followUp !== "none") followUps.push({ key, followUp });
                }
                await db.libraries.update(libraryID, { itemVersion: version });
            });

            for (const { key, followUp } of followUps) {
                switch (followUp) {
                    case "full-sync":
                        fullSyncNeeded = true;
                        break;
                    case "missing-parent":
                        if (await this.recreateMissingParent(libraryID, key)) restart = true;
                        break;
                    case "refused":
                        await this.fetchServerCopy(libraryType, libraryID, key, signal);
                        break;
                    case "retry-later": {
                        const entry = await db.syncQueue.get([libraryID, key]);
                        await syncTransaction(() =>
                            putQueueEntry({
                                libraryID,
                                key,
                                reason: "server-error",
                                tries: (entry?.tries ?? 0) + 1,
                                lastCheck: this.now(),
                            }),
                        );
                        break;
                    }
                }
            }
        }

        if (fullSyncNeeded) {
            await syncTransaction(() => setNeedsFullSync(libraryID, true));
            return "object-conflict";
        }
        if (restart) return "restart";

        // Pending deletes, re-read now: some may have been resolved meanwhile.
        for (const batch of chunk(await this.pendingDeletes(libraryID), DELETE_BULK_SIZE)) {
            if (signal?.aborted) throw new Error("Aborted");
            let response;
            try {
                response = await this.request(
                    () => libHandle.items().delete(batch, { ifUnmodifiedSinceVersion: version }),
                    signal,
                );
            } catch (e) {
                if (errorStatus(e) === 412) {
                    this.parentHost.log("warn", "Library modified during delete (412). Retry needed.", "SyncService");
                    return "library-conflict";
                }
                throw e;
            }
            version = response.getVersion() ?? version;
            await syncTransaction(async () => {
                const writer = new SyncWriter(libraryID);
                for (const key of batch) {
                    const state = await readKey(libraryID, key);
                    if (state.row || state.conflict) continue;
                    await writer.commit(key, state, {});
                    this.parentHost.log("debug", `Successfully deleted: ${key}`, "SyncService");
                }
                await db.libraries.update(libraryID, { itemVersion: version });
            });
        }

        return "success";
    }

    /** Clears the journal of writes known not to have been applied. */
    private async dropJournals(libraryID: number, keys: string[]) {
        await syncTransaction(async () => {
            const writer = new SyncWriter(libraryID);
            for (const key of keys) {
                const state = await readKey(libraryID, key);
                if (state.journal) await writer.commit(key, state, { ...state, journal: undefined });
            }
        });
    }

    /** The server stored a create under another key: move the row there. */
    private async adoptServerKey(writer: SyncWriter, libraryID: number, key: string, echo: AnyZoteroItem) {
        const state = await readKey(libraryID, key);
        await writer.commit(key, state, {});
        const target = await readKey(libraryID, echo.key);
        await writer.commit(echo.key, target, { row: fromServer(echo, libraryID, state.row) });
    }

    /**
     * A write failed because the server lacks the parent. If the parent is
     * here and clean, it was deleted remotely without this device seeing it:
     * create it again (§4.6).
     */
    private async recreateMissingParent(libraryID: number, key: string): Promise<boolean> {
        return syncTransaction(async () => {
            const row = await db.items.get([libraryID, key]);
            if (!row?.parentItem) return false;
            const state = await readKey(libraryID, row.parentItem);
            if (!state.row || state.row.synced === 0 || state.conflict) return false;
            const writer = new SyncWriter(libraryID);
            await writer.commit(row.parentItem, state, markForRecreation(state));
            this.parentHost.log("warn", `Parent ${row.parentItem} of ${key} is missing on the server; recreating it.`, "SyncService");
            return true;
        });
    }

    /** Stores the server's copy on a refused write's conflict, for Keep Remote. */
    private async fetchServerCopy(libraryType: "user" | "group", libraryID: number, key: string, signal?: AbortSignal) {
        let remote: AnyZoteroItem | undefined;
        try {
            const res = await this.request(
                () => this.lib(libraryType, libraryID).items().get({ itemKey: key, includeTrashed: true }),
                signal,
            );
            // Only an object with the requested key: the server ignores an
            // `itemKey` filter it cannot parse (an invalid key) and answers
            // with other items (measured on api.zotero.org).
            remote = (res.raw as AnyZoteroItem[]).find((o) => o.key === key);
        } catch (e) {
            this.parentHost.log("warn", `Could not fetch the server copy of ${key}`, "SyncService", e);
            return;
        }
        if (!remote) return;
        await syncTransaction(async () => {
            const state = await readKey(libraryID, key);
            if (state.conflict?.kind !== "refused") return;
            const writer = new SyncWriter(libraryID);
            await writer.commit(key, state, {
                ...state,
                conflict: {
                    ...state.conflict,
                    remote: structuredClone(remote.data as unknown as ItemDataJSON),
                    remoteVersion: remote.version,
                },
            });
        });
    }
}
