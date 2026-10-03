/**
 * Model-based test of bidirectional sync.
 *
 * Each seed plays a random sequence of local edits and deletes, remote edits
 * and deletes, syncs and conflict resolutions against the fake Zotero
 * server. Some syncs are disturbed: a local edit lands mid-push, another
 * client writes mid-push, or one request fails — before reaching the server,
 * or after it was applied with the answer lost — checking the row invariants
 * after every step. At the end every conflict is resolved as keep-local and
 * the run must converge: local rows and server items agree, every edit the
 * user did not give up is on the server, and every local delete took effect.
 *
 * Ported from the v6 hardening to the v7 model: everything is observed
 * through services, row statuses and the conflict list. Notes are trashed
 * (Zotero's delete for notes), and tags merge as sets, so a user's tag must
 * be among the server's tags rather than the only one.
 *
 * A failure prints the seed and the action trace. Reproduce one seed with
 * `ZF_SYNC_MODEL_SEED=<seed>`; run more with `ZF_SYNC_MODEL_SEEDS=<count>`.
 */
import { describe, test, expect, afterEach } from "vitest";
import { createLocalItems, deleteLocalItems, mutateItem, newLocalItem } from "db/mutate";
import { deriveIndexFields } from "db/normalize";
import { ConflictService } from "worker/services/conflict";
import { db } from "../fakes/db";
import { createSyncHarness, USER_ID } from "../fakes/sync-harness";

import type { SyncHarness } from "../fakes/sync-harness";
import type { FakeLibraryHandle } from "../fakes/zotero-server";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { ZoteroItem } from "types/zotero";
import type { NoteData } from "types/zotero-item";
import type { ConflictAction } from "worker/services/conflict";

const STEPS = 30;
const SEEDS = process.env.ZF_SYNC_MODEL_SEED
    ? [Number(process.env.ZF_SYNC_MODEL_SEED)]
    : Array.from(
          { length: Number(process.env.ZF_SYNC_MODEL_SEEDS ?? 40) },
          (_, i) => i + 1,
      );

/** mulberry32: small, seedable, good enough to pick actions. */
function rng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        pick: <T,>(items: readonly T[]): T | undefined =>
            items[Math.floor(next() * items.length)],
    };
}

const PARENTS = ["PARENT01", "PARENT02"];
const childKey = (parent: string, n: number) => `NOTE${parent.slice(-2)}0${n}`;

/** What the user asked for, which the end state must honour. */
interface Intent {
    /** Last tag the user set on an item, still meant to win. */
    tags: Map<string, string>;
    /** Items the user deleted, still meant to be gone. */
    deleted: Set<string>;
}

class Run {
    readonly trace: string[] = [];
    private counter = 0;
    private created = 0;
    readonly intent: Intent = { tags: new Map(), deleted: new Set() };
    /** Conflict keys after the last step. */
    conflicts = new Set<string>();
    /** Keys the user resolved during the current step. */
    resolvedThisStep = new Set<string>();

    constructor(
        readonly h: SyncHarness,
        readonly lib: FakeLibraryHandle,
        readonly r: ReturnType<typeof rng>,
    ) {}

    private tag(prefix: string) {
        return `${prefix}${++this.counter}`;
    }

    async rows() {
        return db.items.where({ libraryID: USER_ID }).toArray();
    }

    /** Rows the user could still see and edit. */
    private async editable() {
        return (await this.rows()).filter((r) => r.trashed !== 1);
    }

    async localEdit() {
        const target = this.r.pick(await this.editable());
        if (!target) return;
        const tag = this.tag("L");
        this.trace.push(`localEdit ${target.key} ${tag}`);
        await mutateItem(USER_ID, target.key, (d) => {
            d.tags = [{ tag }];
        });
        this.intent.tags.set(target.key, tag);
    }

    async localDelete() {
        // The app deletes child items only (annotations, notes).
        const children = (await this.editable()).filter((r) => r.parentItem);
        const target = this.r.pick(children);
        if (!target) return;
        this.trace.push(`localDelete ${target.key}`);
        // The user's own delete answers a conflict on the item.
        if (this.conflicts.has(target.key)) this.resolvedThisStep.add(target.key);
        await deleteLocalItems(USER_ID, [target.key]);
        this.intent.tags.delete(target.key);
        this.intent.deleted.add(target.key);
    }

    async localCreate() {
        const parents = (await this.editable()).filter((r) => !r.parentItem);
        const parent = this.r.pick(parents);
        if (!parent) return;
        const key = `NEW${String(++this.created).padStart(5, "0")}`;
        const tag = this.tag("L");
        this.trace.push(`localCreate ${key} under ${parent.key} ${tag}`);
        const row = newLocalItem(
            {
                key,
                version: 0,
                library: { type: "user", id: USER_ID, name: "Library", links: {} },
                links: {},
                meta: { numChildren: 0 },
                data: {
                    key,
                    version: 0,
                    itemType: "note",
                    parentItem: parent.key,
                    note: `<p>${key}</p>`,
                    tags: [{ tag }],
                    collections: [],
                    relations: {},
                    dateAdded: "2026-01-01T00:00:00Z",
                    dateModified: "2026-01-01T00:00:00Z",
                },
            } as unknown as ZoteroItem<NoteData>,
            USER_ID,
            "push",
        );
        await createLocalItems(USER_ID, [row]);
        this.intent.tags.set(key, tag);
    }

    /** Whether the local row has a write the server does not have yet. */
    private async locallyPending(key: string) {
        const row = await db.items.get([USER_ID, key]);
        if (!row) return false;
        return row.syncStatus !== "synced" && row.syncStatus !== "ignore";
    }

    async remoteEdit() {
        const key = this.r.pick([...this.lib.items.keys()]);
        if (!key) return;
        const tag = this.tag("R");
        this.trace.push(`remoteEdit ${key} ${tag}`);
        this.lib.updateItem(key, { tags: [{ tag }] });
        // With nothing pending locally, the remote edit simply wins.
        if (!(await this.locallyPending(key))) this.intent.tags.delete(key);
    }

    async remoteDelete() {
        const key = this.r.pick([...this.lib.items.keys()]);
        if (!key) return;
        // Zotero deletes an item's children with it.
        const family = [
            key,
            ...[...this.lib.items.values()]
                .filter((i) => i.data.parentItem === key)
                .map((i) => i.key),
        ];
        this.trace.push(`remoteDelete ${family.join(",")}`);
        for (const k of family) {
            this.lib.deleteItem(k);
            if (!(await this.locallyPending(k))) this.intent.tags.delete(k);
        }
    }

    async sync() {
        this.trace.push("sync");
        await this.h.sync.startSync();
    }

    /** A sync with a local edit landing while the first POST is in flight. */
    async syncWithEditDuringPush() {
        this.trace.push("sync (edit during push)");
        const real = globalThis.fetch;
        let fired = false;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await real(input, init);
            if (!fired && init?.method === "POST") {
                fired = true;
                await this.localEdit();
            }
            return response;
        };
        try {
            await this.h.sync.startSync();
        } finally {
            globalThis.fetch = real;
        }
    }

    /** Run a sync with `hook` deciding, per request, what happens to it. */
    private async syncThrough(
        hook: (
            n: number,
            method: string,
            send: () => Promise<Response>,
        ) => Promise<Response>,
    ) {
        const real = globalThis.fetch;
        let n = 0;
        globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
            hook(n++, init?.method ?? "GET", () => real(input, init));
        try {
            await this.h.sync.startSync();
        } finally {
            globalThis.fetch = real;
        }
    }

    /**
     * A sync where one request fails: either before reaching the server, or
     * after the server applied it with the answer lost (a dropped connection,
     * or Obsidian closed mid-sync).
     */
    async syncWithFault() {
        const target = Math.floor(this.r.next() * 8);
        const lost = this.r.next() < 0.5;
        this.trace.push(
            `sync (request #${target} ${lost ? "applied, answer lost" : "not sent"})`,
        );
        await this.syncThrough(async (n, _method, send) => {
            if (n !== target) return send();
            if (lost) await send();
            throw new TypeError("Failed to fetch");
        });
    }

    /** A sync where another client edits the server just before our first write. */
    async syncWithRemoteWriteDuringPush() {
        this.trace.push("sync (another client writes during push)");
        let fired = false;
        await this.syncThrough(async (_n, method, send) => {
            if (!fired && (method === "POST" || method === "DELETE")) {
                fired = true;
                await this.remoteEdit();
            }
            return send();
        });
    }

    async resolve(action?: ConflictAction) {
        const service = new ConflictService(this.h.host);
        const conflicts = await service.getItemConflicts();
        const target = this.r.pick(conflicts);
        if (!target) return;
        const chosen = action ?? (this.r.next() < 0.5 ? "keep-local" : "accept-remote");
        // Keep Local is never blocked (ConflictItemInfo.keepLocalBlocked is
        // commented out); restore `target.keepLocalBlocked` with it.
        const blocked = chosen === "keep-local" ? undefined : target.acceptRemoteBlocked;
        if (blocked) return;

        this.trace.push(`resolve ${target.key} ${chosen}`);
        const before = new Set(conflicts.map((c) => c.key));
        await service.resolveItemConflict(USER_ID, target.key, chosen);
        const after = new Set(
            (await service.getItemConflicts()).map((c) => c.key),
        );
        for (const key of before) {
            if (!after.has(key)) this.resolvedThisStep.add(key);
        }

        if (chosen === "accept-remote") {
            // The user gave up the local side of everything just resolved,
            // including rows under an accepted remote deletion.
            const still = new Set(
                (await service.getItemConflicts()).map((c) => c.key),
            );
            const remaining = new Set((await this.rows()).map((r) => r.key));
            for (const key of [...this.intent.tags.keys(), ...this.intent.deleted]) {
                if ((before.has(key) && !still.has(key)) || !remaining.has(key)) {
                    this.intent.tags.delete(key);
                    if (before.has(key) && !still.has(key)) {
                        this.intent.deleted.delete(key);
                    }
                }
            }
        }
    }
}

/** Row invariants that must hold after every step. */
function checkRow(row: AnyIDBZoteroItem, listed: Set<string>) {
    const where = `${row.key} (${row.syncStatus})`;
    expect(listed.has(row.key), `${where}: conflict status iff listed as a conflict`).toBe(row.syncStatus === "conflict");
    const derived = deriveIndexFields(row.raw.data);
    expect(
        {
            title: row.title,
            searchTags: row.searchTags,
            searchCreators: row.searchCreators,
            citationKey: row.citationKey,
            trashed: row.trashed,
            parentItem: row.parentItem,
            collections: row.collections,
        },
        `${where}: derived columns out of step with raw`,
    ).toEqual(derived);
}

async function checkRows(run: Run) {
    const rows = await run.rows();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const listed = new Set((await new ConflictService(run.h.host).getItemConflicts()).map((c) => c.key));
    for (const row of rows) {
        checkRow(row, listed);
        if (row.parentItem) {
            expect(byKey.has(row.parentItem), `${row.key}: orphaned`).toBe(true);
        }
    }

    // Only the user ends a conflict. The one exception: an item both sides
    // deleted may simply go away.
    for (const key of run.conflicts) {
        if (run.resolvedThisStep.has(key) || listed.has(key)) continue;
        const bothDeleted = !byKey.has(key) && !run.lib.items.has(key);
        expect(bothDeleted, `${key}: conflict ended without the user`).toBe(true);
    }
    run.conflicts = listed;
    run.resolvedThisStep.clear();
}

/** Resolve everything as keep-local and sync until nothing is left to do. */
async function settle(run: Run) {
    for (let round = 0; round < 10; round++) {
        await run.sync();
        const service = new ConflictService(run.h.host);
        let conflicts = await service.getItemConflicts();
        while (conflicts.length > 0) {
            await run.resolve("keep-local");
            const next = await service.getItemConflicts();
            if (next.length === conflicts.length) break; // only blocked ones left
            conflicts = next;
        }
        const dirty = (await run.rows()).filter((r) => r.syncStatus !== "synced");
        if (dirty.length === 0 && (await service.getItemConflicts()).length === 0) return;
    }
    const left = (await run.rows())
        .filter((r) => r.syncStatus !== "synced")
        .map((r) => `${r.key}:${r.syncStatus}`);
    throw new Error(`did not converge: ${left.join(" ")}`);
}

async function checkConverged(run: Run) {
    const rows = await run.rows();
    const local = new Map(rows.map((r) => [r.key, r]));
    const server = run.lib.items;

    expect([...local.keys()].sort(), "same items on both sides").toEqual(
        [...server.keys()].sort(),
    );
    for (const [key, item] of server) {
        const row = local.get(key)!;
        expect(row.version, `${key}: version`).toBe(item.version);
        expect(row.raw.data.tags, `${key}: tags`).toEqual(item.data.tags ?? []);
    }
    for (const [key, tag] of run.intent.tags) {
        const tags = (server.get(key)?.data.tags ?? []) as { tag: string }[];
        expect(tags.map((t) => t.tag), `${key}: user's edit lost`).toContain(tag);
    }
    for (const key of run.intent.deleted) {
        // Notes are trashed, annotations removed.
        const item = server.get(key);
        expect(!item || !!item.data.deleted, `${key}: user's delete lost`).toBe(true);
    }
}

let h: SyncHarness | undefined;
afterEach(() => h?.dispose());

describe("sync model", () => {
    test.each(SEEDS)("seed %i", async (seed) => {
        h = await createSyncHarness();
        const lib = h.server.library(USER_ID);
        for (const parent of PARENTS) {
            lib.addItem({ key: parent, data: { title: parent, tags: [] } });
            for (const n of [1, 2]) {
                lib.addItem({
                    key: childKey(parent, n),
                    data: {
                        itemType: "note",
                        parentItem: parent,
                        note: `<p>${parent} ${n}</p>`,
                        tags: [],
                    },
                });
            }
        }
        await h.sync.startSync();

        const run = new Run(h, lib, rng(seed));
        const actions = [
            () => run.localEdit(),
            () => run.localEdit(),
            () => run.localDelete(),
            () => run.localCreate(),
            () => run.remoteEdit(),
            () => run.remoteDelete(),
            () => run.sync(),
            () => run.sync(),
            () => run.syncWithEditDuringPush(),
            () => run.syncWithFault(),
            () => run.syncWithRemoteWriteDuringPush(),
            () => run.resolve(),
        ];

        try {
            for (let step = 0; step < STEPS; step++) {
                await run.r.pick(actions)!();
                await checkRows(run);
            }
            await settle(run);
            await checkRows(run);
            await checkConverged(run);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(
                `seed ${seed}: ${message}\ntrace:\n  ${run.trace.join("\n  ")}`,
            );
        }
    });
});
