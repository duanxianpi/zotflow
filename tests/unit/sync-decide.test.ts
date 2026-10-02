/**
 * L0 tests for src/db/sync/decide.ts (docs/sync-architecture.md §8.1).
 *
 * 1. Every abstract state × every event, checked against the invariants
 *    that hold after any single decision.
 * 2. Every sequence of events up to a depth against a minimal one-object
 *    server, using the decision functions only (no database): after every
 *    step the invariants hold, and from every state syncing and keeping the
 *    local side settles into agreement with every user change kept.
 *
 * No database is involved, so this runs deep and fast.
 *
 *   ZF_DECIDE_DEPTH=<n>   depth of the sequence search (default 6)
 */
import { describe, test, expect } from "vitest";

import {
    acceptRemote,
    afterLocalDelete,
    afterLocalEdit,
    afterWrite,
    beforeSend,
    groupKeepLocal,
    hasPendingChanges,
    isLocalRecreation,
    joinGroup,
    keepLocal,
    onRemoteObject,
    settleJournal,
} from "db/sync/decide";
import { sameContent } from "db/sync/reconcile";

import type { KeyState } from "db/sync/model";
import type { WriteResult } from "db/sync/decide";
import type { AnyIDBZoteroItem, IDBSyncConflict, ItemDataJSON } from "types/db-schema";
import type { AnyZoteroItem } from "types/zotero";

const LIB = 1;
const KEY = "ANNOAAAA";
const NOW = "2026-10-01T00:00:00Z";
const DEPTH = Number(process.env.ZF_DECIDE_DEPTH ?? 6);

/* ------------------------------------------------------------------ */
/*  Builders                                                          */
/* ------------------------------------------------------------------ */

/** Item data with the two fields the tests change: `a` (edited here) and `b`. */
function data(a: string, b: string, version: number, extra: Record<string, unknown> = {}): ItemDataJSON {
    return { key: KEY, version, itemType: "annotation", a, b, tags: [], ...extra };
}

function remoteObject(version: number, d: ItemDataJSON): AnyZoteroItem {
    return {
        key: KEY,
        version,
        library: { type: "user", id: LIB, name: "L", links: {} },
        links: {},
        meta: { numChildren: 0 },
        data: { ...d, key: KEY, version },
    } as unknown as AnyZoteroItem;
}

function row(d: ItemDataJSON, version: number, synced: 0 | 1, localRevision = 0): AnyIDBZoteroItem {
    return {
        libraryID: LIB,
        key: KEY,
        itemType: "annotation",
        parentItem: "",
        trashed: 0,
        title: "",
        collections: [],
        dateAdded: NOW,
        dateModified: NOW,
        version,
        synced,
        localRevision,
        searchCreators: [],
        searchTags: [],
        syncStatus: synced ? "synced" : version === 0 ? "created" : "updated",
        syncedAt: NOW,
        raw: remoteObject(version, d),
    } as unknown as AnyIDBZoteroItem;
}

const dataOf = (s: KeyState) => s.row?.raw.data as unknown as ItemDataJSON | undefined;

function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
}

/* ------------------------------------------------------------------ */
/*  Invariants of a single state                                      */
/* ------------------------------------------------------------------ */

function wellFormed(s: KeyState): string | undefined {
    const { row, cache, deleteLog, conflict } = s;
    if (row && deleteLog) return "a row and a pending delete at once";
    if (row && row.synced === 1 && cache) return "a clean row with a merge base";
    if (conflict?.kind === "local-deleted" && (row || !deleteLog)) return "local-deleted without its delete log";
    if (conflict && conflict.kind !== "local-deleted" && !row) return `${conflict.kind} conflict without a row`;
    if (!row && cache) return "a merge base without a row";
    return undefined;
}

/* ------------------------------------------------------------------ */
/*  1. States × events                                                */
/* ------------------------------------------------------------------ */

interface Named<T> {
    name: string;
    value: T;
}

/** Every abstract state the model allows (§8.1), with impossible ones left out. */
function abstractStates(): Named<KeyState>[] {
    const out: Named<KeyState>[] = [];
    const base = data("A0", "B0", 5);
    const local = data("L1", "B0", 5);
    const conflictOf = (kind: IDBSyncConflict["kind"]): IDBSyncConflict => ({
        libraryID: LIB,
        key: KEY,
        kind,
        remote: kind === "remote-deleted" ? undefined : data("R1", "B0", 7),
        remoteVersion: kind === "remote-deleted" ? 0 : 7,
        fields: [],
        group: kind === "remote-deleted" ? KEY : undefined,
        createdAt: NOW,
    });
    const kinds = [undefined, "changed", "local-deleted", "remote-deleted", "refused"] as const;

    for (const present of [true, false]) {
        for (const synced of [0, 1] as const) {
            for (const version of [0, 5]) {
                for (const hasCache of [false, true]) {
                    for (const hasJournal of [false, true]) {
                        for (const hasLog of [false, true]) {
                            for (const kind of kinds) {
                                const s: KeyState = {};
                                if (present) s.row = row(synced ? base : local, version, synced, synced ? 0 : 1);
                                if (hasCache) s.cache = { libraryID: LIB, key: KEY, version: 5, data: base };
                                if (hasJournal) s.journal = { libraryID: LIB, key: KEY, sent: local, baseVersion: version, revision: 1, sentAt: NOW };
                                if (hasLog) {
                                    s.deleteLog = {
                                        libraryID: LIB,
                                        key: KEY,
                                        itemType: "annotation",
                                        parentItem: "",
                                        version,
                                        dateDeleted: NOW,
                                        snapshot: row(local, version, 0),
                                    };
                                }
                                if (kind) s.conflict = conflictOf(kind);
                                if (wellFormed(s)) continue;
                                // Facts the model never produces together.
                                if (!present && (synced === 1 || hasCache)) continue;
                                if (present && synced === 1 && (hasJournal || (kind && kind !== "remote-deleted"))) continue;
                                if (!present && !hasLog && (hasJournal || kind)) continue;
                                if (kind === "refused" && hasJournal) continue;
                                out.push({
                                    name: [
                                        present ? `row(v${version},${synced ? "synced" : "dirty"})` : "no row",
                                        hasCache && "cache",
                                        hasJournal && "journal",
                                        hasLog && "deleteLog",
                                        kind && `conflict:${kind}`,
                                    ]
                                        .filter(Boolean)
                                        .join(" "),
                                    value: s,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    return out;
}

/** Every event, as a function of the state (undefined: not applicable). */
function events(): Named<(s: KeyState) => KeyState | undefined>[] {
    const remote = (version: number, d: ItemDataJSON) => (s: KeyState) =>
        onRemoteObject(s, remoteObject(version, d), { libraryID: LIB, parentExists: true, now: NOW }).next;
    const sentOf = (s: KeyState) => ({ revision: s.journal?.revision ?? 1, data: s.journal?.sent ?? data("L1", "B0", 5) });
    const write = (result: WriteResult) => (s: KeyState) => afterWrite(s, sentOf(s), result, LIB, NOW).next;
    const echo = (d: ItemDataJSON, v: number) => ({ type: "success", echo: remoteObject(v, d) }) as WriteResult;
    return [
        { name: "remote: same version", value: (s) => remote(s.row?.version ?? 5, data("A0", "B0", 5))(s) },
        { name: "remote: newer, same content as local", value: (s) => remote(9, dataOf(s) ?? data("L1", "B0", 9))(s) },
        { name: "remote: newer, equal to what was sent", value: remote(9, data("L1", "B0", 9)) },
        { name: "remote: newer, same field changed", value: remote(9, data("R2", "B0", 9)) },
        { name: "remote: newer, other field changed", value: remote(9, data("A0", "B9", 9)) },
        { name: "upload: success", value: write(echo(data("L1", "B0", 9), 9)) },
        { name: "upload: unchanged", value: write({ type: "unchanged" }) },
        { name: "upload: 404", value: write({ type: "failed", code: 404, message: "Not found" }) },
        { name: "upload: 412", value: write({ type: "failed", code: 412, message: "Stale" }) },
        { name: "upload: 400 missing parent", value: write({ type: "failed", code: 400, message: "Parent item X not found" }) },
        { name: "upload: 413", value: write({ type: "failed", code: 413, message: "Too long" }) },
        { name: "upload: 500", value: write({ type: "failed", code: 500, message: "Oops" }) },
        { name: "journal settled", value: (s) => (s.journal ? settleJournal(s) : undefined) },
        { name: "keep local", value: (s) => (s.conflict ? keepLocal(s) : undefined) },
        {
            name: "accept remote",
            value: (s) => {
                if (!s.conflict) return undefined;
                try {
                    return acceptRemote(s);
                } catch {
                    return undefined; // blocked: the UI disables it
                }
            },
        },
        {
            name: "local edit",
            value: (s) => {
                if (!s.row) return undefined;
                const edited = { ...s.row, synced: 0, localRevision: (s.row.localRevision ?? 0) + 1, raw: { ...s.row.raw, data: { ...s.row.raw.data, a: "L9" } } } as unknown as AnyIDBZoteroItem;
                return afterLocalEdit(s, edited);
            },
        },
        { name: "local delete", value: (s) => (s.row ? afterLocalDelete(s, NOW).next : undefined) },
        { name: "joins a deletion group", value: (s) => (s.row && !s.conflict ? joinGroup(s, LIB, KEY, "PARENT01", NOW) : undefined) },
    ];
}

describe("every state × every event", () => {
    const states = abstractStates();
    const evs = events();

    test("the state space is the one §8.1 describes", () => {
        expect(states.length).toBeGreaterThan(30);
    });

    for (const ev of evs) {
        test(`${ev.name}: well-formed, inputs untouched, conflicts kept`, () => {
            for (const { name, value } of states) {
                const before = structuredClone(value);
                const frozen = deepFreeze(structuredClone(value));
                const next = ev.value(frozen);
                expect(frozen, `${name}: input modified`).toEqual(before);
                if (!next) continue;
                expect(wellFormed(next), `${name} → ${ev.name}`).toBeUndefined();

                // Only the user ends a conflict — or both sides came to hold
                // the same thing (deleted on both; equal content; a held
                // member restored remotely).
                const ended = value.conflict && !next.conflict;
                const byUser = ev.name === "keep local" || ev.name === "accept remote";
                if (ended && !byUser) {
                    const same =
                        // A local delete answers a refusal, and meets a
                        // remote deletion (logged, so a re-creation still
                        // surfaces).
                        (ev.name === "local delete" && ["remote-deleted", "refused"].includes(value.conflict!.kind)) ||
                        (next.row?.synced === 1 && ev.name.startsWith("remote"));
                    expect(same, `${name} → ${ev.name}: conflict ended without the user`).toBe(true);
                }

                // A pending local change survives everything but a resolution
                // or a remote copy holding the same content.
                const local = dataOf(value);
                if (local && value.row!.synced === 0 && !byUser && ev.name !== "local edit" && ev.name !== "local delete") {
                    if (next.row) {
                        expect(dataOf(next)!.a, `${name} → ${ev.name}: local change lost`).toBe(local.a);
                    }
                }
            }
        });
    }
});

/* ------------------------------------------------------------------ */
/*  2. Sequences against a minimal server                             */
/* ------------------------------------------------------------------ */

interface Server {
    /** Library version. */
    version: number;
    item?: { version: number; data: ItemDataJSON };
    /** Library version at which the item was deleted (0: never). */
    deletedAt: number;
}

interface Client {
    s: KeyState;
    cursor: number;
}

interface Intent {
    /** The user's last value of `a` (or "deleted"), unless given up. */
    a?: string;
    /** Another client's last value of `b`; it must survive. */
    b?: string;
    lastL: string;
    lastR: string;
    lastO: string;
}

interface World {
    server: Server;
    client: Client;
    intent: Intent;
}

class Violation extends Error {}

const flip = (prev: string, x: string, y: string) => (prev === x ? y : x);

function remoteVersionOf(server: Server) {
    return server.item ? remoteObject(server.item.version, server.item.data) : undefined;
}

/** One sync, built from the decision functions only. `fault` drops the first write's answer or the request. */
function sync(w: World, fault?: "lost" | "not-sent"): void {
    const { server, client } = w;
    let faulted = false;
    for (let round = 0; round < 5; round++) {
        // Upload.
        let conflict412 = false;
        const s = client.s;
        if (s.row && s.row.synced === 0 && !s.conflict && !s.journal && !s.row.localOnly) {
            const { next, payload } = beforeSend(s, KEY, NOW);
            client.s = next;
            if (fault && !faulted) {
                faulted = true;
                if (fault === "not-sent") throw new Error("not sent");
            }
            let result: WriteResult;
            if (client.cursor !== server.version) {
                client.s = { ...client.s, journal: undefined };
                conflict412 = true;
                result = { type: "unchanged" };
            } else if (payload.version === 0 && server.item) {
                result = { type: "failed", code: 412, message: "exists" };
            } else if (payload.version > 0 && !server.item) {
                result = { type: "failed", code: 404, message: "missing" };
            } else if (payload.version > 0 && payload.version < server.item!.version) {
                result = { type: "failed", code: 412, message: "stale" };
            } else {
                const { key: _k, version: _v, ...fields } = payload;
                const v = ++server.version;
                server.item = { version: v, data: { ...(server.item?.data ?? {}), ...fields, key: KEY, version: v } };
                server.deletedAt = 0;
                result = { type: "success", echo: remoteObject(v, server.item.data) };
            }
            if (fault === "lost" && faulted && result.type === "success" && !conflict412) {
                // Applied; the answer never arrives.
                throw new Error("answer lost");
            }
            if (!conflict412) {
                const sent = { revision: next.journal!.revision, data: next.journal!.sent };
                const { next: after, followUp } = afterWrite(client.s, sent, result, LIB, NOW);
                client.s = after;
                if (result.type === "success") client.cursor = server.version;
                if (followUp === "full-sync") client.cursor = 0;
            }
        } else if (!s.row && s.deleteLog && !s.conflict) {
            if (fault && !faulted) {
                faulted = true;
                if (fault === "not-sent") throw new Error("not sent");
            }
            if (client.cursor !== server.version) {
                conflict412 = true;
            } else {
                if (server.item) {
                    server.item = undefined;
                    server.deletedAt = ++server.version;
                } else {
                    ++server.version;
                }
                if (fault === "lost" && faulted) throw new Error("answer lost");
                client.s = {};
                client.cursor = server.version;
            }
        }

        // Download (always complete here).
        if (server.version !== client.cursor) {
            const remote = remoteVersionOf(server);
            let returned = false;
            if (remote && remote.version > client.cursor) {
                returned = true;
                client.s = onRemoteObject(client.s, remote, { libraryID: LIB, parentExists: true, now: NOW }).next;
            }
            if (!remote && server.deletedAt > client.cursor) {
                returned = true;
                const st = client.s;
                if (!st.row) client.s = {};
                else if (isLocalRecreation(st)) {
                    // Ours to recreate.
                } else if (hasPendingChanges(st)) client.s = joinGroup(st, LIB, KEY, KEY, NOW);
                else client.s = {};
            }
            if (!returned && client.s.journal) client.s = settleJournal(client.s);
            client.cursor = server.version;
        } else if (client.s.journal) {
            client.s = settleJournal(client.s);
        }

        const st = client.s;
        const more = (st.row && st.row.synced === 0 && !st.conflict) || (!st.row && st.deleteLog && !st.conflict);
        if (!more && !conflict412) return;
    }
}

function resolve(w: World, action: "keep" | "accept"): void {
    const c = w.client.s.conflict!;
    if (action === "keep") {
        // Keeping the local side of a field the conflict listed is the
        // user's choice over the remote value there.
        if (c.fields.includes("b")) delete w.intent.b;
        w.client.s = c.kind === "remote-deleted" ? groupKeepLocal(w.client.s) : keepLocal(w.client.s);
        return;
    }
    w.client.s = acceptRemote(w.client.s);
    // The user gave up their side.
    delete w.intent.a;
}

interface Step {
    label: string;
    run: (w: World) => void;
}

function steps(w: World): Step[] {
    const out: Step[] = [];
    const { client, server, intent } = w;
    const s = client.s;
    if (s.row && !s.row.raw.data.deleted) {
        out.push({
            label: "local edit",
            run: (x) => {
                const v = flip(x.intent.lastL, "L1", "L2");
                x.intent.lastL = v;
                const r = x.client.s.row!;
                const edited = {
                    ...r,
                    synced: 0,
                    localRevision: (r.localRevision ?? 0) + 1,
                    raw: { ...r.raw, data: { ...r.raw.data, a: v } },
                } as unknown as AnyIDBZoteroItem;
                x.client.s = afterLocalEdit(x.client.s, edited);
                // Equal to the latest server value this device knows (the
                // conflict's remote side, else the merge base): a merge cannot
                // tell that from no change (ABA), so a later remote value wins.
                const st = x.client.s;
                const known = st.conflict ? st.conflict.remote?.a : st.cache?.data.a;
                if (known !== undefined && known === v) delete x.intent.a;
                else x.intent.a = v;
            },
        });
        out.push({
            label: "local delete",
            run: (x) => {
                x.client.s = afterLocalDelete(x.client.s, NOW).next;
                x.intent.a = "deleted";
            },
        });
    }
    if (server.item) {
        out.push({
            label: "remote edit a",
            run: (x) => {
                // Remote values never repeat: a remote A→B→A is invisible to
                // any three-way merge (and to Zotero's), so it is not modelled.
                const v = `R${Number(x.intent.lastR.slice(1) || 0) + 1}`;
                x.intent.lastR = v;
                // The user's value already reached the server: this later
                // change of another client's supersedes it.
                if (x.intent.a !== undefined && x.intent.a === x.server.item!.data.a) delete x.intent.a;
                const ver = ++x.server.version;
                x.server.item = { version: ver, data: { ...x.server.item!.data, a: v, version: ver } };
                // With nothing pending here on `a` — a clean row, or edits
                // that came back to the base value — the remote change wins.
                const st = x.client.s;
                const netChange =
                    !!st.row && st.row.synced === 0 && !(st.cache && !st.conflict && st.cache.data.a === dataOf(st)!.a);
                if (!st.row || (!netChange && !st.conflict)) {
                    if (x.intent.a !== "deleted") delete x.intent.a;
                }
            },
        });
        out.push({
            label: "remote edit b",
            run: (x) => {
                const v = `O${Number(x.intent.lastO.slice(1) || 0) + 1}`;
                x.intent.lastO = v;
                const ver = ++x.server.version;
                x.server.item = { version: ver, data: { ...x.server.item!.data, b: v, version: ver } };
                x.intent.b = v;
            },
        });
        out.push({
            label: "remote delete",
            run: (x) => {
                // A user value already on the server is superseded.
                if (x.intent.a !== undefined && x.intent.a === x.server.item!.data.a) delete x.intent.a;
                x.server.item = undefined;
                x.server.deletedAt = ++x.server.version;
                delete x.intent.b;
                const st = x.client.s;
                if (!st.row || (st.row.synced === 1 && !st.conflict)) delete x.intent.a;
            },
        });
    } else if (!server.item && server.deletedAt) {
        out.push({
            label: "remote recreate",
            run: (x) => {
                const ver = ++x.server.version;
                x.server.item = { version: ver, data: data("A0", "B0", ver) };
                x.server.deletedAt = 0;
                delete x.intent.b;
                // Deleted on the server already: the user's delete was
                // carried out; the re-creation is a new remote change.
                if (x.intent.a === "deleted") delete x.intent.a;
            },
        });
    }
    out.push({ label: "sync", run: (x) => sync(x) });
    out.push({ label: "sync, answer lost", run: (x) => sync(x, "lost") });
    out.push({ label: "sync, not sent", run: (x) => sync(x, "not-sent") });
    if (s.conflict) {
        out.push({ label: "keep local", run: (x) => resolve(x, "keep") });
        try {
            acceptRemote(s);
            out.push({ label: "accept remote", run: (x) => resolve(x, "accept") });
        } catch {
            // blocked
        }
    }
    void intent;
    return out;
}

function checkStep(w: World, prev: World, label: string): void {
    const bad = wellFormed(w.client.s);
    if (bad) throw new Violation(bad);
    const ended = prev.client.s.conflict && !w.client.s.conflict;
    // The user ends a conflict by resolving it, or by deleting the item.
    if (ended && label !== "keep local" && label !== "accept remote" && label !== "local delete") {
        const satisfied =
            (w.intent.a === "deleted" && !w.server.item) ||
            (w.client.s.row && w.server.item && sameContent(w.client.s.row.raw.data as unknown as ItemDataJSON, w.server.item.data)) ||
            w.intent.a === undefined;
        if (!satisfied) throw new Violation("conflict ended without the user");
    }
}

function checkSettles(start: World): void {
    const w = structuredClone(start);
    for (let round = 0; round < 6; round++) {
        if (w.client.s.conflict) resolve(w, "keep");
        sync(w);
        const s = w.client.s;
        const clean = !s.conflict && (!s.row || s.row.synced === 1) && !s.deleteLog && !s.journal;
        if (clean) break;
        if (round === 5) throw new Violation(`does not settle: ${JSON.stringify({ conflict: s.conflict?.kind, synced: s.row?.synced, log: !!s.deleteLog })}`);
    }
    const local = w.client.s.row;
    const remote = w.server.item;
    if (!!local !== !!remote) throw new Violation(`sides disagree: local ${local ? "has" : "lacks"} it, server ${remote ? "has" : "lacks"} it`);
    if (local && remote) {
        if (local.version !== remote.version) throw new Violation(`version ${local.version} here, ${remote.version} there`);
        if (!sameContent(local.raw.data as unknown as ItemDataJSON, remote.data)) throw new Violation("contents differ");
    }
    const a = w.intent.a;
    if (a === "deleted" && remote) throw new Violation("the user's delete was lost");
    if (a && a !== "deleted" && remote?.data.a !== a) throw new Violation(`the user's change ${a} was lost (server has ${String(remote?.data.a)})`);
    if (w.intent.b && remote && remote.data.b !== w.intent.b) throw new Violation(`another client's change ${w.intent.b} was overwritten`);
}

function hash(w: World): string {
    return JSON.stringify({ c: w.client, s: w.server, i: { ...w.intent, lastL: 0 } });
}

describe(`every event sequence up to length ${DEPTH} against a minimal server`, () => {
    test("invariants after every step; every state settles with the user's changes kept", () => {
        const start: World = {
            server: { version: 5, item: { version: 5, data: data("A0", "B0", 5) }, deletedAt: 0 },
            client: { s: { row: row(data("A0", "B0", 5), 5, 1) }, cursor: 5 },
            intent: { lastL: "", lastR: "", lastO: "" },
        };
        const seen = new Map<string, number>();
        const failures: string[] = [];
        const visit = (w: World, path: string[], depth: number) => {
            try {
                checkSettles(w);
            } catch (e) {
                if (!(e instanceof Violation)) throw e;
                failures.push(`${e.message} — after ${path.join(" → ") || "(start)"}`);
            }
            if (depth === 0 || failures.length > 0) return;
            for (const step of steps(w)) {
                const next = structuredClone(w);
                try {
                    step.run(next);
                } catch (e) {
                    if (e instanceof Error && /answer lost|not sent/.test(e.message)) {
                        // A failed sync stops where it failed.
                    } else throw e;
                }
                try {
                    checkStep(next, w, step.label);
                } catch (e) {
                    if (!(e instanceof Violation)) throw e;
                    failures.push(`${e.message} — after ${[...path, step.label].join(" → ")}`);
                    return;
                }
                const id = hash(next);
                if ((seen.get(id) ?? -1) >= depth - 1) continue;
                seen.set(id, depth - 1);
                visit(next, [...path, step.label], depth - 1);
            }
        };
        visit(start, [], DEPTH);
        expect(failures).toEqual([]);
        expect(seen.size).toBeGreaterThan(100);
    }, 600_000);
});
