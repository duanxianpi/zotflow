/**
 * A world for exhaustive sync checking: the real sync engine and services
 * against the fake Zotero server, driven and observed only through
 * interfaces that predate the sync rework (services, `syncStatus`, `raw`),
 * so the same checker can judge any implementation.
 *
 * The world can be snapshotted and restored, which lets the checker walk
 * every sequence of actions depth-first, and hashed (with versions made
 * relative), which lets it skip states reached by different paths.
 *
 * What the user meant is tracked as `intent`: the last value they gave each
 * item, and the items they deleted, minus what they gave up (accept-remote,
 * or a remote change to an item they had nothing pending on). Every state
 * must be able to settle — sync, resolve everything as keep-local, repeat —
 * into one where both sides agree and every intent is on the server.
 */
import { db } from "db/db";
import { normalizeItem } from "db/normalize";
import { AnnotationService } from "worker/services/annotation";
import { ConflictService } from "worker/services/conflict";
import { ConvertService } from "worker/services/convert";
import { ItemNoteService } from "worker/services/item-note";
import { TagService } from "worker/services/tag";
import { API_KEY, createSyncHarness, USER_ID } from "./sync-harness";

import type { SyncHarness } from "./sync-harness";
import type { FakeLibraryHandle } from "./zotero-server";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { ConflictItemInfo } from "worker/services/conflict";
import type { LibraryNoteService } from "worker/services/library-note";

export const LIB = USER_ID;

/* ------------------------------------------------------------------ */
/*  Universes                                                         */
/* ------------------------------------------------------------------ */

export interface SeedItem {
    key: string;
    data: Record<string, unknown>;
}

export interface Universe {
    name: string;
    /** Server items the world starts from (synced once before exploring). */
    items: SeedItem[];
    /** Keys actions may target; defaults to every seeded key plus new ones. */
    focus?: string[];
    /** Local work done after the first sync, before exploring. */
    prepare?: (w: World) => Promise<void>;
    /** Leave these action kinds out (to keep a universe's space small). */
    without?: ActionKind[];
    /** Also try syncs with two disturbances (for multi-batch pushes). */
    combos?: boolean;
    /** Let the user create an annotation on an attachment. */
    newAnnotations?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Actions                                                           */
/* ------------------------------------------------------------------ */

export type ActionKind = "local" | "remote" | "sync" | "fault" | "mid-push" | "combo" | "resolve" | "shortcut";

export interface Action {
    kind: ActionKind;
    label: string;
    run: () => Promise<void>;
}

/** What a user can see of an item, for comparing two copies of it. */
export function userContent(data: unknown): string {
    const d = data as Record<string, unknown>;
    return JSON.stringify({
        tags: (d.tags as { tag: string }[] | undefined ?? []).map((t) => t.tag).sort(),
        title: d.title ?? null,
        note: d.note ?? null,
        comment: d.annotationComment ?? null,
        deleted: !!d.deleted,
    });
}

const sameUserContent = (a: unknown, b: unknown) => userContent(a) === userContent(b);

/**
 * The next value after `prev` for a side ("L", "R" or "O"): never repeating,
 * so no field goes A → B → A. A three-way merge cannot see such a round trip
 * (nor can Zotero's): the field looks unchanged against its base.
 */
const nextValue = (prev: string | undefined, side: string) =>
    `${side}${String(Number(prev?.slice(1) ?? 0) + 1).padStart(3, "0")}`;

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

interface Intent {
    /** key → the value the user last gave it (tag, note text or comment). */
    values: Record<string, string>;
    /** Keys the user deleted (or trashed). */
    deleted: string[];
    /** Last values used, so the next one differs. */
    lastLocal: Record<string, string>;
    lastRemote: Record<string, string>;
    /** Counters for deterministic new keys. */
    localNotes: number;
    localAnnotations: number;
    remoteNotes: number;
    /**
     * key → a value another client gave a field the user does not edit here
     * (title, or tags of a note or annotation). Changes to different fields
     * merge, so it must survive on the server.
     */
    remoteOther: Record<string, { field: "title" | "tags"; value: string }>;
    /**
     * key → a value another client gave the field the user had a pending
     * change to. Once this device has seen it, it must be listed as a
     * conflict (or merged into the local copy), never silently overwritten.
     */
    contested: Record<string, string>;
    /**
     * Change counters: bumped for an item and everything under it whenever
     * another client acts on it. `seen` is how far this device has observed
     * them (pulled, or learned from a refused push); `cleanAt` the counter
     * when the item was last clean here; `kept` what had been seen when the
     * user resolved it as keep-local.
     */
    touched: Record<string, number>;
    seen: Record<string, number>;
    cleanAt: Record<string, number>;
    kept: Record<string, number>;
    /** Local-only items the user deleted: they must never reach the server. */
    deletedUnseen: string[];
    /** Keys the server has ever had. */
    everOnServer: string[];
}

/** The tables a world snapshot covers: every table sync reads or writes. */
const TABLES = [
    "items",
    "collections",
    "libraries",
    "syncCache",
    "syncDeleteLog",
    "syncConflicts",
    "syncGroups",
    "syncQueue",
    "uploadJournal",
] as const;

interface Snapshot {
    items: AnyIDBZoteroItem[];
    collections: unknown[];
    libraries: unknown[];
    /** The sync bookkeeping tables (cache, delete log, conflicts, …). */
    sync: Record<string, unknown[]>;
    server: unknown;
    intent: Intent;
    conflicts: string[];
}

export class Violation extends Error {}

/* ------------------------------------------------------------------ */
/*  World                                                             */
/* ------------------------------------------------------------------ */

export class World {
    h!: SyncHarness;
    lib!: FakeLibraryHandle;
    intent: Intent = {
        values: {},
        deleted: [],
        lastLocal: {},
        lastRemote: {},
        localNotes: 0,
        localAnnotations: 0,
        remoteNotes: 0,
        remoteOther: {},
        contested: {},
        touched: {},
        seen: {},
        cleanAt: {},
        kept: {},
        deletedUnseen: [],
        everOnServer: [],
    };
    /** Conflict keys after the last step, for "only the user ends a conflict". */
    conflicts: string[] = [];
    /**
     * Local edits whose row was gone when they arrived (e.g. removed by the
     * sync they raced with). The services drop these with a warning; that is
     * an editor-level concern, reported separately from sync violations.
     */
    dropped: string[] = [];
    /** True while a sync runs: a delete then may race a request already sent. */
    private inSync = false;
    private tags!: TagService;
    private notes!: ItemNoteService;
    private annotations!: AnnotationService;
    private conflictService!: ConflictService;
    private seeds = new Map<string, SeedItem>();

    constructor(readonly universe: Universe) {}

    async init(): Promise<void> {
        this.h = await createSyncHarness({ host: { vaultConfig: { strictLineBreaks: false } } });
        this.lib = this.h.server.library(LIB);
        for (const s of this.universe.items) {
            this.seeds.set(s.key, s);
            this.lib.addItem({ key: s.key, data: s.data });
        }
        const sourceNotes = {
            triggerUpdate: () => Promise.resolve(),
            deleteAnnotationImage: () => Promise.resolve(),
            saveBase64Image: () => Promise.resolve(),
        } as unknown as LibraryNoteService;
        const convert = new ConvertService();
        this.tags = new TagService(this.h.settings, this.h.host);
        this.notes = new ItemNoteService(this.h.settings, this.h.host, convert, sourceNotes);
        this.annotations = new AnnotationService(sourceNotes, this.h.host, convert);
        this.conflictService = new ConflictService(this.h.host);
        await this.h.sync.startSync();
        await this.universe.prepare?.(this);
        this.intent.everOnServer = [...this.lib.items.keys()];
        this.conflicts = await this.conflictKeys();
    }

    dispose(): void {
        this.h?.dispose();
    }

    /* -------------------------- observation ------------------------- */

    rows(): Promise<AnyIDBZoteroItem[]> {
        return db.items.where({ libraryID: LIB }).toArray();
    }

    row(key: string): Promise<AnyIDBZoteroItem | undefined> {
        return db.items.get([LIB, key]);
    }

    /** Conflicts as the user sees them: the conflict list. */
    conflictInfos(): Promise<ConflictItemInfo[]> {
        return this.conflictService.getItemConflicts();
    }

    async conflictKeys(): Promise<string[]> {
        return (await this.conflictInfos()).map((c) => c.key).sort();
    }

    /** A row the user can still see and change. */
    private editable(r: AnyIDBZoteroItem): boolean {
        if (r.trashed === 1) return false;
        return !r.raw?.data?.deleted;
    }

    private focus(key: string): boolean {
        const f = this.universe.focus;
        return !f || f.includes(key) || key.startsWith("NEW") || key.startsWith("RNOTE");
    }

    /* --------------------------- snapshots -------------------------- */

    async capture(): Promise<Snapshot> {
        const sync: Record<string, unknown[]> = {};
        for (const t of TABLES.slice(3)) sync[t] = await db.table(t).toArray();
        return {
            items: await db.items.toArray(),
            collections: await db.collections.toArray(),
            libraries: await db.libraries.toArray(),
            sync,
            server: this.h.server.saveState(),
            intent: structuredClone(this.intent),
            conflicts: [...this.conflicts],
        };
    }

    /**
     * fake-indexeddb keeps every transaction a database ever ran and filters
     * the whole list each time it schedules one, so a long exploration slows
     * down quadratically (a depth-3 run stalled after a few thousand steps).
     * Between steps nothing is running; drop the finished ones.
     */
    private pruneFinishedTransactions(): void {
        const raw = (db.backendDB() as unknown as { _rawDatabase?: { transactions: { _state: string }[] } })._rawDatabase;
        if (raw) raw.transactions = raw.transactions.filter((t) => t._state !== "finished");
    }

    async restore(s: Snapshot): Promise<void> {
        this.pruneFinishedTransactions();
        await db.transaction("rw", TABLES.map((t) => db.table(t)), async () => {
            for (const t of TABLES) await db.table(t).clear();
            await db.items.bulkPut(structuredClone(s.items));
            await db.collections.bulkPut(structuredClone(s.collections) as never[]);
            await db.libraries.bulkPut(structuredClone(s.libraries) as never[]);
            for (const [t, rows] of Object.entries(s.sync)) await db.table(t).bulkPut(structuredClone(rows));
        });
        this.h.server.loadState(s.server);
        this.intent = structuredClone(s.intent);
        this.conflicts = [...s.conflicts];
    }

    /** Identity of a state for de-duplication: versions made relative. */
    hash(s: Snapshot): string {
        const server = (s.server as { id: number; version: number; items: Map<string, { version: number; data: Record<string, unknown> }>; deletedItems: Map<string, number> }[])
            .find((l) => l.id === LIB)!;
        const versions = [
            server.version,
            ...[...server.items.values()].map((i) => i.version),
            ...s.items.map((r) => r.version),
            ...(s.libraries as { itemVersion?: number }[]).map((l) => l.itemVersion ?? 0),
            ...Object.values(s.sync).flatMap((rows) =>
                (rows as { version?: number; remoteVersion?: number; baseVersion?: number }[]).flatMap((r) => [
                    r.version ?? 0,
                    r.remoteVersion ?? 0,
                    r.baseVersion ?? 0,
                ]),
            ),
        ].filter((v) => v > 0);
        const base = versions.length > 0 ? Math.min(...versions) - 1 : 0;
        const rel = (v: number | undefined) => (v && v > 0 ? v - base : v ?? 0);
        const strip = (d: Record<string, unknown> | undefined) => {
            if (!d) return d;
            const { dateModified: _m, dateAdded: _a, version: _v, ...rest } = d;
            return rest;
        };
        const local = s.items
            .filter((r) => r.libraryID === LIB)
            .map((r) => {
                const { dateModified: _m, syncedAt: _s, lastAccessedAt: _l, dateAdded: _a, ...rest } = r;
                return {
                    ...rest,
                    version: rel(r.version),
                    raw: { ...r.raw, version: rel(r.raw?.version), data: strip(r.raw?.data as unknown as Record<string, unknown>) },
                };
            })
            .sort((a, b) => a.key.localeCompare(b.key));
        const remote = [...server.items.values()]
            .map((i) => ({ v: rel(i.version), data: strip(i.data) }))
            .sort((a, b) => String(a.data?.key).localeCompare(String(b.data?.key)));
        const lib = (s.libraries as { id: number; itemVersion?: number }[]).find((l) => l.id === LIB);
        const book = Object.fromEntries(
            Object.entries(s.sync).map(([t, rows]) => [
                t,
                (rows as Record<string, unknown>[])
                    .map((r) => {
                        const { createdAt: _c, sentAt: _t, dateDeleted: _d, lastCheck: _l, snapshot: _s, ...rest } = r;
                        return {
                            ...rest,
                            version: rel(r.version as number | undefined),
                            remoteVersion: rel(r.remoteVersion as number | undefined),
                            baseVersion: rel(r.baseVersion as number | undefined),
                            data: strip(r.data as Record<string, unknown> | undefined),
                            sent: strip(r.sent as Record<string, unknown> | undefined),
                            remote: strip(r.remote as Record<string, unknown> | undefined),
                        };
                    })
                    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
            ]),
        );
        return JSON.stringify({
            local,
            book,
            remote,
            deleted: [...server.deletedItems.keys()].sort(),
            cursor: rel(lib?.itemVersion),
            libVersion: rel(server.version),
            intent: { ...s.intent, lastLocal: undefined, lastRemote: undefined },
            conflicts: s.conflicts,
        });
    }

    /* ---------------------------- actions --------------------------- */

    private localValue(key: string): string {
        const v = nextValue(this.intent.lastLocal[key], "L");
        this.intent.lastLocal[key] = v;
        return v;
    }

    private remoteValue(key: string): string {
        const v = nextValue(this.intent.lastRemote[key], "R");
        this.intent.lastRemote[key] = v;
        return v;
    }

    private setIntent(key: string, value: string) {
        this.intent.values[key] = value;
        this.intent.deleted = this.intent.deleted.filter((k) => k !== key);
    }

    private markDeleted(key: string) {
        if (!this.inSync && !this.intent.everOnServer.includes(key) && !this.lib.items.has(key)) {
            this.intent.deletedUnseen.push(key);
        }
        delete this.intent.values[key];
        if (!this.intent.deleted.includes(key)) this.intent.deleted.push(key);
    }

    /** Another client acted on `key`: it and everything under it changed. */
    private async noteRemoteChange(key: string) {
        const parents = new Map<string, string>();
        for (const r of await this.rows()) if (r.parentItem) parents.set(r.key, r.parentItem);
        for (const [k, it] of this.lib.items) {
            const p = it.data.parentItem as string | undefined;
            if (p) parents.set(k, p);
        }
        const under = (k: string): boolean => {
            for (let p = parents.get(k), n = 0; p && n < 10; p = parents.get(p), n++) {
                if (p === key) return true;
            }
            return false;
        };
        for (const k of new Set([key, ...parents.keys()])) {
            if (k === key || under(k)) this.intent.touched[k] = (this.intent.touched[k] ?? 0) + 1;
        }
    }

    private touched(key: string): number {
        return this.intent.touched[key] ?? 0;
    }

    /**
     * Run a sync, then record what this device has observed: an item's
     * changes count as seen only once its row reflects the server's current
     * version (pulled, or a refused push brought the server copy).
     */
    private async runSync(sync: () => Promise<unknown>): Promise<void> {
        this.inSync = true;
        try {
            await sync();
        } finally {
            this.inSync = false;
        }
        const keys = new Set([...Object.keys(this.intent.touched), ...this.lib.items.keys()]);
        const infos = new Map((await this.conflictInfos()).map((c) => [c.key, c]));
        for (const key of keys) {
            const r = await this.row(key);
            const server = this.lib.items.get(key);
            const info = infos.get(key);
            const current =
                (!r && !server && !info) ||
                (r && server && r.version === server.version) ||
                (server && info?.remoteVersion === server.version) ||
                (!server && info?.kind === "remote-deleted");
            // A sync can fail partway (e.g. its item fetch), so changes made
            // before it are not seen merely because it ran.
            if (current) this.intent.seen[key] = this.touched(key);
        }
    }

    private drop(what: string) {
        this.dropped.push(what);
    }

    private forget(key: string) {
        delete this.intent.values[key];
        this.intent.deleted = this.intent.deleted.filter((k) => k !== key);
    }

    /** Local actions available now. */
    private async localActions(): Promise<Action[]> {
        const out: Action[] = [];
        for (const r of await this.rows()) {
            if (r.itemType === "attachment" && this.universe.newAnnotations && this.intent.localAnnotations < 1 && this.editable(r)) {
                const attachmentKey = r.key;
                out.push({
                    kind: "local",
                    label: `new annotation on ${attachmentKey}`,
                    run: async () => {
                        const key = `NEWANNO${++this.intent.localAnnotations}`;
                        const attachment = await this.row(attachmentKey);
                        if (!attachment) return this.drop(`new annotation on ${attachmentKey}`);
                        const keyInfo = await db.keys.get(API_KEY);
                        await this.annotations.saveAnnotations(attachment as never, keyInfo!, [
                            {
                                id: key,
                                type: "highlight",
                                text: "new",
                                comment: "",
                                color: "#ffd400",
                                pageLabel: "1",
                                sortIndex: "00000|000300|00200",
                                position: { pageIndex: 0, rects: [[10, 30, 100, 40]] },
                                tags: [],
                            } as never,
                        ]);
                        this.setIntent(key, "");
                    },
                });
            }
            if (!this.editable(r) || !this.focus(r.key)) continue;
            const key = r.key;
            if (r.itemType === "note") {
                out.push({
                    kind: "local",
                    label: `edit note ${key}`,
                    run: async () => {
                        if (!(await this.row(key))) return this.drop(`edit note ${key}`);
                        const v = this.localValue(key);
                        await this.notes.updateNoteContent(LIB, key, v, "editor");
                        this.setIntent(key, v);
                    },
                });
                out.push({
                    kind: "local",
                    label: `delete note ${key}`,
                    run: async () => {
                        if (!(await this.row(key))) return this.drop(`delete note ${key}`);
                        await this.notes.deleteNote(LIB, key);
                        this.markDeleted(key);
                    },
                });
            } else if (r.itemType === "annotation") {
                out.push({
                    kind: "local",
                    label: `edit annotation ${key}`,
                    run: async () => {
                        if (!(await this.row(key))) return this.drop(`edit annotation ${key}`);
                        const v = this.localValue(key);
                        await this.annotations.updateAnnotationComment(LIB, key, v);
                        this.setIntent(key, v);
                    },
                });
                out.push({
                    kind: "local",
                    label: `delete annotation ${key}`,
                    run: async () => {
                        if (!(await this.row(key))) return this.drop(`delete annotation ${key}`);
                        const attachment = await this.row(r.parentItem);
                        await this.annotations.deleteAnnotations(attachment as never, [key]);
                        this.markDeleted(key);
                    },
                });
            } else if (r.itemType !== "attachment") {
                out.push({
                    kind: "local",
                    label: `tag ${key}`,
                    run: async () => {
                        if (!(await this.row(key))) return this.drop(`tag ${key}`);
                        const v = this.localValue(key);
                        await this.tags.setItemTags(LIB, key, [{ tag: v }]);
                        this.setIntent(key, v);
                    },
                });
                if (this.intent.localNotes < 1) {
                    out.push({
                        kind: "local",
                        label: `new note under ${key}`,
                        run: async () => {
                            const n = ++this.intent.localNotes;
                            const random = Math.random;
                            // createChildNote draws its key from Math.random;
                            // make it deterministic so paths replay identically.
                            let i = 0;
                            Math.random = () => ((n * 7 + i++ * 13) % 33) / 33;
                            try {
                                const created = await this.notes.createChildNote(LIB, key);
                                this.setIntent(created, "");
                            } finally {
                                Math.random = random;
                            }
                        },
                    });
                }
            }
        }
        return out;
    }

    /** Another client's actions available now. */
    private remoteActions(): Action[] {
        const out: Action[] = [];
        for (const [key, item] of this.lib.items) {
            if (!this.focus(key) || item.data.deleted) continue;
            out.push({ kind: "remote", label: `remote edit ${key}`, run: () => this.remoteEdit(key) });
            out.push({ kind: "remote", label: `remote edit other field of ${key}`, run: () => this.remoteEditOther(key) });
            out.push({ kind: "remote", label: `remote delete ${key}`, run: () => this.remoteDelete(key) });
            if (item.data.itemType !== "note" && item.data.itemType !== "attachment" && item.data.itemType !== "annotation" && this.intent.remoteNotes < 1) {
                out.push({
                    kind: "remote",
                    label: `remote new note under ${key}`,
                    run: async () => {
                        const k = `RNOTE${String(++this.intent.remoteNotes).padStart(3, "0")}`;
                        this.lib.addItem({ key: k, data: { itemType: "note", parentItem: key, note: "<p>remote</p>" } });
                    },
                });
            }
        }
        for (const [key, seed] of this.seeds) {
            if (this.lib.items.has(key) || !this.focus(key)) continue;
            const parent = seed.data.parentItem as string | undefined;
            if (parent && !this.lib.items.has(parent)) continue;
            out.push({
                kind: "remote",
                label: `remote recreate ${key}`,
                run: async () => {
                    await this.noteRemoteChange(key);
                    this.lib.addItem({ key, data: seed.data });
                    delete this.intent.remoteOther[key];
                    delete this.intent.contested[key];
                    // The server had deleted it, so a delete of the user's
                    // was carried out; the re-creation is a new remote change.
                    this.intent.deleted = this.intent.deleted.filter((k) => k !== key);
                },
            });
        }
        return out;
    }

    private async locallyClean(key: string): Promise<boolean> {
        const r = await this.row(key);
        return !r || r.syncStatus === "synced";
    }

    async remoteEdit(key: string): Promise<void> {
        const item = this.lib.items.get(key);
        if (!item) return;
        const v = this.remoteValue(key);
        const t = item.data.itemType;
        await this.noteRemoteChange(key);
        if (t === "note") this.lib.updateItem(key, { note: `<p>${v}</p>` });
        else if (t === "annotation") this.lib.updateItem(key, { annotationComment: v });
        else this.lib.updateItem(key, { tags: [{ tag: v }] });
        // With nothing pending locally, the remote change simply wins;
        // otherwise the two are in conflict.
        if (await this.locallyClean(key)) this.forget(key);
        else this.intent.contested[key] = v;
    }

    /** Another client changes a field the user does not edit here: it must merge. */
    async remoteEditOther(key: string): Promise<void> {
        const item = this.lib.items.get(key);
        if (!item) return;
        const v = nextValue(this.intent.lastRemote[`${key}#other`], "O");
        this.intent.lastRemote[`${key}#other`] = v;
        const t = item.data.itemType;
        await this.noteRemoteChange(key);
        if (t === "note" || t === "annotation") {
            this.lib.updateItem(key, { tags: [{ tag: v }] });
            this.intent.remoteOther[key] = { field: "tags", value: v };
        } else {
            this.lib.updateItem(key, { title: v });
            this.intent.remoteOther[key] = { field: "title", value: v };
        }
    }

    async remoteDelete(key: string): Promise<void> {
        const family = [key];
        for (let i = 0; i < family.length; i++) {
            for (const [k, it] of this.lib.items) {
                if (it.data.parentItem === family[i] && !family.includes(k)) family.push(k);
            }
        }
        for (const k of family) {
            if (!this.lib.items.has(k)) continue;
            await this.noteRemoteChange(k);
            this.lib.deleteItem(k);
            delete this.intent.remoteOther[k];
            delete this.intent.contested[k];
            if (await this.locallyClean(k)) this.forget(k);
        }
    }

    /** Sync with `hook` deciding, per request, what happens to it. */
    private async syncThrough(hook: (n: number, method: string, url: string, send: () => Promise<Response>) => Promise<Response>) {
        const real = globalThis.fetch;
        let n = 0;
        globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            return hook(n++, (init?.method ?? "GET").toUpperCase(), url, () => real(input, init));
        };
        try {
            await this.runSync(() => this.h.sync.startSync());
        } finally {
            globalThis.fetch = real;
        }
    }

    private syncActions(): Action[] {
        const out: Action[] = [
            {
                kind: "sync",
                label: "sync",
                run: () => this.runSync(() => this.h.sync.startSync()),
            },
        ];
        for (const w of [0, 1, 2]) {
            for (const mode of ["lost", "not-sent"] as const) {
                out.push({
                    kind: "fault",
                    label: `sync, write #${w} ${mode === "lost" ? "applied, answer lost" : "not sent"}`,
                    run: () => {
                        let writes = 0;
                        return this.syncThrough(async (_n, method, _url, send) => {
                            if (method === "GET" || writes++ !== w) return send();
                            if (mode === "lost") await send();
                            throw new TypeError("Failed to fetch");
                        });
                    },
                });
            }
        }
        out.push({
            kind: "fault",
            label: "sync, item fetch not sent",
            run: () => {
                let hit = false;
                return this.syncThrough(async (_n, method, url, send) => {
                    if (hit || method !== "GET" || !url.includes("itemKey=")) return send();
                    hit = true;
                    throw new TypeError("Failed to fetch");
                });
            },
        });
        return out;
    }

    /** Syncs with another action landing just before the first write. */
    private async midPushActions(): Promise<Action[]> {
        const out: Action[] = [];
        const between = (label: string, act: () => Promise<void>): Action => ({
            kind: "mid-push",
            label: `sync, ${label} before the first write`,
            run: () => {
                let done = false;
                return this.syncThrough(async (_n, method, _url, send) => {
                    if (!done && method !== "GET") {
                        done = true;
                        await act();
                    }
                    return send();
                });
            },
        });
        for (const a of this.remoteActions()) {
            if (a.label.startsWith("remote recreate")) continue;
            out.push(between(a.label, a.run));
        }
        for (const a of await this.localActions()) {
            if (a.label.startsWith("new ")) continue;
            out.push(between(a.label, a.run));
        }
        return out;
    }

    /**
     * Syncs with two disturbances: `act` lands after the first write's
     * answer, and the second write's answer is lost. Only for universes whose
     * push goes out in several batches.
     */
    private async comboActions(): Promise<Action[]> {
        if (!this.universe.combos) return [];
        const out: Action[] = [];
        for (const a of await this.localActions()) {
            if (a.label.startsWith("new ")) continue;
            out.push({
                kind: "combo",
                label: `sync, ${a.label} after write #0, write #1 answer lost`,
                run: () => {
                    let writes = 0;
                    return this.syncThrough(async (_n, method, _url, send) => {
                        if (method === "GET") return send();
                        const n = writes++;
                        const res = await send();
                        if (n === 0) await a.run();
                        if (n === 1) throw new TypeError("Failed to fetch");
                        return res;
                    });
                },
            });
        }
        return out;
    }

    /**
     * One-step routes into each kind of conflict (a local action, another
     * client's action, a sync), so the depth bound is spent after it.
     */
    private async shortcutActions(): Promise<Action[]> {
        const out: Action[] = [];
        const locals = await this.localActions();
        const find = (prefix: string) => locals.find((a) => a.label === prefix);
        for (const create of locals.filter((a) => a.label.startsWith("new "))) {
            out.push({
                kind: "shortcut",
                label: `lost: ${create.label}, its create applied but the answer lost`,
                run: async () => {
                    await create.run();
                    let first = true;
                    await this.syncThrough(async (_n, method, _url, send) => {
                        if (method === "GET" || !first) return send();
                        first = false;
                        await send();
                        throw new TypeError("Failed to fetch");
                    });
                },
            });
        }
        for (const r of await this.rows()) {
            const key = r.key;
            if (!this.editable(r) || !this.focus(key) || !this.lib.items.has(key)) continue;
            const edit =
                find(`tag ${key}`) ?? find(`edit note ${key}`) ?? find(`edit annotation ${key}`);
            const del = find(`delete note ${key}`) ?? find(`delete annotation ${key}`);
            const route = (label: string, local: Action, remote: () => Promise<void>): Action => ({
                kind: "shortcut",
                label: `conflict: ${label}`,
                run: async () => {
                    await local.run();
                    await remote();
                    await this.runSync(() => this.h.sync.startSync());
                },
            });
            if (edit) {
                out.push(route(`both edited ${key}`, edit, () => this.remoteEdit(key)));
                out.push(route(`${key} edited, deleted remotely`, edit, () => this.remoteDelete(key)));
                const parent = r.parentItem;
                if (parent && this.lib.items.has(parent)) {
                    out.push(route(`${key} edited, its parent deleted remotely`, edit, () => this.remoteDelete(parent)));
                }
            }
            if (del) out.push(route(`${key} deleted, edited remotely`, del, () => this.remoteEdit(key)));
            if (edit) {
                out.push({
                    kind: "shortcut",
                    label: `lost: ${key} edited, its push applied but the answer lost`,
                    run: async () => {
                        await edit.run();
                        let first = true;
                        await this.syncThrough(async (_n, method, _url, send) => {
                            if (method === "GET" || !first) return send();
                            first = false;
                            await send();
                            throw new TypeError("Failed to fetch");
                        });
                    },
                });
            }
        }
        return out;
    }

    private async resolveActions(): Promise<Action[]> {
        const out: Action[] = [];
        const infos = await this.conflictService.getItemConflicts();
        for (const c of infos) {
            for (const action of ["keep-local", "accept-remote"] as const) {
                const blocked = action === "keep-local" ? c.keepLocalBlocked : c.acceptRemoteBlocked;
                if (blocked) continue;
                out.push({
                    kind: "resolve",
                    label: `${action} ${c.key}`,
                    run: () => this.resolve(action, () => this.conflictService.resolveItemConflict(LIB, c.key, action)),
                });
            }
        }
        if (infos.length > 1) {
            for (const action of ["keep-local", "accept-remote"] as const) {
                out.push({
                    kind: "resolve",
                    label: `${action} all`,
                    run: () => this.resolve(action, () => this.conflictService.resolveAllItemConflicts(action)),
                });
            }
        }
        return out;
    }

    /** Run a resolution; accept-remote gives up the local side of what it ended. */
    private async resolve(action: "keep-local" | "accept-remote", run: () => Promise<unknown>) {
        const infos = await this.conflictInfos();
        const listed = new Map(infos.map((c) => [c.key, c.conflictFields]));
        const before = infos.map((c) => c.key).sort();
        await run();
        const after = new Set(await this.conflictKeys());
        const ended = before.filter((k) => !after.has(k));
        for (const key of ended) delete this.intent.contested[key];
        if (action === "keep-local") {
            for (const key of ended) {
                this.intent.kept[key] = this.intent.seen[key] ?? 0;
                // Keeping the local side of a field the conflict listed is
                // the user's choice over the remote value there.
                const other = this.intent.remoteOther[key];
                if (other && listed.get(key)?.includes(other.field)) delete this.intent.remoteOther[key];
            }
            return;
        }
        const present = new Set((await this.rows()).map((r) => r.key));
        for (const key of [...Object.keys(this.intent.values), ...this.intent.deleted]) {
            if (ended.includes(key)) {
                this.forget(key);
            } else if (!present.has(key) && key in this.intent.values) {
                // Accept-remote may only give up what the conflict list showed.
                throw new Violation(`${key}: accept-remote discarded a change that was not listed as a conflict`);
            }
        }
    }

    async actions(): Promise<Action[]> {
        const all = [
            ...(await this.localActions()),
            ...this.remoteActions(),
            ...this.syncActions(),
            ...(await this.midPushActions()),
            ...(await this.comboActions()),
            ...(await this.resolveActions()),
            ...(await this.shortcutActions()),
        ];
        const without = new Set(this.universe.without ?? []);
        return all.filter((a) => !without.has(a.kind));
    }

    /* ---------------------------- checks ---------------------------- */

    /** Invariants that hold after every step. `resolved` steps may end conflicts. */
    async checkStep(kind: ActionKind, label = ""): Promise<void> {
        const rows = await this.rows();
        const byKey = new Map(rows.map((r) => [r.key, r]));
        const infos = new Map((await this.conflictInfos()).map((c) => [c.key, c]));
        const conflictsNow = [...infos.keys()].sort();
        for (const r of rows) {
            const n = normalizeItem(r.raw, LIB);
            const cols = (x: AnyIDBZoteroItem) => ({
                title: x.title,
                searchTags: x.searchTags,
                searchCreators: x.searchCreators,
                citationKey: x.citationKey,
                trashed: x.trashed,
                parentItem: x.parentItem,
                collections: x.collections,
            });
            if (JSON.stringify(cols(r)) !== JSON.stringify(cols(n))) {
                throw new Violation(`${r.key}: index columns out of step with raw (${JSON.stringify(cols(r))} vs ${JSON.stringify(cols(n))})`);
            }
            const info = infos.get(r.key);
            if (r.syncStatus === "synced" && info) {
                throw new Violation(`${r.key}: synced but listed as a conflict`);
            }
            if (r.syncStatus === "conflict" && !info) {
                throw new Violation(`${r.key}: marked as a conflict the conflict list does not show`);
            }
            if (info?.kind === "changed" && info.remoteData && sameUserContent(r.raw.data, info.remoteData)) {
                throw new Violation(`${r.key}: a conflict with nothing to choose (both sides hold the same content)`);
            }
            if (r.parentItem && !byKey.has(r.parentItem)) {
                throw new Violation(`${r.key}: orphaned (parent ${r.parentItem} missing)`);
            }
        }
        if (kind !== "resolve") {
            for (const key of this.conflicts) {
                if (infos.has(key)) continue;
                // Deleting the item is the user's answer to its conflict.
                if (kind === "local" && label.startsWith("delete ") && label.endsWith(` ${key}`)) continue;
                const intended = key in this.intent.values || this.intent.deleted.includes(key);
                // Deleted on both sides: the user's intent holds already.
                const settled = this.intent.deleted.includes(key) && !this.lib.items.has(key);
                if (intended && !settled) {
                    const r = byKey.get(key);
                    throw new Violation(`${key}: conflict ended without the user (now ${r ? r.syncStatus : "gone"})`);
                }
            }
        }
        for (const key of conflictsNow) {
            if (this.conflicts.includes(key)) continue;
            const info = infos.get(key)!;
            // A refusal for another reason (a 4xx other than 404/412) needs no
            // remote change; every other conflict does — on the item itself,
            // or, for a remote deletion, on the deleted item above it (a row
            // created after that deletion joins its conflict).
            const refused = info.kind === "refused";
            const changed = (k: string) => this.touched(k) !== (this.intent.cleanAt[k] ?? 0);
            const viaRoot = info.kind === "remote-deleted" && !!info.group && changed(info.group);
            if (!refused && !changed(key) && !viaRoot) {
                throw new Violation(`${key}: a conflict without any remote change behind it`);
            }
            if (key in this.intent.kept && this.touched(key) === this.intent.kept[key]) {
                throw new Violation(`${key}: a conflict resolved as keep-local came back without a new remote change`);
            }
        }
        for (const [key, value] of Object.entries(this.intent.contested)) {
            if (infos.has(key)) continue;
            if (!this.lib.items.has(key)) {
                delete this.intent.contested[key];
                continue;
            }
            // Not observed yet: the next sync may still raise it.
            if ((this.intent.seen[key] ?? 0) !== this.touched(key)) continue;
            const r = byKey.get(key);
            if (r && userContent(r.raw.data).includes(value)) {
                delete this.intent.contested[key];
                continue;
            }
            throw new Violation(`${key}: another client's change (${value}) was overwritten without a conflict`);
        }
        for (const r of rows) {
            if (r.syncStatus === "synced") {
                // Clean as far as this device knows: changes it has not seen
                // yet can still raise a conflict.
                this.intent.cleanAt[r.key] = this.intent.seen[r.key] ?? 0;
                delete this.intent.kept[r.key];
            }
        }
        for (const key of this.lib.items.keys()) {
            if (!this.intent.everOnServer.includes(key)) this.intent.everOnServer.push(key);
        }
        for (const key of this.intent.deletedUnseen) {
            if (this.lib.items.has(key)) throw new Violation(`${key}: a local-only item the user deleted reached the server`);
        }
        this.conflicts = conflictsNow;
    }

    /** Sync and keep-local until nothing is left, then check agreement and intent. */
    async checkSettles(): Promise<void> {
        // In the user's order: conflicts shown after a sync are resolved,
        // then the next sync carries the resolution out.
        for (let round = 0; round < 8; round++) {
            for (let i = 0; i < 20; i++) {
                const [c] = await this.conflictService.getItemConflicts();
                if (!c) break;
                if (c.key in this.intent.kept && this.touched(c.key) === this.intent.kept[c.key]) {
                    throw new Violation(`${c.key}: a conflict resolved as keep-local came back without a new remote change`);
                }
                const blocked = !!c.keepLocalBlocked;
                await this.conflictService.resolveItemConflict(LIB, c.key, blocked ? "accept-remote" : "keep-local");
                if (!blocked) {
                    this.intent.kept[c.key] = this.intent.seen[c.key] ?? 0;
                    const other = this.intent.remoteOther[c.key];
                    if (other && c.conflictFields.includes(other.field)) delete this.intent.remoteOther[c.key];
                }
            }
            await this.runSync(() => this.h.sync.startSync());
            const dirty = (await this.rows()).filter((r) => r.syncStatus !== "synced");
            const open = await this.conflictInfos();
            if (dirty.length === 0 && open.length === 0) break;
            if (round === 7) {
                const reasons = new Map(open.map((c) => [c.key, `${c.kind}:${c.syncError}`]));
                throw new Violation(
                    `does not settle: ${[...new Set([...dirty.map((r) => r.key), ...reasons.keys()])]
                        .map((k) => `${k}:${dirty.find((r) => r.key === k)?.syncStatus ?? "-"}:${reasons.get(k) ?? ""}`)
                        .join(" ")}`,
                );
            }
        }
        const rows = await this.rows();
        const local = new Map(rows.map((r) => [r.key, r]));
        const server = this.lib.items;
        const localKeys = [...local.keys()].sort().join(",");
        const serverKeys = [...server.keys()].sort().join(",");
        if (localKeys !== serverKeys) throw new Violation(`sides disagree on items: local [${localKeys}] server [${serverKeys}]`);
        for (const [key, item] of server) {
            const r = local.get(key)!;
            if (r.version !== item.version) throw new Violation(`${key}: version ${r.version} locally, ${item.version} on the server`);
            for (const field of ["tags", "note", "annotationComment", "deleted"] as const) {
                const read = (d: unknown) => {
                    const v = (d as Record<string, unknown>)[field];
                    // `deleted` is false, 0 or absent when not deleted.
                    return JSON.stringify(field === "deleted" ? !!v : v ?? null);
                };
                const a = read(r.raw.data);
                const b = read(item.data);
                if (a !== b) throw new Violation(`${key}: ${field} differs (local ${a}, server ${b})`);
            }
        }
        for (const [key, value] of Object.entries(this.intent.values)) {
            const item = server.get(key);
            if (!item || item.data.deleted) throw new Violation(`${key}: the user's change (${value || "new"}) is not on the server`);
            if (value === "") continue;
            const d = item.data;
            const text = (v: unknown) => (typeof v === "string" ? v : "");
            const has =
                JSON.stringify(d.tags ?? []).includes(`"${value}"`) ||
                text(d.note).includes(value) ||
                text(d.annotationComment).includes(value);
            if (!has) throw new Violation(`${key}: the user's change (${value}) was lost; server has ${JSON.stringify({ tags: d.tags, note: d.note, comment: d.annotationComment })}`);
        }
        for (const key of this.intent.deleted) {
            const item = server.get(key);
            if (item && !item.data.deleted) throw new Violation(`${key}: the user's delete was lost`);
        }
        for (const [key, { field, value }] of Object.entries(this.intent.remoteOther)) {
            const item = server.get(key);
            if (!item) continue;
            const v = item.data[field];
            const kept = field === "title" ? v === value : JSON.stringify(v ?? []).includes(`"${value}"`);
            if (!kept) throw new Violation(`${key}: another client's ${field} (${value}) was overwritten; server has ${JSON.stringify(v)}`);
        }
        for (const key of this.intent.deletedUnseen) {
            if (server.has(key)) throw new Violation(`${key}: a local-only item the user deleted reached the server`);
        }
    }
}
