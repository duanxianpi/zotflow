// Upgrade: a database written by the released 1.6.6 (Dexie v5, every sync
// fact in one `syncStatus` column) opened by this build (v6 title backfill,
// then the v7 sync model, src/db/sync/migrate-v7.ts), then synced.
//
// The released main.js runs in the test Obsidian and builds the old state
// itself: its own sync, its own note/tag/annotation services, against the
// real server and another client acting through the API. It has no test
// hooks, so its worker is driven with raw Comlink messages (`v6()`). The one
// state 1.6.6 reaches only through a race (a DELETE refused with 412) is
// written in the exact shape its sync writes.
//
// The tests run in order and share that state: build once, then check the
// migration, the first sync, the resolutions and that both sides end equal.
// Afterwards the current build is put back and both sides reset.
//
//   npm run build:plugin && npm run live:sync -- upgrade

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { LOCAL_DIR, installPluginFiles, pluginDir } from "../../../scripts/obsidian-harness.mjs";
import {
    api,
    config,
    ensureHooks,
    fact,
    inPage,
    intercept,
    key,
    LIBRARY_ID,
    local,
    remote,
    reset,
    resetServer,
    session,
    stopIntercepting,
    writes,
} from "./lib.mjs";

const F = import.meta.filename;
const RELEASE = "1.6.6";
const RELEASE_MAIN = join(LOCAL_DIR, "releases", RELEASE, "main.js");

/* ------------------------------------------------------------------ */
/*  Plugin builds                                                     */
/* ------------------------------------------------------------------ */

async function releaseMainJs() {
    if (existsSync(RELEASE_MAIN)) return RELEASE_MAIN;
    const url = `https://github.com/duanxianpi/zotflow/releases/download/${RELEASE}/main.js`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    mkdirSync(dirname(RELEASE_MAIN), { recursive: true });
    writeFileSync(RELEASE_MAIN, Buffer.from(await res.arrayBuffer()));
    return RELEASE_MAIN;
}

const pageEval = async (fn, arg) => (await session()).page.evaluate(fn, arg);

const disablePlugin = () => pageEval(() => window.app.plugins.disablePlugin("zotflow"));

/**
 * Load the released build. Its worker is caught as it is constructed (the
 * bridge makes it when main.js is evaluated) and kept on `window.__zfV6`.
 */
async function loadRelease() {
    const source = await releaseMainJs();
    await disablePlugin();
    const target = join(pluginDir(config), "main.js");
    // Replacing the file (not writing through it) leaves the repo's
    // main.js alone; installPluginFiles() links it back afterwards.
    rmSync(target, { force: true });
    copyFileSync(source, target);
    await pageEval(async () => {
        const Original = window.Worker;
        const v6 = (window.__zfV6 = { worker: null });
        window.Worker = class extends Original {
            constructor(url, options) {
                super(url, options);
                if (!v6.worker && String(url).startsWith("blob:")) v6.worker = this;
            }
        };
        try {
            await window.app.plugins.enablePlugin("zotflow");
        } finally {
            window.Worker = Original;
        }
        if (!v6.worker) throw new Error("The released build created no worker");
        let next = 0;
        // Comlink's wire format (4.x): APPLY on a path of the exposed
        // WorkerAPI; the service getters return the services themselves.
        v6.call = (path, args) =>
            new Promise((ok, fail) => {
                const id = `zf-upgrade-${++next}-${Math.random().toString(36).slice(2)}`;
                const listen = (ev) => {
                    const d = ev.data;
                    if (!d || d.id !== id) return;
                    v6.worker.removeEventListener("message", listen);
                    if (d.type === "HANDLER" && d.name === "throw") {
                        const e = d.value?.isError ? d.value.value : { message: String(d.value?.value) };
                        fail(new Error(`${path.join(".")}: ${e.message}`));
                    } else {
                        ok(d.value);
                    }
                };
                v6.worker.addEventListener("message", listen);
                v6.worker.postMessage({
                    id,
                    type: "APPLY",
                    path,
                    argumentList: args.map((value) => ({ type: "RAW", value })),
                });
            });
    });
    // The bridge initializes the worker during onload; wait until the
    // services answer (with an empty database they answer with an error).
    for (let i = 0; ; i++) {
        try {
            await v6(["dbHelper", "getLibraryNames"]);
            return;
        } catch (e) {
            if (!/not initialized/.test(String(e))) return;
            if (i > 60) throw e;
            await sleep(500);
        }
    }
}

/** Load this build (linked back from the repo) with the test hooks on. */
async function loadCurrent() {
    await disablePlugin();
    installPluginFiles(config);
    await pageEval(() => window.app.plugins.enablePlugin("zotflow"));
    await ensureHooks();
}

/** Call a 1.6.6 worker service method: `v6(["itemNote", "deleteNote"], lib, key)`. */
const v6 = (path, ...args) => pageEval(({ path, args }) => window.__zfV6.call(path, args), { path, args });

/**
 * Run `fn(call, h, ...args)` in the page against the 1.6.6 worker, for
 * calls that need the API key (it stays in the page).
 */
const inV6 = (fn, ...args) =>
    inPage(
        new Function(
            "h",
            "...args",
            `return (${fn.toString()})((path, ...a) => window.__zfV6.call(path, a), h, ...args);`,
        ),
        ...args,
    );

/* ------------------------------------------------------------------ */
/*  The 1.6.6 state                                                   */
/* ------------------------------------------------------------------ */

const K = {
    // refused: a 300-character tag (413), pushed by 1.6.6
    refused: key("legal-patent"),
    // changed: same field both sides (a note's text)
    noteBoth: key("attention-note"),
    // changed: different fields (local tags, remote title); 1.6.6 merged nothing
    itemBoth: key("resnet"),
    // deleted here (pending), changed in Zotero
    deletedChanged: key("attention-pdf-highlight-transformer"),
    attentionPdf: key("attention-pdf"),
    // remote deletion of a book whose grandchild annotation was edited here
    book: key("morphology"),
    bookEpub: key("morphology-epub"),
    bookAnnotation: key("morphology-epub-highlight"),
    // remote deletion of a book a note was created under here
    missing: key("missing-file"),
    missingPdf: key("missing-file-pdf"),
    // pending, never synced
    parent: key("attention"),
    commentEdited: key("attention-pdf-underline"),
    tagsEdited: key("cjk-article"),
    trashedNote: key("standalone-note"),
    deletedAnnotation: key("attention-pdf-ink"),
    // in Zotero's trash (put there by another client): 1.6.6 holds it synced, flagged deleted
    trashedAnnotation: key("attention-pdf-image"),
    // remote deletion of a PDF whose only change here was deleting its highlight
    deletedPdf: key("standalone-pdf"),
    deletedPdfHighlight: key("standalone-pdf-highlight"),
    // a DELETE 1.6.6 had refused with 412
    delete412: key("attention-pdf-note"),
    // base-field titles 1.6.6 stored empty
    legalCase: key("legal-case"),
    statute: key("legal-statute"),
};

const TEXT = {
    noteLocal: "Local text written in 1.6.6",
    noteRemote: "<p>Remote text written while 1.6.6 was installed</p>",
    remoteTitle: "Remote title written while 1.6.6 was installed",
    bookComment: "Edited in 1.6.6 before the book was deleted in Zotero",
    missingNote: "Note created in 1.6.6 under a book then deleted in Zotero",
    createdNote: "Created in 1.6.6, never synced",
    comment: "Comment edited in 1.6.6",
    remoteComment: "Changed in Zotero after 1.6.6 deleted it",
};

/** Filled in while 1.6.6 builds the state. */
const made = {};

/** Light copies of rows, for comparing before and after. */
const light = (rows) =>
    Object.fromEntries(
        rows.map((r) => [
            r.key,
            {
                itemType: r.itemType,
                parentItem: r.parentItem,
                syncStatus: r.syncStatus,
                syncError: r.syncError,
                hasServerCopy: !!r.serverCopyRaw,
                version: r.version,
                data: r.raw?.data,
            },
        ]),
    );

const setMode = (mode) =>
    pageEval(async ({ lib, mode }) => {
        const plugin = window.app.plugins.plugins.zotflow;
        plugin.settings.librariesConfig[lib].mode = mode;
        await plugin.saveSettings();
    }, { lib: LIBRARY_ID, mode });

const v6Sync = async () => {
    const result = await v6(["sync", "startSync"], undefined, undefined, LIBRARY_ID);
    assert.equal(result.failCount, 0, "1.6.6 sync failed");
};

/** A new Zotero-style key (the reader makes them this way). */
const newKey = () => {
    const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
};

async function buildV6State() {
    // Fresh database, released build, the key verified the way 1.6.6's
    // settings tab does it, the library downloaded.
    await stopIntercepting().catch(() => {});
    await resetServer();
    await pageEval(() => window.app.plugins.disablePlugin("hot-reload"));
    await disablePlugin();
    await inPage((h) => h.deleteDb());
    await loadRelease();
    await inV6((call) => call(["key", "verifyAndPersistKey"], window.app.plugins.plugins.zotflow.settings.zoteroapikey).then(() => true));
    await setMode("bidirectional");
    await v6Sync();
    assert.equal(await inPage((h) => h.dbVersion()), 50, "1.6.6 writes Dexie v5");

    // A write the server refuses: 1.6.6 marks it `conflict`, "413: …".
    await v6(["tag", "setItemTags"], LIBRARY_ID, K.refused, [{ tag: "x".repeat(300) }]);
    await v6Sync();

    // Conflicts. Downloaded only (read-only mode), so 1.6.6 pushes nothing
    // of what is pending under them.
    await setMode("readonly");
    await v6(["itemNote", "updateNoteContent"], LIBRARY_ID, K.noteBoth, TEXT.noteLocal, "editor");
    await remote.patch(K.noteBoth, { note: TEXT.noteRemote });

    await v6(["tag", "setItemTags"], LIBRARY_ID, K.itemBoth, [{ tag: "local-tag-1.6.6" }]);
    await remote.patch(K.itemBoth, { title: TEXT.remoteTitle });

    await inV6(async (call, h, lib, pdf, k) => {
        const attachment = await call(["dbHelper", "getAttachmentItem"], lib, pdf);
        await call(["annotation", "deleteAnnotations"], attachment, [k]);
    }, LIBRARY_ID, K.attentionPdf, K.deletedChanged);
    await remote.patch(K.deletedChanged, { annotationColor: "#ff6666" });

    await v6(["annotation", "updateAnnotationComment"], LIBRARY_ID, K.bookAnnotation, TEXT.bookComment);
    await remote.delete(K.book);

    made.missingNote = await v6(["itemNote", "createChildNote"], LIBRARY_ID, K.missing);
    await v6(["itemNote", "updateNoteContent"], LIBRARY_ID, made.missingNote, TEXT.missingNote, "editor");
    await remote.delete(K.missing);

    await inV6(async (call, h, lib, pdf, k) => {
        const attachment = await call(["dbHelper", "getAttachmentItem"], lib, pdf);
        await call(["annotation", "deleteAnnotations"], attachment, [k]);
    }, LIBRARY_ID, K.deletedPdf, K.deletedPdfHighlight);
    await remote.delete(K.deletedPdf);

    await remote.patch(K.trashedAnnotation, { deleted: 1 });

    await v6Sync();
    await setMode("bidirectional");

    // Pending, never synced.
    made.createdNote = await v6(["itemNote", "createChildNote"], LIBRARY_ID, K.parent);
    await v6(["itemNote", "updateNoteContent"], LIBRARY_ID, made.createdNote, TEXT.createdNote, "editor");

    made.createdAnnotation = newKey();
    made.externalAnnotation = newKey();
    await inV6(async (call, h, lib, pdfs, templates, ids) => {
        const apiKey = window.app.plugins.plugins.zotflow.settings.zoteroapikey;
        const keyInfo = await call(["annotation", "getKeyInfo"], apiKey);
        for (const [i, pdf] of pdfs.entries()) {
            const attachment = await call(["dbHelper", "getAttachmentItem"], lib, pdf);
            const all = await call(["annotation", "getAnnotations"], attachment, apiKey);
            const template = all.find((a) => a.id === templates[i]);
            if (!template) throw new Error(`No annotation ${templates[i]}`);
            const json = {
                ...template,
                id: ids[i],
                comment: i === 0 ? "Created in 1.6.6" : "",
                dateModified: new Date().toISOString(),
                // The second is read from the PDF file: never synced.
                ...(i === 1 ? { isExternal: true } : {}),
            };
            await call(["annotation", "saveAnnotations"], attachment, keyInfo, [...all, json]);
        }
    }, LIBRARY_ID,
    [K.attentionPdf, K.attentionPdf],
    [key("attention-pdf-highlight-title"), key("attention-pdf-text")],
    [made.createdAnnotation, made.externalAnnotation]);

    await v6(["annotation", "updateAnnotationComment"], LIBRARY_ID, K.commentEdited, TEXT.comment);
    await v6(["tag", "setItemTags"], LIBRARY_ID, K.tagsEdited, [{ tag: "中文标签" }, { tag: "pending-1.6.6" }]);
    await v6(["itemNote", "deleteNote"], LIBRARY_ID, K.trashedNote);
    await inV6(async (call, h, lib, pdf, keys) => {
        const attachment = await call(["dbHelper", "getAttachmentItem"], lib, pdf);
        await call(["annotation", "deleteAnnotations"], attachment, keys);
    }, LIBRARY_ID, K.attentionPdf, [K.deletedAnnotation, K.delete412]);

    // The 412: 1.6.6 sent the DELETE after another client had changed the
    // annotation, and kept the row as its push wrote it.
    await remote.patch(K.delete412, { annotationComment: TEXT.remoteComment });
    await inPage(async (h, lib, k) => {
        const row = await h.row(lib, k);
        await h.put({ ...row, syncStatus: "conflict", syncError: "Remote item has been modified since you deleted it." });
    }, LIBRARY_ID, K.delete412);

    made.v6Rows = light(await inPage((h, lib) => h.rows(lib), LIBRARY_ID));
    made.v6Library = await inPage((h, lib) => h.library(lib), LIBRARY_ID);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

// One suite, so its hooks run before lib.mjs closes the page connection.
describe("upgrade from 1.6.6", () => {
    before(async () => {
        await buildV6State();
        fact(F, "1.6.6 states built", Object.fromEntries(
            Object.entries(made.v6Rows)
                .filter(([, r]) => r.syncStatus !== "synced")
                .map(([k, r]) => [k, `${r.syncStatus}${r.syncError ? ` (${r.syncError})` : ""}`]),
        ));
    });

    after(async () => {
        // Back to this build and a clean library for whatever runs next.
        await loadCurrent().catch(() => {});
        await pageEval(() => window.app.plugins.enablePlugin("hot-reload")).catch(() => {});
        await reset();
    });

    const v6Row = (k) => made.v6Rows[k];

    describe("the 1.6.6 state", () => {
        // Guards the setup: each scenario is the state it is meant to be.
        test("has every kind of row 1.6.6 writes", () => {
            assert.equal(v6Row(K.refused)?.syncStatus, "conflict");
            assert.match(v6Row(K.refused).syncError, /^413: /);
            for (const k of [K.noteBoth, K.itemBoth, K.deletedChanged]) {
                assert.equal(v6Row(k)?.syncStatus, "conflict", k);
                assert.equal(v6Row(k).syncError, "Remote update conflict");
                assert.ok(v6Row(k).hasServerCopy);
            }
            for (const k of [K.book, K.missing]) {
                assert.equal(v6Row(k)?.syncStatus, "conflict", k);
                assert.match(v6Row(k).syncError, /^Remote deletion blocked/);
            }
            assert.equal(v6Row(made.missingNote)?.syncStatus, "created");
            assert.equal(v6Row(K.missingPdf), undefined, "the clean attachment followed its deleted parent");
            assert.equal(v6Row(made.createdNote)?.syncStatus, "created");
            assert.equal(v6Row(made.createdAnnotation)?.syncStatus, "created");
            assert.equal(v6Row(made.externalAnnotation)?.syncStatus, "ignore");
            assert.equal(v6Row(K.commentEdited)?.syncStatus, "updated");
            assert.equal(v6Row(K.tagsEdited)?.syncStatus, "updated");
            assert.equal(v6Row(K.trashedNote)?.syncStatus, "updated");
            assert.equal(v6Row(K.trashedNote).data.deleted, true);
            assert.equal(v6Row(K.deletedAnnotation)?.syncStatus, "deleted");
            assert.equal(v6Row(K.delete412)?.syncStatus, "conflict");
            assert.equal(v6Row(K.legalCase)?.syncStatus, "synced");
            assert.equal(v6Row(K.trashedAnnotation)?.syncStatus, "synced");
            assert.equal(Number(v6Row(K.trashedAnnotation).data.deleted), 1);
            for (const k of [K.deletedPdf, K.deletedPdfHighlight]) {
                assert.equal(v6Row(k)?.syncStatus, "conflict", k);
                assert.match(v6Row(k).syncError, /^Remote deletion blocked/, k);
            }
            assert.equal(v6Row(K.deletedPdfHighlight).data.deleted, true);
        });
    });

    describe("opening the 1.6.6 database with this build", () => {
        before(async () => {
            await loadCurrent();
            // Dexie opens (and upgrades) on the first query.
            made.conflicts = await local.conflicts();
            made.v7Rows = Object.fromEntries((await local.rows()).map((r) => [r.key, r]));
            made.deleteLog = await inPage(async (h, lib) => (await h.all("syncDeleteLog")).filter((r) => r.libraryID === lib), LIBRARY_ID);
            made.groups = await inPage(async (h, lib) => (await h.all("syncGroups")).filter((r) => r.libraryID === lib), LIBRARY_ID);
            fact(F, "conflicts after the migration", made.conflicts.map((c) => ({ key: c.key, kind: c.kind, group: c.group, fields: c.conflictFields })));
            fact(F, "remote-deletion groups after the migration", made.groups);
        });

        const row = (k) => made.v7Rows[k];
        const conflict = (k) => made.conflicts.find((c) => c.key === k);

        test("upgrades to v7", async () => {
            assert.equal(await inPage((h) => h.dbVersion()), 70);
        });

        test("loses no row but the pending deletes, and keeps the download cursor", async () => {
            const deletes = [K.deletedAnnotation, K.deletedChanged, K.delete412, K.deletedPdf, K.deletedPdfHighlight];
            const missing = Object.keys(made.v6Rows).filter((k) => !row(k) && !deletes.includes(k));
            assert.deepEqual(missing, []);
            for (const k of deletes) assert.equal(row(k), undefined, k);
            const lib = await local.library();
            assert.equal(lib.itemVersion, made.v6Library.itemVersion);
        });

        test("leaves synced rows and their data alone", () => {
            for (const [k, before] of Object.entries(made.v6Rows)) {
                if (before.syncStatus !== "synced") continue;
                const r = row(k);
                assert.equal(r.synced, 1, k);
                assert.equal(r.syncStatus, "synced", k);
                assert.deepEqual(r.raw.data, before.data, k);
                assert.equal("syncError" in r || "serverCopyRaw" in r, false, k);
            }
        });

        test("backfills the base-field titles 1.6.6 stored empty", () => {
            assert.equal(v6Row(K.legalCase).data.caseName, "Example v. Fixture");
            assert.equal(row(K.legalCase).title, "Example v. Fixture");
            assert.equal(row(K.statute).title, "Fixture Protection Act");
        });

        test("pending creates are unsynced rows at version 0", () => {
            for (const k of [made.createdNote, made.createdAnnotation, made.missingNote]) {
                assert.equal(row(k).synced, 0, k);
                assert.equal(row(k).version, 0, k);
            }
            assert.equal(row(made.createdNote).syncStatus, "created");
            assert.equal(row(made.createdAnnotation).syncStatus, "created");
        });

        test("pending edits are unsynced, with their local data", () => {
            for (const k of [K.commentEdited, K.tagsEdited, K.trashedNote]) {
                assert.equal(row(k).synced, 0, k);
                assert.equal(row(k).syncStatus, "updated", k);
                assert.deepEqual(row(k).raw.data, v6Row(k).data, k);
                assert.equal(conflict(k), undefined, k);
            }
        });

        test("a pending delete moves to the delete log with its row as snapshot", () => {
            const entry = made.deleteLog.find((d) => d.key === K.deletedAnnotation);
            assert.ok(entry, "in the delete log");
            assert.equal(entry.version, v6Row(K.deletedAnnotation).version);
            assert.equal(entry.parentItem, K.attentionPdf);
            assert.equal(entry.snapshot.key, K.deletedAnnotation);
            // So are the annotations whose "deleted" status 1.6.6 replaced
            // (by a conflict, by a 412): only their data still said so.
            assert.deepEqual(
                made.deleteLog.map((d) => d.key).sort(),
                [K.deletedAnnotation, K.deletedChanged, K.delete412].sort(),
            );
        });

        test("an annotation in Zotero's trash is no delete made here", () => {
            const r = row(K.trashedAnnotation);
            assert.equal(r?.synced, 1);
            assert.equal(Number(r.raw.data.deleted), 1);
            assert.equal(made.deleteLog.some((d) => d.key === K.trashedAnnotation), false);
        });

        test("a remote deletion blocked only by a delete made here just applies", () => {
            for (const k of [K.deletedPdf, K.deletedPdfHighlight]) {
                assert.equal(row(k), undefined, k);
                assert.equal(conflict(k), undefined, k);
            }
            assert.equal(made.groups.some((g) => g.root === K.deletedPdf), false);
        });

        test("an annotation read from the file stays local only", () => {
            const r = row(made.externalAnnotation);
            assert.equal(r.localOnly, true);
            assert.equal(r.syncStatus, "ignore");
        });

        test("a remote update conflict is a changed conflict with the server copy", () => {
            const c = conflict(K.noteBoth);
            assert.equal(c?.kind, "changed");
            assert.ok(c.conflictFields.includes("note"));
            assert.match(c.remoteData.note, /Remote text/);
            assert.match(c.localData.note, /Local text/);
            assert.equal(c.remoteVersion, v6Row(K.noteBoth).version);
            assert.equal(row(K.noteBoth).syncStatus, "conflict");

            const item = conflict(K.itemBoth);
            assert.equal(item?.kind, "changed");
            assert.equal(item.remoteData.title, TEXT.remoteTitle);
            assert.deepEqual(item.localData.tags.map((t) => t.tag), ["local-tag-1.6.6"]);
        });

        test("a delete made here, then changed in Zotero, is a conflict that still knows it was deleted here", () => {
            const c = conflict(K.deletedChanged);
            assert.ok(c, "listed");
            assert.equal(c.remoteData.annotationColor, "#ff6666");
            // 1.6.6 kept the row with `deleted: true` in its data; Keep Local
            // must send a DELETE, not an edit putting it in the trash.
            assert.equal(c.kind, "local-deleted");
        });

        test("a blocked remote deletion is one group: the root and every row under it", () => {
            const book = made.groups.find((g) => g.root === K.book);
            assert.ok(book, "group for the deleted book");
            assert.deepEqual([...book.members].sort(), [K.book, K.bookAnnotation, K.bookEpub].sort());
            for (const k of [K.book, K.bookEpub, K.bookAnnotation]) {
                assert.equal(conflict(k)?.kind, "remote-deleted", k);
                assert.equal(conflict(k).group, K.book, k);
            }
            const missing = made.groups.find((g) => g.root === K.missing);
            assert.deepEqual([...missing.members].sort(), [K.missing, made.missingNote].sort());
            assert.equal(conflict(made.missingNote)?.group, K.missing);
            assert.equal(made.groups.length, 2, "no other groups");
        });

        test("a refused write is a refused conflict with the server's reason", () => {
            const c = conflict(K.refused);
            assert.equal(c?.kind, "refused");
            assert.match(c.syncError, /^413: Tag/);
            assert.equal(row(K.refused).syncStatus, "conflict");
        });

        test("the DELETE refused with 412 is not lost", () => {
            // 1.6.6 recorded no server copy, only that the delete was refused:
            // it stays a delete to send. The next sync's DELETE is refused
            // (the library moved on), and the download meets the server's
            // change as a local-deleted conflict.
            const entry = made.deleteLog.find((d) => d.key === K.delete412);
            assert.ok(entry, "in the delete log");
            assert.equal(entry.version, v6Row(K.delete412).version);
            assert.equal(conflict(K.delete412), undefined);
        });

        test("no other conflicts", () => {
            const expected = [
                K.refused, K.noteBoth, K.itemBoth, K.deletedChanged,
                K.book, K.bookEpub, K.bookAnnotation, K.missing, made.missingNote,
            ].sort();
            assert.deepEqual(made.conflicts.map((c) => c.key).filter((k) => k !== K.delete412).sort(), expected);
        });
    });

    describe("the first sync after the upgrade", () => {
        before(async () => {
            await intercept();
            await local.sync();
            made.firstWrites = await writes();
            made.afterFirst = await local.conflicts();
            fact(F, "writes of the first sync after the upgrade", made.firstWrites);
            fact(F, "conflicts after the first sync", made.afterFirst.map((c) => ({ key: c.key, kind: c.kind, group: c.group })));
        });

        test("uploads what 1.6.6 left pending", async () => {
            const note = await remote.get(made.createdNote);
            assert.equal(note?.data.parentItem, K.parent);
            assert.match(note.data.note, /Created in 1\.6\.6, never synced/);

            const annotation = await remote.get(made.createdAnnotation);
            assert.equal(annotation?.data.parentItem, K.attentionPdf);
            assert.equal(annotation.data.annotationComment, "Created in 1.6.6");

            assert.match((await remote.get(K.commentEdited)).data.annotationComment, /Comment edited in 1\.6\.6/);
            assert.deepEqual(
                (await remote.get(K.tagsEdited)).data.tags.map((t) => t.tag).sort(),
                ["pending-1.6.6", "中文标签"].sort(),
            );
            // The API answers 1 for a trashed item.
            assert.equal(Number((await remote.get(K.trashedNote)).data.deleted), 1);
            assert.equal(await remote.get(K.deletedAnnotation), null);
            // What is still to delete waits on a local-deleted conflict.
            assert.deepEqual((await local.pendingDeletes()).sort(), [K.deletedChanged, K.delete412].sort());
            for (const k of [K.deletedChanged, K.delete412]) {
                assert.equal(made.afterFirst.find((c) => c.key === k)?.kind, "local-deleted", k);
            }
        });

        test("keeps the local-only annotation local", async () => {
            assert.equal(await remote.get(made.externalAnnotation), null);
            assert.equal((await local.row(made.externalAnnotation))?.syncStatus, "ignore");
        });

        test("uploads nothing under a conflict", async () => {
            assert.match((await remote.get(K.noteBoth)).data.note, /Remote text/);
            assert.equal((await remote.get(K.itemBoth)).data.title, TEXT.remoteTitle);
            assert.deepEqual((await remote.get(K.itemBoth)).data.tags, []);
            assert.equal((await remote.get(K.deletedChanged)).data.annotationColor, "#ff6666");
            assert.equal(await remote.get(K.book), null);
            assert.equal(await remote.get(made.missingNote), null);
            assert.deepEqual((await remote.get(K.refused)).data.tags, []);
            assert.equal(Number((await remote.get(K.trashedAnnotation))?.data.deleted), 1, "still in the trash");
        });

        test("the change made in Zotero after 1.6.6's refused DELETE is not overwritten", async () => {
            const server = await remote.get(K.delete412);
            const c = made.afterFirst.find((x) => x.key === K.delete412);
            assert.equal(server?.data.annotationComment, TEXT.remoteComment);
            assert.equal(c?.kind, "local-deleted");
        });

        test("the conflicts of 1.6.6 are still listed", () => {
            const keys = new Set(made.afterFirst.map((c) => c.key));
            for (const k of [K.refused, K.noteBoth, K.itemBoth, K.deletedChanged, K.book, K.missing, made.missingNote]) {
                assert.ok(keys.has(k), k);
            }
        });
    });

    describe("resolving the conflicts 1.6.6 left", () => {
        test("keep-local on a note uploads the local text", async () => {
            await local.resolve(K.noteBoth, "keep-local");
            await local.sync();
            assert.match((await remote.get(K.noteBoth)).data.note, /Local text written in 1\.6\.6/);
        });

        test("accept-remote on an item takes the server copy", async () => {
            await local.resolve(K.itemBoth, "accept-remote");
            await local.sync();
            const r = await local.row(K.itemBoth);
            assert.equal(r.syncStatus, "synced");
            assert.equal(r.raw.data.title, TEXT.remoteTitle);
            assert.deepEqual(r.raw.data.tags, []);
        });

        test("keep-local on the deleted book restores it in Zotero with the edit under it", async () => {
            await local.resolve(K.book, "keep-local");
            await local.sync();
            assert.equal((await remote.get(K.book))?.data.title, "Introducing Morphology");
            assert.equal((await remote.get(K.bookEpub))?.data.parentItem, K.book);
            assert.match((await remote.get(K.bookAnnotation))?.data.annotationComment ?? "", /Edited in 1\.6\.6/);
        });

        test("accept-remote on the other deleted book removes it here, with the note made under it", async () => {
            await local.resolve(K.missing, "accept-remote");
            await local.sync();
            assert.equal(await local.row(K.missing), undefined);
            assert.equal(await local.row(made.missingNote), undefined);
            assert.equal(await remote.get(made.missingNote), null);
        });

        test("accept-remote on the refused write restores the server's tags", async () => {
            await local.resolve(K.refused, "accept-remote");
            await local.sync();
            const r = await local.row(K.refused);
            assert.equal(r.syncStatus, "synced");
            assert.deepEqual(r.raw.data.tags, []);
        });

        test("keep-local on the delete made here deletes it in Zotero", async () => {
            await local.resolve(K.deletedChanged, "keep-local");
            await local.sync();
            assert.equal(await remote.get(K.deletedChanged), null);
            assert.equal(await local.row(K.deletedChanged), undefined);
        });

        test("then nothing is left: no conflict, nothing pending, an idle sync writes nothing", async () => {
            const rest = await local.conflicts();
            // The 412 case, if it came down as a conflict: take the server's change.
            for (const c of rest.filter((x) => x.key === K.delete412)) await local.resolve(c.key, "accept-remote");
            await local.sync();
            assert.deepEqual((await local.conflicts()).map((c) => c.key), []);
            assert.deepEqual(await local.pendingDeletes(), []);
            const unsynced = (await local.rows()).filter((r) => r.syncStatus !== "synced" && r.syncStatus !== "ignore");
            assert.deepEqual(unsynced.map((r) => `${r.key} ${r.syncStatus}`), []);
            await intercept();
            await local.sync();
            assert.deepEqual(await writes(), []);
        });

        test("and both sides hold the same items", async () => {
            const rows = (await local.rows()).filter((r) => !r.localOnly);
            const res = await api("GET", "/items?format=versions&includeTrashed=1");
            const server = await res.json();
            assert.deepEqual(rows.map((r) => r.key).sort(), Object.keys(server).sort());
            for (const r of rows) assert.equal(r.version, server[r.key], r.key);
        });
    });
});
