/**
 * Exhaustive sync checker.
 *
 * For each small universe, walks every sequence of actions up to a depth —
 * local edits and deletes through the real services, another client's edits,
 * deletes, new notes and re-creations, plain syncs, syncs with a write lost
 * after the server applied it or never sent, syncs with another action landing
 * mid-push, and every resolution — skipping states already seen. After every
 * step it checks the row invariants; in every state it checks that syncing and
 * resolving as keep-local settles into agreement with every user change kept
 * (see tests/fakes/sync-world.ts).
 *
 * Unlike sync-model.test.ts (random sequences), this covers *all* sequences of
 * the vocabulary up to the depth, so a passing run is a statement about that
 * whole space. The vocabulary and the depth bound what it can find.
 *
 *   ZF_EXHAUSTIVE_DEPTH=<n>       depth per universe (default 2)
 *   ZF_EXHAUSTIVE_UNIVERSE=<name> run one universe
 *   ZF_EXHAUSTIVE_REPORT=1        print every kind of violation found, with its
 *                                 shortest path, instead of failing on the first
 *   ZF_EXHAUSTIVE_TIMEOUT_MIN=<n> per-universe time limit in minutes (default 60)
 */
import { describe, test, expect } from "vitest";
import { db } from "db/db";
import { ItemNoteService } from "worker/services/item-note";
import { ConvertService } from "worker/services/convert";
import { LIB, Violation, World } from "../fakes/sync-world";

import type { Universe } from "../fakes/sync-world";
import type { LibraryNoteService } from "worker/services/library-note";

const DEPTH = Number(process.env.ZF_EXHAUSTIVE_DEPTH ?? 2);
const ONLY = process.env.ZF_EXHAUSTIVE_UNIVERSE;
const REPORT = process.env.ZF_EXHAUSTIVE_REPORT === "1";
const TIMEOUT_MS = Number(process.env.ZF_EXHAUSTIVE_TIMEOUT_MIN ?? 60) * 60_000;

const position = JSON.stringify({ pageIndex: 0, rects: [[10, 10, 100, 20]] });

const UNIVERSES: Universe[] = [
    {
        name: "note",
        items: [
            { key: "PARENT01", data: { title: "parent", tags: [] } },
            { key: "NOTEAAAA", data: { itemType: "note", parentItem: "PARENT01", note: "<p>n</p>", tags: [] } },
        ],
    },
    {
        name: "annotation",
        items: [
            { key: "PARENT01", data: { title: "parent", tags: [] } },
            { key: "ATTACH01", data: { itemType: "attachment", parentItem: "PARENT01", linkMode: "linked_url", url: "https://example.org", title: "link", tags: [] } },
            {
                key: "ANNOAAAA",
                data: {
                    itemType: "annotation",
                    parentItem: "ATTACH01",
                    annotationType: "highlight",
                    annotationText: "text",
                    annotationComment: "c",
                    annotationColor: "#ffd400",
                    annotationPageLabel: "1",
                    annotationSortIndex: "00000|000100|00200",
                    annotationPosition: position,
                    tags: [],
                },
            },
        ],
        focus: ["PARENT01", "ANNOAAAA"],
        newAnnotations: true,
    },
    {
        name: "two items",
        items: [
            { key: "PARENT01", data: { title: "one", tags: [] } },
            { key: "PARENT02", data: { title: "two", tags: [] } },
        ],
        without: ["resolve"],
    },
    {
        // 51 drafts: the push goes out in two batches (50 + 1).
        name: "batch",
        items: [{ key: "PARENT01", data: { title: "parent", tags: [] } }],
        without: ["remote", "shortcut"],
        combos: true,
        prepare: async (w) => {
            const sourceNotes = { triggerUpdate: () => Promise.resolve() } as unknown as LibraryNoteService;
            const notes = new ItemNoteService(w.h.settings, w.h.host, new ConvertService(), sourceNotes);
            // createChildNote draws keys from Math.random: a seeded
            // mulberry32, so the drafts are the same on every run.
            const random = Math.random;
            let seed = 0x9e3779b9;
            Math.random = () => {
                seed = (seed + 0x6d2b79f5) >>> 0;
                let t = seed;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            const keys: string[] = [];
            try {
                for (let n = 0; n < 51; n++) keys.push(await notes.createChildNote(LIB, "PARENT01"));
            } finally {
                Math.random = random;
            }
            const drafts = await db.items.where("[libraryID+syncStatus]").equals([LIB, "created"]).primaryKeys();
            if (drafts.length !== 51) throw new Error(`batch universe needs 51 drafts, got ${drafts.length}`);
            // Push reads drafts in key order, so the largest key is the one
            // in the second batch.
            const last = [...keys].sort().at(-1)!;
            w.universe.focus = [last];
            for (const k of keys) w.intent.values[k] = "";
        },
    },
];

interface Found {
    kind: string;
    message: string;
    path: string[];
    count: number;
}

/** A violation's kind: its message with keys and values abstracted away. */
const kindOf = (message: string) =>
    message
        .replace(/\b[A-Z0-9]{8}\b/g, "K")
        .replace(/\b[LR][ab]\b/g, "V")
        .replace(/\d+/g, "n")
        .slice(0, 140);

async function explore(universe: Universe) {
    const w = new World(universe);
    await w.init();
    const found = new Map<string, Found>();
    // State → the most depth left it was explored with. A state reached
    // again with more depth left is explored again: a shortcut can reach a
    // state a longer path already reached at the bound, and what lies past
    // it must still be covered.
    const seen = new Map<string, number>();
    let transitions = 0;

    const record = (e: unknown, path: string[]) => {
        const message = e instanceof Violation ? e.message : `threw: ${e instanceof Error ? e.message : String(e)}`;
        const kind = kindOf(message);
        const prior = found.get(kind);
        if (!prior) found.set(kind, { kind, message, path, count: 1 });
        else {
            prior.count++;
            if (path.length < prior.path.length) Object.assign(prior, { message, path });
        }
        if (!REPORT) throw new Error(`${universe.name}: ${message}\n  after: ${path.join(" → ") || "(start)"}`);
    };

    const visit = async (snap: Awaited<ReturnType<World["capture"]>>, path: string[], depth: number) => {
        await w.restore(snap);
        try {
            await w.checkSettles();
        } catch (e) {
            record(e, [...path, "(settle)"]);
        }
        if (depth === 0) return;
        await w.restore(snap);
        const labels = (await w.actions()).map((a) => a.label);
        for (const label of labels) {
            await w.restore(snap);
            const action = (await w.actions()).find((a) => a.label === label);
            if (!action) continue;
            transitions++;
            try {
                await action.run();
                await w.checkStep(action.kind, action.label);
            } catch (e) {
                record(e, [...path, label]);
                continue;
            }
            const child = await w.capture();
            const id = w.hash(child);
            if ((seen.get(id) ?? -1) >= depth - 1) continue;
            seen.set(id, depth - 1);
            await visit(child, [...path, label], depth - 1);
        }
    };

    try {
        const root = await w.capture();
        seen.set(w.hash(root), DEPTH);
        await visit(root, [], DEPTH);
    } finally {
        w.dispose();
    }
    return { found: [...found.values()], states: seen.size, transitions, dropped: new Set(w.dropped).size };
}

describe("exhaustive sync check", () => {
    for (const universe of UNIVERSES) {
        if (ONLY && universe.name !== ONLY) continue;
        test(`${universe.name}: every action sequence up to depth ${DEPTH}`, async () => {
            const result = await explore(universe);
            if (REPORT) {
                const lines = result.found
                    .sort((a, b) => a.path.length - b.path.length)
                    .map((f) => `  [${f.count}×] ${f.message}\n      after: ${f.path.join(" → ") || "(start)"}`);
                process.stdout.write(
                    `\n${universe.name}: ${result.states} states, ${result.transitions} transitions, ${result.found.length} kinds of violation, ${result.dropped} kinds of edit dropped by a service (row gone mid-sync)\n${lines.join("\n")}\n`,
                );
            }
            expect(result.found.map((f) => f.message)).toEqual([]);
        }, TIMEOUT_MS);
    }
});
