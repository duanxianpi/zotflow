/**
 * `LocalDataManager` — the local half of the annotation round trip.
 *
 * For a vault file there is no Zotero server and no IDB row: the `.zf.json`
 * sidecar next to the attachment IS the only copy of the user's annotations. If
 * the cache and the file ever disagree, work is lost with nothing to restore
 * from. Both ends of the chain were already covered — `LocalTemplateService`
 * reads the sidecar, `annotation-comment` converts both directions — and this
 * middle step was the unprotected one.
 *
 * `utils/file.ts` is deliberately NOT mocked. It is the code that decides
 * whether a write goes through the Vault or the DataAdapter, and the
 * `localSidecarFolder` setting can make the sidecar path hidden — so the real
 * helpers run against the in-memory vault and that fork is genuinely exercised.
 *
 * Mutation round: 15 of 17 anchors killed. The two survivors are equivalent —
 * in `extractAnnotations`, both `"annotations" in parsed` and
 * `!Array.isArray(parsed)` are subsumed by the `Array.isArray(data.annotations)`
 * check below them: a key that is absent cannot hold an array, and JSON.parse
 * cannot produce an array with an `annotations` property. They are redundant
 * guards, not behaviour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "settings/types";

import { LocalDataManager } from "ui/reader/local-data-manager";
import { createFakeApp } from "../fakes/obsidian-app";
import { TFile } from "../stubs/obsidian";

import type { FakeObsidianApp } from "../fakes/obsidian-app";
import type { AnnotationJSON } from "types/zotero-reader";

/* ------------------------------------------------------------------ */
/*  Module boundary                                                   */
/* ------------------------------------------------------------------ */

interface MockState {
    /** The fake Obsidian App handed to `services.app`. */
    app: unknown;
    settings: unknown;
    logs: { level: string; message: string }[];
    notices: { type: string; message: string }[];
    /** What `workerBridge.localNote.parseLegacyAnnotations` returns. */
    legacy: unknown[];
    /** Recorded `triggerUpdate` calls. */
    triggerUpdates: { path: string; count: number }[];
    failTriggerUpdate: boolean;
}

// Hoisted above the imports, so the literal cannot reference them; the shape is
// declared separately and applied with one cast.
const state = vi.hoisted(() => ({
    app: null,
    settings: null,
    logs: [],
    notices: [],
    legacy: [],
    triggerUpdates: [],
    failTriggerUpdate: false,
})) as unknown as MockState;

vi.mock("services/services", () => ({
    services: {
        get app() {
            return state.app;
        },
        get settings() {
            return state.settings;
        },
        logService: {
            info: (m: string) => state.logs.push({ level: "info", message: m }),
            warn: (m: string) => state.logs.push({ level: "warn", message: m }),
            error: (m: string) => state.logs.push({ level: "error", message: m }),
            debug: (m: string) => state.logs.push({ level: "debug", message: m }),
        },
        notificationService: {
            notify: (type: string, message: string) =>
                state.notices.push({ type, message }),
        },
    },
}));

vi.mock("bridge", () => ({
    workerBridge: {
        localNote: {
            parseLegacyAnnotations: () => Promise.resolve(state.legacy),
            triggerUpdate: (
                attachment: { path: string },
                annotations: unknown[],
            ) => {
                state.triggerUpdates.push({
                    path: attachment.path,
                    count: annotations.length,
                });
                return state.failTriggerUpdate
                    ? Promise.reject(new Error("note update exploded"))
                    : Promise.resolve();
            },
        },
    },
}));

/* ------------------------------------------------------------------ */

const ATTACHMENT = "Papers/paper.pdf";
const SIDECAR = "Papers/paper.zf.json";

let app: FakeObsidianApp;
let manager: InstanceType<typeof LocalDataManager>;

function makeTFile(path: string) {
    const file = new TFile();
    file.path = path;
    const name = path.slice(path.lastIndexOf("/") + 1);
    file.name = name;
    const dot = name.lastIndexOf(".");
    file.extension = name.slice(dot + 1);
    file.basename = name.slice(0, dot);
    return file;
}

function anno(id: string, overrides: Partial<AnnotationJSON> = {}): AnnotationJSON {
    return {
        id,
        type: "highlight",
        text: `text of ${id}`,
        comment: "",
        color: "#ffd400",
        pageLabel: "1",
        sortIndex: "00001|000000|00000",
        position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
        tags: [],
        dateAdded: "2026-01-01T00:00:00Z",
        dateModified: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

/** Write a well-formed sidecar straight to the vault. */
function seedSidecar(annotations: AnnotationJSON[], path = SIDECAR) {
    app.writeFile(path, JSON.stringify({ version: 1, annotations }, null, 2));
}

/** Parse whatever is on disk at the sidecar path. */
function readSidecar(path = SIDECAR) {
    const raw = app.read(path);
    return raw === undefined ? undefined : JSON.parse(raw);
}

function newManager(attachmentPath = ATTACHMENT) {
    return new LocalDataManager(
        makeTFile(attachmentPath) as never,
    );
}

beforeEach(() => {
    app = createFakeApp();
    app.writeFile(ATTACHMENT, "%PDF-1.7");
    state.app = app.app;
    state.settings = { ...DEFAULT_SETTINGS };
    state.logs.length = 0;
    state.notices.length = 0;
    state.legacy.length = 0;
    state.triggerUpdates.length = 0;
    state.failTriggerUpdate = false;
    manager = newManager();
});

/* ================================================================ */
/*  The round trip                                                  */
/* ================================================================ */

describe("round trip: cache and sidecar never disagree", () => {
    it("survives load, save, update, delete and reload", async () => {
        seedSidecar([anno("A1"), anno("A2")]);

        // Load
        expect((await manager.loadAnnotations()).map((a) => a.id)).toEqual([
            "A1",
            "A2",
        ]);

        // Save a third
        await manager.saveAnnotation(anno("A3", { comment: "new one" }));
        expect(manager.getAllAnnotations().map((a) => a.id)).toEqual([
            "A1",
            "A2",
            "A3",
        ]);

        // Update the second
        await manager.saveAnnotation(anno("A2", { comment: "edited" }));
        expect(manager.getAnnotation("A2")!.comment).toBe("edited");
        expect(manager.getAllAnnotations()).toHaveLength(3);

        // Delete the first
        await manager.deleteAnnotation("A1");
        expect(manager.getAnnotation("A1")).toBeUndefined();

        // A fresh manager reading the same file must see exactly the same thing.
        const reloaded = await newManager().loadAnnotations();
        expect(reloaded.map((a) => a.id)).toEqual(["A2", "A3"]);
        expect(reloaded.find((a) => a.id === "A2")!.comment).toBe("edited");
    });

    it("keeps the envelope version on every write", async () => {
        await manager.saveAnnotation(anno("A1"));
        expect(readSidecar()).toMatchObject({ version: 1 });
    });

    it("writes the sidecar next to the attachment by default", async () => {
        await manager.saveAnnotation(anno("A1"));
        expect(app.read(SIDECAR)).toBeDefined();
    });

    it("routes through the DataAdapter when the sidecar folder is hidden", async () => {
        // `localSidecarFolder: ".zotflow"` makes every sidecar path hidden, and
        // Obsidian's vault tree cannot see those at all.
        state.settings = {
            ...DEFAULT_SETTINGS,
            localSidecarFolder: ".zotflow",
        };
        const hidden = ".zotflow/Papers/paper.zf.json";

        await manager.saveAnnotation(anno("A1"));

        expect(app.adapterCalls).toContain(`write:${hidden}`);
        expect(app.vaultCalls).toEqual([]);
        // And it reads back through the same route.
        expect(
            (await newManager().loadAnnotations()).map((a) => a.id),
        ).toEqual(["A1"]);
    });
});

/* ================================================================ */
/*  loadAnnotations                                                 */
/* ================================================================ */

describe("loadAnnotations", () => {
    it("reads the structured envelope", async () => {
        seedSidecar([anno("A1")]);
        expect((await manager.loadAnnotations()).map((a) => a.id)).toEqual(["A1"]);
    });

    it("returns nothing when there is no sidecar and no legacy data", async () => {
        expect(await manager.loadAnnotations()).toEqual([]);
    });

    it("migrates legacy inline annotations and writes the sidecar", async () => {
        // Older versions kept annotations as comments inside the note.
        state.legacy.push(anno("OLD1"), anno("OLD2"));

        const loaded = await manager.loadAnnotations();

        expect(loaded.map((a) => a.id)).toEqual(["OLD1", "OLD2"]);
        expect(readSidecar().annotations.map((a: AnnotationJSON) => a.id)).toEqual(
            ["OLD1", "OLD2"],
        );
        expect(
            state.logs.some((l) => l.message.includes("Migrating 2 legacy")),
        ).toBe(true);
    });

    it("does not write a sidecar when there is no legacy data either", async () => {
        await manager.loadAnnotations();
        expect(app.read(SIDECAR)).toBeUndefined();
    });

    it("falls back to legacy parsing when the sidecar shape is unrecognized", async () => {
        // A bare array is the shape a hand-edited or pre-envelope file might have.
        app.writeFile(SIDECAR, JSON.stringify([anno("A1")]));
        state.legacy.push(anno("OLD1"));

        const loaded = await manager.loadAnnotations();

        expect(loaded.map((a) => a.id)).toEqual(["OLD1"]);
        expect(
            state.logs.some(
                (l) =>
                    l.level === "warn" &&
                    l.message.includes("Unrecognized .zf.json format"),
            ),
        ).toBe(true);
    });

    it("degrades quietly when the annotations key is not an array", async () => {
        // The result being empty is not enough to pin this down: accepting the
        // non-array would make `rebuildCache` throw on a non-iterable, the outer
        // catch would swallow it, and the caller would still see []. The
        // difference the user feels is which path ran — a recognizable-but-wrong
        // file should fall through to the legacy parser without an error notice.
        app.writeFile(SIDECAR, JSON.stringify({ version: 1, annotations: {} }));

        expect(await manager.loadAnnotations()).toEqual([]);
        expect(
            state.logs.some(
                (l) =>
                    l.level === "warn" &&
                    l.message.includes("Unrecognized .zf.json format"),
            ),
        ).toBe(true);
        expect(state.notices).toEqual([]);
    });

    it("reports malformed JSON instead of throwing", async () => {
        app.writeFile(SIDECAR, "{ not json");

        expect(await manager.loadAnnotations()).toEqual([]);
        expect(
            state.logs.some(
                (l) =>
                    l.level === "error" &&
                    l.message.includes("Failed to load annotations"),
            ),
        ).toBe(true);
        // The user has to know: their annotations did not load.
        expect(state.notices).toEqual([
            { type: "error", message: "Could not load annotations." },
        ]);
    });

    it("replaces the cache rather than merging into it", async () => {
        seedSidecar([anno("A1")]);
        await manager.loadAnnotations();

        seedSidecar([anno("B1")]);
        expect((await manager.loadAnnotations()).map((a) => a.id)).toEqual(["B1"]);
    });
});

/* ================================================================ */
/*  Cache reads                                                     */
/* ================================================================ */

describe("cache reads", () => {
    it("looks an annotation up by id", async () => {
        seedSidecar([anno("A1"), anno("A2")]);
        await manager.loadAnnotations();

        expect(manager.getAnnotation("A2")!.id).toBe("A2");
        expect(manager.getAnnotation("NOPE")).toBeUndefined();
    });

    it("is empty before anything is loaded", () => {
        expect(manager.getAllAnnotations()).toEqual([]);
    });
});

describe("getAllTagNames", () => {
    it("merges annotation tags with the vault's own, sorted and deduped", async () => {
        seedSidecar([
            anno("A1", { tags: [{ name: "method" }, { name: "shared" }] }),
            anno("A2", { tags: [{ name: "alpha" }] }),
        ]);
        app.setTags({ "#shared": 3, "#zebra": 1 });
        await manager.loadAnnotations();

        // Obsidian reports tags with a leading '#', which must be stripped, and
        // "shared" appears on both sides but must appear once.
        expect(manager.getAllTagNames()).toEqual([
            "alpha",
            "method",
            "shared",
            "zebra",
        ]);
    });

    it("skips blank vault tags", async () => {
        app.setTags({ "#": 1, "#real": 1 });
        expect(manager.getAllTagNames()).toEqual(["real"]);
    });

    it("tolerates annotations with no tags array", async () => {
        seedSidecar([{ ...anno("A1"), tags: undefined } as never]);
        await manager.loadAnnotations();
        expect(manager.getAllTagNames()).toEqual([]);
    });
});

/* ================================================================ */
/*  saveAnnotation / deleteAnnotation                               */
/* ================================================================ */

describe("saveAnnotation", () => {
    it("persists and asks the worker to re-render the note", async () => {
        await manager.saveAnnotation(anno("A1"));

        expect(readSidecar().annotations).toHaveLength(1);
        expect(state.triggerUpdates).toEqual([
            { path: ATTACHMENT, count: 1 },
        ]);
    });

    it("overwrites an existing annotation by id", async () => {
        await manager.saveAnnotation(anno("A1", { comment: "first" }));
        await manager.saveAnnotation(anno("A1", { comment: "second" }));

        expect(readSidecar().annotations).toHaveLength(1);
        expect(readSidecar().annotations[0].comment).toBe("second");
    });

    it("never writes the rendered image into the sidecar", async () => {
        // The base64 PNG belongs in the vault as a file; inlining it would bloat
        // the sidecar without bound.
        await manager.saveAnnotation(
            anno("IMG1", { type: "image", image: "AAAABBBB" }),
        );

        const stored = readSidecar().annotations[0];
        expect("image" in stored).toBe(false);
        expect(stored.id).toBe("IMG1");
    });

    it("compacts numeric arrays so positions stay on one line", async () => {
        await manager.saveAnnotation(
            anno("A1", { position: { pageIndex: 0, rects: [[1, 2, 3, 4]] } }),
        );

        // Pretty-printed JSON would put each number on its own line.
        expect(app.read(SIDECAR)).toContain("[ 1, 2, 3, 4 ]");
    });

    it("still re-renders the note when the sidecar write fails", async () => {
        // The in-memory cache already has the annotation, so the note should
        // reflect it even though persistence failed.
        const failing = createFakeApp({ failWrites: true });
        failing.writeFile(ATTACHMENT, "%PDF");
        state.app = failing.app;

        await manager.saveAnnotation(anno("A1"));

        expect(
            state.logs.some(
                (l) =>
                    l.level === "error" &&
                    l.message.includes("Failed to save annotations"),
            ),
        ).toBe(true);
        expect(state.triggerUpdates).toHaveLength(1);
    });

    it("logs a rejected note update without failing the save", async () => {
        state.failTriggerUpdate = true;

        await expect(manager.saveAnnotation(anno("A1"))).resolves.toBeUndefined();

        await vi.waitFor(() => {
            expect(
                state.logs.some(
                    (l) =>
                        l.level === "error" &&
                        l.message.includes("Failed to update source note"),
                ),
            ).toBe(true);
        });
        // The sidecar write is what matters and it happened.
        expect(readSidecar().annotations).toHaveLength(1);
    });
});

describe("deleteAnnotation", () => {
    it("removes it from both the cache and the file", async () => {
        seedSidecar([anno("A1"), anno("A2")]);
        await manager.loadAnnotations();

        await manager.deleteAnnotation("A1");

        expect(manager.getAllAnnotations().map((a) => a.id)).toEqual(["A2"]);
        expect(
            readSidecar().annotations.map((a: AnnotationJSON) => a.id),
        ).toEqual(["A2"]);
    });

    it("re-renders the note with the remaining annotations", async () => {
        seedSidecar([anno("A1"), anno("A2")]);
        await manager.loadAnnotations();

        await manager.deleteAnnotation("A1");

        expect(state.triggerUpdates).toEqual([{ path: ATTACHMENT, count: 1 }]);
    });

    it("is quiet about an id it does not hold", async () => {
        seedSidecar([anno("A1")]);
        await manager.loadAnnotations();

        await manager.deleteAnnotation("NOPE");

        expect(manager.getAllAnnotations()).toHaveLength(1);
    });

    it("leaves an empty envelope rather than deleting the file", async () => {
        seedSidecar([anno("A1")]);
        await manager.loadAnnotations();

        await manager.deleteAnnotation("A1");

        expect(readSidecar()).toEqual({ version: 1, annotations: [] });
    });
});

/* ================================================================ */
/*  updateAnnotationCommentFromNote                                 */
/* ================================================================ */

describe("updateAnnotationCommentFromNote", () => {
    it("converts markdown to Zotero's restricted HTML and reports a write", async () => {
        seedSidecar([anno("A1", { comment: "" })]);
        await manager.loadAnnotations();

        const wrote = await manager.updateAnnotationCommentFromNote(
            "A1",
            "**bold** and *italic*",
        );

        expect(wrote).toBe(true);
        const stored = readSidecar().annotations[0].comment;
        expect(stored).toContain("<b>bold</b>");
        expect(stored).toContain("<i>italic</i>");
    });

    it("does NOT re-render the source note", async () => {
        // The edit came from the note, which already shows the new text —
        // re-rendering would fight the user's cursor.
        seedSidecar([anno("A1")]);
        await manager.loadAnnotations();

        await manager.updateAnnotationCommentFromNote("A1", "edited");

        expect(state.triggerUpdates).toEqual([]);
    });

    it("bumps dateModified", async () => {
        seedSidecar([anno("A1", { dateModified: "2020-01-01T00:00:00Z" })]);
        await manager.loadAnnotations();

        await manager.updateAnnotationCommentFromNote("A1", "edited");

        expect(readSidecar().annotations[0].dateModified).not.toBe(
            "2020-01-01T00:00:00Z",
        );
    });

    it("loads from disk when the cache is cold", async () => {
        // The editor plugin can fire before the reader has ever opened.
        seedSidecar([anno("A1", { comment: "" })]);

        expect(
            await manager.updateAnnotationCommentFromNote("A1", "from a cold start"),
        ).toBe(true);
    });

    it("reports no write for an unknown id", async () => {
        seedSidecar([anno("A1")]);
        await manager.loadAnnotations();

        expect(
            await manager.updateAnnotationCommentFromNote("NOPE", "x"),
        ).toBe(false);
    });

    it("reports no write when the converted comment is unchanged", async () => {
        seedSidecar([anno("A1", { comment: "<b>bold</b>" })]);
        await manager.loadAnnotations();

        expect(
            await manager.updateAnnotationCommentFromNote("A1", "**bold**"),
        ).toBe(false);
    });

    it.each(["readOnly", "isExternal"] as const)(
        "refuses to touch a %s annotation",
        async (flag) => {
            seedSidecar([anno("A1", { comment: "owned by the pdf", [flag]: true })]);
            await manager.loadAnnotations();

            expect(
                await manager.updateAnnotationCommentFromNote("A1", "my edit"),
            ).toBe(false);
            expect(readSidecar().annotations[0].comment).toBe("owned by the pdf");
        },
    );
});

it("keeps category tags and off-palette colors in the unchanged sidecar format", async () => {
    const original = anno("PROFILE1", { color: "#123456", tags: [{ name: "Methodology" }, { name: "todo" }] });
    await manager.saveAnnotation(original);
    const loaded = await newManager().loadAnnotations();
    expect(loaded).toEqual([original]);
    expect(readSidecar()).toMatchObject({ version: 1, annotations: [original] });
    expect(Object.keys(readSidecar().annotations[0]).some((key) => /profile|category|palette|resolved/i.test(key))).toBe(false);
});
