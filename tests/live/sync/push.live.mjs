// Push: local changes made through the plugin's real services reaching the
// server — tags, note edits, new notes, trashed notes, annotation edits,
// creates and deletes — and how the library version moves per write.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { fact, intercept, key, local, remote, reset, writes } from "./lib.mjs";

const F = import.meta.filename;

beforeEach(reset);

/** Sync, recording writes and the library version before and after. */
async function pushAndMeasure() {
    const before = await remote.libraryVersion();
    await intercept();
    await local.sync();
    return { before, after: await remote.libraryVersion(), writes: await writes() };
}

describe("item fields", () => {
    test("a tag edit reaches the server and the row is clean again", async () => {
        await local.setTags(key("attention"), [{ tag: "pushed-tag" }, { tag: "auto-imported", type: 1 }]);
        assert.equal((await local.row(key("attention"))).syncStatus, "updated");

        const m = await pushAndMeasure();

        const server = await remote.get(key("attention"));
        assert.deepEqual(
            server.data.tags.map((t) => t.tag).sort(),
            ["auto-imported", "pushed-tag"],
        );
        const row = await local.row(key("attention"));
        assert.equal(row.syncStatus, "synced");
        assert.equal(row.version, server.version);
        assert.deepEqual(m.writes, ["POST /items → 200"]);
        assert.equal(m.after, m.before + 1, "one write, one version");
        fact(F, "library version bump for one multi-write POST", m.after - m.before);
        // Nothing else changed the library, so the push may skip re-pulling
        // its own write.
        assert.equal((await local.library()).itemVersion, m.after);
    });
});

describe("notes", () => {
    test("editing a note pushes its HTML", async () => {
        await local.editNote(key("attention-note"), "# Edited in ZotFlow\n\nNew body.");
        await pushAndMeasure();

        const server = await remote.get(key("attention-note"));
        assert.match(server.data.note, /Edited in ZotFlow/);
        assert.equal((await local.row(key("attention-note"))).syncStatus, "synced");
    });

    test("a new child note is created on the server under the same key", async () => {
        const noteKey = await local.createNote(key("resnet"));
        await local.editNote(noteKey, "Created in ZotFlow");
        assert.equal((await local.row(noteKey)).syncStatus, "created");

        const m = await pushAndMeasure();

        const server = await remote.get(noteKey);
        assert.ok(server, "created on the server");
        assert.equal(server.data.parentItem, key("resnet"));
        assert.match(server.data.note, /Created in ZotFlow/);
        const row = await local.row(noteKey);
        assert.equal(row.syncStatus, "synced");
        assert.equal(row.version, server.version);
        assert.deepEqual(m.writes, ["POST /items → 200"]);
    });

    test("deleting a note moves it to the server's trash", async () => {
        await local.deleteNote(key("attention-note"));
        await pushAndMeasure();

        const server = await remote.get(key("attention-note"));
        assert.ok(server, "still exists: trashed, not erased");
        assert.ok(server.data.deleted, "in the trash");
        assert.equal((await local.row(key("attention-note"))).trashed, 1);
    });

    test("deleting a note that was never pushed sends nothing", async () => {
        const noteKey = await local.createNote(key("resnet"));
        await local.deleteNote(noteKey);
        const m = await pushAndMeasure();
        assert.deepEqual(m.writes, []);
        assert.equal(await remote.get(noteKey), null);
    });
});

describe("annotations", () => {
    test("a comment edit reaches the server", async () => {
        await local.editAnnotationComment(key("attention-pdf-highlight-transformer"), "**Edited** comment");
        await pushAndMeasure();

        const server = await remote.get(key("attention-pdf-highlight-transformer"));
        assert.match(server.data.annotationComment, /<b>Edited<\/b> comment/);
    });

    test("a new annotation is created on the server", async () => {
        const newKey = "ZFTNEWAB"; // Zotero keys use 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ
        await local.createAnnotation(key("attention-pdf"), key("attention-pdf-highlight-transformer"), newKey, "made in the reader");
        const m = await pushAndMeasure();

        const server = await remote.get(newKey);
        assert.ok(server, "created");
        assert.equal(server.data.parentItem, key("attention-pdf"));
        assert.equal(server.data.annotationComment, "made in the reader");
        assert.equal((await local.row(newKey)).syncStatus, "synced");
        assert.deepEqual(m.writes, ["POST /items → 200"]);
    });

    test("an invalid key is refused for that item only and becomes a conflict", async () => {
        const badKey = "ZFTNEW01"; // 0 and 1 are not in Zotero's key alphabet
        await local.createAnnotation(key("attention-pdf"), key("attention-pdf-highlight-transformer"), badKey, "x");
        await pushAndMeasure();

        const row = await local.row(badKey);
        assert.equal(row.syncStatus, "conflict");
        assert.deepEqual(row.conflict, { kind: "push-rejected", pendingOp: "create" });
        fact(F, "server answer for an invalid item key", row.syncError);
        // Accept-remote drops it: the server never had it.
        await local.resolve(badKey, "accept-remote");
        assert.equal(await local.row(badKey), undefined);
    });

    test("deleting an annotation erases it on the server with a DELETE", async () => {
        await local.deleteAnnotations(key("attention-pdf"), [key("attention-pdf-underline")]);
        const m = await pushAndMeasure();

        assert.equal(await remote.get(key("attention-pdf-underline")), null);
        assert.equal(await local.row(key("attention-pdf-underline")), undefined);
        assert.equal(m.writes.length, 1);
        assert.match(m.writes[0], /^DELETE \/items\/\w+ → 204$/);
        fact(F, "library version bump for one DELETE", m.after - m.before);
    });
});

describe("several changes in one sync", () => {
    test("the push keeps up with the version its own writes produce", async () => {
        await local.setTags(key("resnet"), [{ tag: "a" }]);
        await local.editNote(key("attention-note"), "changed");
        await local.deleteAnnotations(key("attention-pdf"), [key("attention-pdf-note")]);
        await local.deleteAnnotations(key("attention-pdf"), [key("attention-pdf-highlight-title")]);

        const m = await pushAndMeasure();

        const posts = m.writes.filter((w) => w.startsWith("POST")).length;
        const deletes = m.writes.filter((w) => w.startsWith("DELETE")).length;
        assert.equal(posts, 1, "both upserts in one POST");
        assert.equal(deletes, 2);
        // Measured: a POST moves the library by one per object sent, a
        // DELETE by one.
        assert.equal(m.after - m.before, 2 + deletes);
        assert.equal((await local.library()).itemVersion, m.after, "no needless re-pull");
        fact(F, "version bumps for 1 POST (2 items) + 2 DELETEs", m.after - m.before);
        for (const r of await local.rows()) assert.equal(r.syncStatus, "synced", r.key);
    });
});
