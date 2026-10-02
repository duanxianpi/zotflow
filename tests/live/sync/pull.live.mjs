// Pull: the server's state arriving locally — first sync, remote edits,
// remote deletes and trash, and what a sync with nothing to do sends.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import spec from "../../../scripts/fixture-library.mjs";
import { buildDesired } from "../../../scripts/zotero-fixtures-lib.mjs";
import { fact, inObsidian, intercept, key, LIBRARY_ID, local, remote, requests, reset, writes } from "./lib.mjs";

const F = import.meta.filename;
const fixtures = buildDesired(spec);

beforeEach(reset);

describe("first sync", () => {
    test("every fixture object arrives, clean, at the server's version", async () => {
        const rows = new Map((await local.rows()).map((r) => [r.key, r]));
        for (const item of fixtures.items) {
            const row = rows.get(item.key);
            assert.ok(row, `${item.id} missing locally`);
            assert.equal(row.syncStatus, "synced", item.id);
        }
        assert.deepEqual(await local.conflicts(), []);
        const server = await remote.get(key("attention"));
        assert.equal(rows.get(key("attention")).version, server.version);
        fact(F, "fixture items synced", fixtures.items.length);
    });

    test("base-mapped titles come from the type's own field", async () => {
        // case → caseName, statute → nameOfAct: the server sends no `title`.
        const caseRow = await local.row(key("legal-case"));
        const statute = await local.row(key("legal-statute"));
        assert.ok(caseRow.title.length > 0, "case title");
        assert.equal(caseRow.title, caseRow.raw.data.caseName);
        assert.equal(statute.title, statute.raw.data.nameOfAct);
    });

    test("every annotation type arrives under its attachment", async () => {
        const rows = await local.rows();
        const expected = fixtures.items.filter((i) => i.data.itemType === "annotation");
        for (const a of expected) {
            const row = rows.find((r) => r.key === a.key);
            assert.ok(row, `${a.id} missing`);
            assert.equal(row.parentItem, a.data.parentItem);
            assert.equal(row.raw.data.annotationType, a.data.annotationType);
        }
        fact(F, "annotation types", [...new Set(expected.map((a) => a.data.annotationType))]);
    });

    test("an item in the trash arrives trashed", async () => {
        assert.equal((await local.row(key("trashed-document"))).trashed, 1);
    });

    test("the local library version equals the server's", async () => {
        assert.equal((await local.library()).itemVersion, await remote.libraryVersion());
    });
});

describe("remote changes", () => {
    test("an edit is pulled and the row stays clean", async () => {
        await remote.patch(key("attention"), { title: "Attention (edited remotely)" });
        await intercept();
        await local.sync();

        const row = await local.row(key("attention"));
        assert.equal(row.title, "Attention (edited remotely)");
        assert.equal(row.syncStatus, "synced");
        assert.equal(row.version, (await remote.get(key("attention"))).version);
        assert.deepEqual(await writes(), [], "a pull writes nothing");
    });

    test("deleting a child note removes it locally", async () => {
        await remote.delete(key("attention-note"));
        await local.sync();
        assert.equal(await local.row(key("attention-note")), undefined);
        assert.ok(await local.row(key("attention")), "parent untouched");
    });

    test("deleting an item removes it and its children locally", async () => {
        const children = await remote.children(key("attention"));
        await remote.delete(key("attention"));
        const serverKeptChildren = [];
        for (const c of children) if (await remote.get(c)) serverKeptChildren.push(c);
        fact(F, "server deletes children with their parent", serverKeptChildren.length === 0);

        await local.sync();

        assert.equal(await local.row(key("attention")), undefined);
        for (const c of children) {
            if (serverKeptChildren.includes(c)) continue;
            assert.equal(await local.row(c), undefined, `child ${c} left behind`);
        }
        const orphans = (await local.rows()).filter(
            (r) => r.parentItem && !children.includes(r.key) && r.parentItem === key("attention"),
        );
        assert.deepEqual(orphans, []);
    });

    test("an annotation deleted remotely disappears locally", async () => {
        await remote.delete(key("attention-pdf-underline"));
        await local.sync();
        assert.equal(await local.row(key("attention-pdf-underline")), undefined);
    });

    test("moving an item to the trash marks it trashed", async () => {
        await remote.patch(key("resnet"), { deleted: 1 });
        await local.sync();
        const row = await local.row(key("resnet"));
        assert.equal(row.trashed, 1);
        assert.equal(row.syncStatus, "synced");
    });

    test("restoring it from the trash clears that", async () => {
        await remote.patch(key("trashed-document"), { deleted: 0 });
        await local.sync();
        assert.equal((await local.row(key("trashed-document"))).trashed, 0);
    });
});

describe("a child changed by another client", () => {
    /** The source note's text, once it exists and carries `item-tree`. */
    const noteText = (k) =>
        inObsidian(async (t, h, lib, k) => {
            const path = await t.bridge.libraryNote.ensureNote(lib, k, {});
            for (let i = 0; i < 100; i++) {
                const text = await window.app.vault.adapter.read(path).catch(() => "");
                if (/item-tree:/.test(text)) return text;
                await new Promise((r) => window.setTimeout(r, 200));
            }
            return window.app.vault.adapter.read(path);
        }, LIBRARY_ID, k);
    const treeOf = (text) => /item-tree:\s*"?(\w+)/.exec(text)?.[1];

    test("leaves the parent's version, changes its item-tree, and a skip-up-to-date update re-renders the note", async () => {
        const parent = key("attention");
        const before = await local.row(parent);
        const noteBefore = treeOf(await noteText(parent));
        assert.ok(noteBefore, "the note carries item-tree");

        await remote.patch(key("attention-pdf-highlight-transformer"), { annotationComment: "changed by another client" });
        await local.sync();

        const after = await local.row(parent);
        fact(F, "parent version after a child annotation edit", { before: before.version, after: after.version });
        assert.equal(after.version, before.version, "Zotero leaves the parent's version alone");

        // Not forced: only the fingerprint says the note is stale.
        const noteAfter = treeOf(await noteText(parent));
        assert.ok(noteAfter);
        assert.notEqual(noteAfter, noteBefore, "re-rendered by a skip-up-to-date update");
    });
});

describe("a sync with nothing to do", () => {
    test("sends no writes and only a few reads", async () => {
        await intercept();
        await local.sync();
        const log = await requests();
        assert.deepEqual(log.filter((r) => r.method !== "GET"), []);
        fact(F, "requests for an idle sync", log.map((r) => new URL(r.url).pathname.replace(/^\/groups\/\d+/, "") + new URL(r.url).search.replace(/key=[^&]+/, "")));
    });
});
