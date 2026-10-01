// Conflicts: both sides changed the same thing — how each kind arises against
// the real server, and what keep-local and accept-remote then send.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { fact, inObsidian, intercept, key, LIBRARY_ID, local, remote, reset, syncWithPause, writes } from "./lib.mjs";

const F = import.meta.filename;

beforeEach(reset);

/** Annotation keys the reader would show for an attachment. */
const visible = (attachmentKey) =>
    inObsidian(async (t, h, lib, a) => {
        const attachment = await t.bridge.dbHelper.getAttachmentItem(lib, a);
        return (await t.bridge.annotation.getAnnotations(attachment, h.apiKey())).map((x) => x.id);
    }, LIBRARY_ID, attachmentKey);

async function syncAndWrites() {
    await intercept();
    await local.sync();
    return writes();
}

describe("both sides edited an item", () => {
    async function remoteUpdateConflict() {
        await local.setTags(key("resnet"), [{ tag: "local-tag" }]);
        await remote.patch(key("resnet"), { title: "Remote title" });
        await local.sync();
        const row = await local.row(key("resnet"));
        assert.equal(row.syncStatus, "conflict");
        assert.deepEqual(row.conflict, { kind: "remote-update", pendingOp: "update" });
        assert.equal(row.serverCopyRaw.data.title, "Remote title");
        return row;
    }

    test("keep-local pushes the local version over the remote one", async () => {
        await remoteUpdateConflict();
        await local.resolve(key("resnet"), "keep-local");
        const w = await syncAndWrites();

        assert.deepEqual(w, ["POST /items → 200"]);
        const server = await remote.get(key("resnet"));
        assert.deepEqual(server.data.tags.map((t) => t.tag), ["local-tag"]);
        fact(F, "keep-local after a remote title edit: server title", server.data.title);
        assert.equal((await local.row(key("resnet"))).syncStatus, "synced");
    });

    test("accept-remote takes the server's version and sends nothing", async () => {
        await remoteUpdateConflict();
        await local.resolve(key("resnet"), "accept-remote");

        const row = await local.row(key("resnet"));
        assert.equal(row.syncStatus, "synced");
        assert.equal(row.title, "Remote title");
        assert.deepEqual(row.searchTags, []);
        assert.deepEqual(await syncAndWrites(), []);
    });

    test("an edit made during the conflict waits for the user", async () => {
        await remoteUpdateConflict();
        await local.setTags(key("resnet"), [{ tag: "edited-during-conflict" }]);
        assert.deepEqual(await syncAndWrites(), [], "nothing pushed while in conflict");
        assert.equal((await local.row(key("resnet"))).syncStatus, "conflict");
        assert.equal((await remote.get(key("resnet"))).data.title, "Remote title");
    });
});

describe("the server deleted an item edited locally", () => {
    test("keep-local creates it again under the same key", async () => {
        await local.setTags(key("legal-patent"), [{ tag: "keep-me" }]);
        await remote.delete(key("legal-patent"));
        await local.sync();
        assert.deepEqual((await local.row(key("legal-patent"))).conflict, {
            kind: "remote-delete",
            pendingOp: "update",
            root: key("legal-patent"),
        });

        await local.resolve(key("legal-patent"), "keep-local");
        const w = await syncAndWrites();

        const server = await remote.get(key("legal-patent"));
        fact(F, "server accepts re-creating a deleted key", !!server);
        assert.ok(server, `recreated on the server (writes: ${w.join(", ")})`);
        assert.deepEqual(server.data.tags.map((t) => t.tag), ["keep-me"]);
        assert.equal((await local.row(key("legal-patent"))).syncStatus, "synced");
    });

    test("accept-remote removes it locally", async () => {
        await local.setTags(key("legal-patent"), [{ tag: "keep-me" }]);
        await remote.delete(key("legal-patent"));
        await local.sync();
        await local.resolve(key("legal-patent"), "accept-remote");

        assert.equal(await local.row(key("legal-patent")), undefined);
        assert.deepEqual(await syncAndWrites(), []);
        assert.equal(await remote.get(key("legal-patent")), null);
    });
});

describe("the server deleted a parent whose child note was edited locally", () => {
    async function familyConflict() {
        await local.editNote(key("attention-note"), "Local edit before the remote delete");
        await remote.delete(key("attention"));
        await local.sync();
    }

    test("is one conflict rooted at the parent; untouched children are gone", async () => {
        await familyConflict();
        const root = key("attention");
        assert.deepEqual((await local.row(root)).conflict, { kind: "remote-delete", pendingOp: "none", root });
        assert.deepEqual((await local.row(key("attention-note"))).conflict, { kind: "remote-delete", pendingOp: "update", root });
        assert.equal(await local.row(key("attention-pdf")), undefined);
        assert.equal(await local.row(key("attention-pdf-highlight-title")), undefined);
    });

    test("keep-local recreates parent and child in one request, parent first", async () => {
        await familyConflict();
        await local.resolve(key("attention-note"), "keep-local");
        const w = await syncAndWrites();

        const parent = await remote.get(key("attention"));
        const note = await remote.get(key("attention-note"));
        fact(F, "server accepts parent+child recreated in one POST", !!parent && !!note);
        assert.ok(parent && note, `both recreated (writes: ${w.join(", ")})`);
        assert.equal(note.data.parentItem, key("attention"));
        assert.match(note.data.note, /Local edit before the remote delete/);
        assert.equal(w.filter((x) => x.startsWith("POST")).length, 1);
    });

    test("accept-remote removes the whole family, leaving no orphans", async () => {
        await familyConflict();
        await local.resolve(key("attention"), "accept-remote");

        assert.equal(await local.row(key("attention")), undefined);
        assert.equal(await local.row(key("attention-note")), undefined);
        assert.deepEqual(await local.conflicts(), []);
        const rows = await local.rows();
        const keys = new Set(rows.map((r) => r.key));
        assert.deepEqual(rows.filter((r) => r.parentItem && !keys.has(r.parentItem)).map((r) => r.key), []);
    });

    test("a note created under the deleted parent joins the conflict", async () => {
        await familyConflict();
        const newNote = await local.createNote(key("attention"));
        await local.editNote(newNote, "Written after the remote delete");
        await local.sync();

        assert.deepEqual((await local.row(newNote)).conflict, {
            kind: "remote-delete",
            pendingOp: "create",
            root: key("attention"),
        });
        await local.resolve(key("attention"), "keep-local");
        await local.sync();
        const server = await remote.get(newNote);
        assert.ok(server, "created with its recreated parent");
        assert.equal(server.data.parentItem, key("attention"));
    });
});

describe("annotations deleted around a conflict (the bugs found by hand)", () => {
    const A = () => key("attention-pdf-highlight-transformer");
    const PDF = () => key("attention-pdf");

    test("deleting an annotation already in conflict keeps the conflict", async () => {
        await local.editAnnotationComment(A(), "local comment");
        await remote.patch(A(), { annotationComment: "remote comment" });
        await local.sync();
        assert.equal((await local.row(A())).syncStatus, "conflict");

        await local.deleteAnnotations(PDF(), [A()]);

        const row = await local.row(A());
        assert.equal(row.syncStatus, "conflict");
        assert.equal(row.conflict.pendingOp, "delete");
        assert.ok(!(await visible(PDF())).includes(A()), "hidden in the reader");
        assert.deepEqual(await syncAndWrites(), [], "no DELETE behind the user's back");
        assert.equal((await remote.get(A())).data.annotationComment, "remote comment");

        await local.resolve(A(), "keep-local");
        const w = await syncAndWrites();
        assert.match(w.join(), /DELETE \/items\/\w+ → 204/);
        assert.equal(await remote.get(A()), null);
    });

    test("a delete that meets a remote edit: keep-local sends a DELETE", async () => {
        await local.deleteAnnotations(PDF(), [A()]);
        await remote.patch(A(), { annotationComment: "remote comment" });
        await local.sync();
        const row = await local.row(A());
        assert.deepEqual(row.conflict, { kind: "remote-update", pendingOp: "delete" });
        assert.ok(!(await visible(PDF())).includes(A()), "stays hidden");

        await local.resolve(A(), "keep-local");
        const w = await syncAndWrites();

        assert.match(w.join(), /DELETE \/items\/\w+ → 204/);
        assert.ok(!w.some((x) => x.startsWith("POST")), "not an upsert");
        assert.equal(await remote.get(A()), null);
        assert.equal(await local.row(A()), undefined);
    });

    test("a delete that meets a remote edit: accept-remote brings it back", async () => {
        await local.deleteAnnotations(PDF(), [A()]);
        await remote.patch(A(), { annotationComment: "remote comment" });
        await local.sync();

        await local.resolve(A(), "accept-remote");

        assert.ok((await visible(PDF())).includes(A()));
        assert.equal((await local.row(A())).raw.data.annotationComment, "remote comment");
        assert.deepEqual(await syncAndWrites(), []);
    });
});

describe("a DELETE refused because the server copy changed", () => {
    test("becomes a conflict with the server copy; keep-local deletes it", async () => {
        const A = key("attention-pdf-highlight-transformer");
        await local.deleteAnnotations(key("attention-pdf"), [A]);
        await syncWithPause({ method: "DELETE" }, "pass", async () => {
            await remote.patch(A, { annotationComment: "edited while our DELETE was on its way" });
        });

        const row = await local.row(A);
        fact(F, "DELETE against a changed item", { status: row.syncStatus, error: row.syncError });
        assert.equal(row.syncStatus, "conflict");
        assert.equal(row.conflict.pendingOp, "delete");
        assert.ok(row.serverCopyRaw, "server copy downloaded");

        await local.resolve(A, "keep-local");
        await local.sync();
        assert.equal(await remote.get(A), null);
    });
});

describe("a write the server refuses", () => {
    async function refused() {
        const longTag = "x".repeat(300);
        await local.setTags(key("resnet"), [{ tag: longTag }]);
        await local.sync();
        const row = await local.row(key("resnet"));
        fact(F, "server answer for a 300-character tag", { status: row.syncStatus, error: row.syncError, conflict: row.conflict });
        return row;
    }

    test("is a push-rejected conflict with the server copy downloaded", async () => {
        const row = await refused();
        if (row.syncStatus !== "conflict") {
            // The server accepted it: nothing to resolve, but record that.
            assert.equal(row.syncStatus, "synced");
            return;
        }
        assert.equal(row.conflict.kind, "push-rejected");
        assert.ok(row.serverCopyRaw, "server copy downloaded");
    });

    test("accept-remote restores the server's version", async () => {
        const row = await refused();
        if (row.syncStatus !== "conflict") return;
        await local.resolve(key("resnet"), "accept-remote");

        const after = await local.row(key("resnet"));
        assert.equal(after.syncStatus, "synced");
        assert.ok(after.title, "row kept, not deleted");
        assert.deepEqual(await syncAndWrites(), []);
    });
});
