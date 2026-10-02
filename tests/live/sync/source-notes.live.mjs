// Source notes after a sync: the subtree fingerprint (`item-tree`) catches
// child changes that leave the item's version alone, through the entry
// points a user has — a sync task, "Update all library source notes (skip
// up-to-date)", the file menu's "Update source note" — with "auto-update
// source notes after sync" off and on, and `library-version` keeping a
// device that is behind from rewriting a newer note.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { fact, inObsidian, key, LIBRARY_ID, local, remote, reset, session } from "./lib.mjs";

const F = import.meta.filename;

const PAPER = () => key("attention");
const HIGHLIGHT = () => key("attention-pdf-highlight-transformer");

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const setAutoUpdate = (on) =>
    inObsidian(async (t, h, on) => {
        const p = window.app.plugins.plugins.zotflow;
        p.settings.autoUpdateSourceNotesAfterSync = on;
        await p.saveSettings();
    }, on);

/** Delete every source note of the test library, so each test writes its own. */
const deleteSourceNotes = () =>
    inObsidian(async (t, h, lib) => {
        for (const file of window.app.vault.getMarkdownFiles()) {
            const fm = window.app.metadataCache.getFileCache(file)?.frontmatter;
            if (fm?.["library-id"] === lib) await window.app.vault.delete(file);
        }
    }, LIBRARY_ID);

/** The source note of `k`, created if missing (no forced render); returns its path. */
const notePath = (k) => inObsidian((t, h, lib, k) => t.bridge.libraryNote.ensureNote(lib, k, {}), LIBRARY_ID, k);
const read = (path) => inObsidian((t, h, p) => window.app.vault.adapter.read(p), path);
const mtime = (path) => inObsidian(async (t, h, p) => (await window.app.vault.adapter.stat(p))?.mtime, path);
const treeOf = (text) => /^item-tree:\s*"?(\w+)/m.exec(text)?.[1];

const tasks = () => inObsidian((t) => t.bridge.tasks.getTasks());
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function until(fn, { timeout = 60000, interval = 250, message }) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
        await sleep(interval);
    }
}

/** Wait until no task is pending or running, twice in a row. */
async function idle() {
    let quiet = 0;
    await until(async () => {
        quiet = (await tasks()).every((x) => TERMINAL.has(x.status)) ? quiet + 1 : 0;
        return quiet >= 2;
    }, { message: "tasks to finish", interval: 500 });
}

/** Tasks of `type` created at or after `since`. */
const tasksSince = async (type, since) => (await tasks()).filter((x) => x.type === type && x.createdTime >= since);

/** A sync run as a task, as the ribbon and the Activity Center start it. */
async function syncTask() {
    const id = await inObsidian((t) => t.bridge.createSyncTask());
    const done = await until(async () => {
        const task = (await tasks()).find((x) => x.id === id);
        return task && TERMINAL.has(task.status) && task;
    }, { message: "the sync task" });
    assert.equal(done.status, "completed", `sync task ${done.status}: ${done.error ?? ""}`);
    await idle();
}

/** Run "Update all library source notes (skip up-to-date)" and wait for its task. */
async function updateAll() {
    const since = await inObsidian(() => Date.now());
    await inObsidian(() => window.app.commands.executeCommandById("zotflow:update-all-library-source-notes"));
    const done = await until(async () => {
        const [task] = await tasksSince("batch-update-notes", since);
        return task && TERMINAL.has(task.status) && task;
    }, { message: "the update-all task" });
    assert.equal(done.status, "completed");
    await idle();
}

/**
 * "ZotFlow: Update source note" from the file explorer's context menu, with
 * real clicks. macOS shows native menus by default, which are not in the
 * page; they are switched off for the click and restored after.
 */
async function updateFromFileMenu(path) {
    const { page } = await session();
    const nativeMenus = await inObsidian(() => {
        const was = window.app.vault.getConfig("nativeMenus");
        window.app.vault.setConfig("nativeMenus", false);
        return was;
    });
    try {
        await rightClickUpdate(page, path);
    } finally {
        await inObsidian((t, h, was) => window.app.vault.setConfig("nativeMenus", was), nativeMenus);
    }
}

async function rightClickUpdate(page, path) {
    await inObsidian((t, h, p) => {
        const file = window.app.vault.getAbstractFileByPath(p);
        const leaf = window.app.workspace.getLeavesOfType("file-explorer")[0];
        window.app.workspace.revealLeaf(leaf);
        leaf.view.revealInFolder(file);
    }, path);
    await page.locator(`.nav-file-title[data-path="${path}"]`).click({ button: "right" });
    await page.locator(".menu-item", { hasText: "ZotFlow: Update source note" }).click();
}

/** Every source note of the test library with its modification time. */
const sourceNoteTimes = () =>
    inObsidian(async (t, h, lib) => {
        const out = {};
        for (const file of window.app.vault.getMarkdownFiles()) {
            const fm = window.app.metadataCache.getFileCache(file)?.frontmatter;
            if (fm?.["library-id"] === lib) out[file.path] = file.stat.mtime;
        }
        return out;
    }, LIBRARY_ID);

/* ------------------------------------------------------------------ */

beforeEach(async () => {
    await reset();
    await deleteSourceNotes();
    await setAutoUpdate(false);
});
afterEach(async () => {
    await session().then(({ page }) => page.keyboard.press("Escape")).catch(() => {});
    await setAutoUpdate(true);
});

describe("auto-update after sync off: a child changed in Zotero", () => {
    test("the sync leaves the note; Update all (skip up-to-date) refreshes it and no other", async () => {
        const path = await notePath(PAPER());
        const other = await notePath(key("resnet"));
        const before = await read(path);
        const otherTime = await mtime(other);

        await remote.patch(HIGHLIGHT(), { annotationComment: "Comment added in Zotero" });
        const since = await inObsidian(() => Date.now());
        await syncTask();

        assert.equal(await read(path), before, "not touched by the sync");
        assert.deepEqual(await tasksSince("batch-update-notes", since), [], "no post-sync refresh task");
        assert.equal((await local.row(PAPER())).version, Number(/^item-version:\s*(\d+)/m.exec(before)[1]), "the item's version did not move");

        await updateAll();

        const after = await read(path);
        assert.match(after, /Comment added in Zotero/);
        assert.notEqual(treeOf(after), treeOf(before));
        assert.equal(await mtime(other), otherTime, "an unchanged note is not rewritten");
    });

    test("the file menu's Update source note refreshes it", async () => {
        const path = await notePath(PAPER());
        const before = await read(path);

        await remote.patch(HIGHLIGHT(), { annotationComment: "Comment added in Zotero" });
        await syncTask();
        assert.equal(await read(path), before);

        await updateFromFileMenu(path);

        await until(async () => /Comment added in Zotero/.test(await read(path)), { message: "the note refreshed" });
        assert.notEqual(treeOf(await read(path)), treeOf(before));
    });

    test("a child deleted in Zotero is removed from the note", async () => {
        const path = await notePath(PAPER());
        assert.match(await read(path), /Title highlight with a comment\./);

        await remote.delete(key("attention-pdf-highlight-title"));
        await syncTask();
        assert.match(await read(path), /Title highlight with a comment\./, "not touched by the sync");

        await updateAll();

        assert.doesNotMatch(await read(path), /Title highlight with a comment\./);
    });

    test("a child note added in Zotero is added to the note", async () => {
        const path = await notePath(PAPER());

        const res = await remote.post([
            { itemType: "note", parentItem: PAPER(), note: "<p>Child note added in Zotero</p>", tags: [], collections: [], relations: {} },
        ]);
        assert.equal(res.status, 200);
        assert.equal(Object.keys(res.body.successful).length, 1);
        await syncTask();
        assert.doesNotMatch(await read(path), /Child note added in Zotero/);

        await updateAll();

        assert.match(await read(path), /Child note added in Zotero/);
    });

    test("with nothing changed, Update all rewrites no note", async () => {
        await updateAll();
        const times = await sourceNoteTimes();
        assert.ok(Object.keys(times).length > 5, "notes for the fixture items");

        await syncTask();
        await updateAll();

        assert.deepEqual(await sourceNoteTimes(), times);
    });
});

describe("auto-update after sync on", () => {
    test("a child changed in Zotero refreshes the note with no user action", async () => {
        await setAutoUpdate(true);
        const path = await notePath(PAPER());
        const before = await read(path);

        await remote.patch(HIGHLIGHT(), { annotationComment: "Comment added in Zotero" });
        const since = await inObsidian(() => Date.now());
        await syncTask();

        await until(async () => /Comment added in Zotero/.test(await read(path)), { message: "the note refreshed" });
        assert.notEqual(treeOf(await read(path)), treeOf(before));
        assert.equal((await tasksSince("batch-update-notes", since)).length, 1, "one post-sync refresh task");
    });
});

describe("a note rendered on a device that had synced further", () => {
    test("is left alone until this device has synced as far, then refreshed", async () => {
        const path = await notePath(PAPER());
        const cursor = (await local.library()).itemVersion;

        // What another device wrote after seeing version cursor + 1: a newer
        // fingerprint and render, stamped with that library version.
        await inObsidian(async (t, h, p, ahead) => {
            const file = window.app.vault.getAbstractFileByPath(p);
            await window.app.fileManager.processFrontMatter(file, (fm) => {
                fm["item-tree"] = "fromnewer";
                fm["library-version"] = ahead;
            });
            await window.app.vault.process(file, (text) => `${text}\nRendered on the other device.\n`);
        }, path, cursor + 1);

        await updateAll();
        assert.match(await read(path), /Rendered on the other device\./, "not rewritten from the older copy");

        // This device catches up: the server moves to cursor + 1 with the
        // change the other device had seen.
        const version = await remote.patch(HIGHLIGHT(), { annotationComment: "Comment added in Zotero" });
        fact(F, "server version after one patch, relative to the cursor", version - cursor);
        await syncTask();
        assert.ok((await local.library()).itemVersion >= cursor + 1);

        await updateAll();

        const after = await read(path);
        assert.doesNotMatch(after, /Rendered on the other device\./);
        assert.match(after, /Comment added in Zotero/);
    });
});
