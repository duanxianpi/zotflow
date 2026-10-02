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

describe("both sides edited different fields of an item", () => {
    test("the edits merge: no conflict, both reach the server", async () => {
        await local.setTags(key("resnet"), [{ tag: "local-tag" }]);
        await remote.patch(key("resnet"), { title: "Remote title" });
        await local.sync();

        const row = await local.row(key("resnet"));
        const server = await remote.get(key("resnet"));
        fact(F, "local tags + remote title after a sync", { status: row.syncStatus, title: server.data.title, tags: server.data.tags });
        assert.equal(row.syncStatus, "synced");
        assert.equal(server.data.title, "Remote title");
        assert.deepEqual(server.data.tags.map((t) => t.tag), ["local-tag"]);
        assert.deepEqual(await local.conflicts(), []);
    });
});

describe("both sides edited the same field (a note's text)", () => {
    const N = () => key("attention-note");

    async function changedConflict() {
        await local.editNote(N(), "Local text");
        await remote.patch(N(), { note: "<p>Remote text</p>" });
        await local.sync();
        const c = await local.conflict(N());
        assert.equal(c?.kind, "changed");
        assert.ok(c.conflictFields.includes("note"));
        assert.match(c.remoteData.note, /Remote text/);
        assert.equal((await local.row(N())).syncStatus, "conflict");
    }

    test("keep-local uploads the local text as a patch", async () => {
        await changedConflict();
        await local.resolve(N(), "keep-local");
        const w = await syncAndWrites();

        assert.deepEqual(w, ["POST /items → 200"]);
        assert.match((await remote.get(N())).data.note, /Local text/);
        assert.equal((await local.row(N())).syncStatus, "synced");
    });

    test("accept-remote takes the server's version and sends nothing", async () => {
        await changedConflict();
        await local.resolve(N(), "accept-remote");

        const row = await local.row(N());
        assert.equal(row.syncStatus, "synced");
        assert.match(row.raw.data.note, /Remote text/);
        assert.deepEqual(await syncAndWrites(), []);
    });

    test("an edit made during the conflict waits for the user", async () => {
        await changedConflict();
        await local.editNote(N(), "Edited during the conflict");
        assert.deepEqual(await syncAndWrites(), [], "nothing pushed while in conflict");
        assert.equal((await local.row(N())).syncStatus, "conflict");
        assert.match((await remote.get(N())).data.note, /Remote text/);
    });
});

describe("the server deleted an item edited locally", () => {
    test("keep-local creates it again under the same key", async () => {
        await local.setTags(key("legal-patent"), [{ tag: "keep-me" }]);
        await remote.delete(key("legal-patent"));
        await local.sync();
        assert.equal((await local.conflict(key("legal-patent")))?.kind, "remote-deleted");

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
        const parent = await local.conflict(root);
        const note = await local.conflict(key("attention-note"));
        assert.equal(parent?.kind, "remote-deleted");
        assert.equal(parent.group, root);
        assert.equal(note?.kind, "remote-deleted");
        assert.equal(note.group, root);
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
        // Joined at once, before any sync.
        assert.equal((await local.conflict(newNote))?.group, key("attention"));
        await local.sync();
        assert.equal((await local.conflict(newNote))?.group, key("attention"));
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
        assert.equal((await local.conflict(A()))?.kind, "changed");

        await local.deleteAnnotations(PDF(), [A()]);

        assert.equal((await local.conflict(A()))?.kind, "local-deleted");
        assert.equal(await local.row(A()), undefined);
        assert.ok(!(await visible(PDF())).includes(A()), "hidden in the reader");
        assert.deepEqual(await syncAndWrites(), [], "no DELETE behind the user's back");
        assert.equal((await remote.get(A())).data.annotationComment, "remote comment");

        await local.resolve(A(), "keep-local");
        const w = await syncAndWrites();
        assert.match(w.join(), /DELETE \/items → 204/);
        assert.equal(await remote.get(A()), null);
    });

    test("a delete that meets a remote edit: keep-local sends a DELETE", async () => {
        await local.deleteAnnotations(PDF(), [A()]);
        await remote.patch(A(), { annotationComment: "remote comment" });
        await local.sync();
        assert.equal((await local.conflict(A()))?.kind, "local-deleted");
        assert.ok(!(await visible(PDF())).includes(A()), "stays hidden");

        await local.resolve(A(), "keep-local");
        const w = await syncAndWrites();

        assert.match(w.join(), /DELETE \/items → 204/);
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

        // The DELETE carries the library version as its precondition: the
        // edit made it 412, the download found the edit.
        const c = await local.conflict(A);
        fact(F, "DELETE after another client's edit", { kind: c?.kind, remote: c?.remoteData?.annotationComment });
        assert.equal(c?.kind, "local-deleted");
        assert.match(c.remoteData.annotationComment, /edited while our DELETE/);

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
        const c = await local.conflict(key("resnet"));
        fact(F, "server answer for a 300-character tag", { status: row.syncStatus, conflict: c && { kind: c.kind, error: c.syncError } });
        return row;
    }

    test("is a refused conflict with the server copy downloaded", async () => {
        const row = await refused();
        if (row.syncStatus !== "conflict") {
            // The server accepted it: nothing to resolve, but record that.
            assert.equal(row.syncStatus, "synced");
            return;
        }
        const c = await local.conflict(key("resnet"));
        assert.equal(c.kind, "refused");
        assert.ok(c.remoteData && c.remoteData.title, "server copy downloaded");
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

describe("a conflict on one field leaves the other changes merged", () => {
    // Both sides change the annotation's comment (the conflict); only this
    // side changes its colour, only the server its tags.
    const A = () => key("attention-pdf-highlight-transformer");
    const PDF = () => key("attention-pdf");

    async function oneFieldConflict() {
        await local.editAnnotation(PDF(), A(), { comment: "local comment", color: "#ffd400" });
        await remote.patch(A(), { annotationComment: "remote comment", tags: [{ tag: "remote-tag" }] });
        await local.sync();
        const c = await local.conflict(A());
        fact(F, "fields listed for a comment conflict with other fields changed on each side", c?.conflictFields);
        assert.equal(c?.kind, "changed");
        assert.deepEqual(c.conflictFields, ["annotationComment"]);
    }

    test("keep-local keeps the local comment and colour, and takes the server's tags", async () => {
        await oneFieldConflict();
        await local.resolve(A(), "keep-local");
        const w = await syncAndWrites();

        const server = (await remote.get(A())).data;
        assert.deepEqual(w, ["POST /items → 200"]);
        assert.equal(server.annotationComment, "local comment");
        assert.equal(server.annotationColor, "#ffd400");
        assert.deepEqual(server.tags.map((t) => t.tag), ["remote-tag"]);
        assert.equal((await local.row(A())).syncStatus, "synced");
    });

    test("accept-remote takes the server's copy as it is, colour included", async () => {
        await oneFieldConflict();
        await local.resolve(A(), "accept-remote");

        const row = await local.row(A());
        assert.equal(row.syncStatus, "synced");
        assert.equal(row.raw.data.annotationComment, "remote comment");
        assert.equal(row.raw.data.annotationColor, "#2ea8e5");
        assert.deepEqual(await syncAndWrites(), []);
    });
});

describe("tags changed on both sides", () => {
    test("are merged as a set: no conflict", async () => {
        // The note starts with "summary": this side removes it and adds one,
        // the server adds another.
        const N = key("attention-note");
        await local.setTags(N, [{ tag: "from-obsidian" }]);
        await remote.patch(N, { tags: [{ tag: "summary" }, { tag: "from-zotero" }] });
        await local.sync();

        const tags = (await remote.get(N)).data.tags.map((t) => t.tag).sort();
        fact(F, "tags after a removal + addition here and an addition there", tags);
        assert.deepEqual(await local.conflicts(), []);
        assert.deepEqual(tags, ["from-obsidian", "from-zotero"]);
        assert.equal((await local.row(N)).syncStatus, "synced");
    });
});

describe("trash on one side, an edit on the other", () => {
    const N = () => key("attention-note");

    test("trashed in Zotero, edited here: both apply, no conflict", async () => {
        await local.editNote(N(), "Edited here");
        await remote.patch(N(), { deleted: 1 });
        await local.sync();

        const server = (await remote.get(N())).data;
        const row = await local.row(N());
        fact(F, "remote trash + local text edit", { conflicts: (await local.conflicts()).length, deleted: server.deleted, trashed: row?.trashed });
        assert.deepEqual(await local.conflicts(), []);
        assert.ok(server.deleted, "in the server's trash");
        assert.match(server.note, /Edited here/);
        assert.equal(row.trashed, 1);
    });

    test("trashed here, edited in Zotero: both apply, no conflict", async () => {
        await local.deleteNote(N());
        await remote.patch(N(), { note: "<p>Edited in Zotero</p>" });
        await local.sync();

        const server = (await remote.get(N())).data;
        assert.deepEqual(await local.conflicts(), []);
        assert.ok(server.deleted, "in the server's trash");
        assert.match(server.note, /Edited in Zotero/);
        assert.equal((await local.row(N())).syncStatus, "synced");
    });
});

describe("a child note moved to another item in Zotero while edited here", () => {
    test("ends under the new parent with the local text, no conflict", async () => {
        const N = key("attention-note");
        await local.editNote(N, "Edited before the move");
        await remote.patch(N, { parentItem: key("resnet") });
        await local.sync();

        const server = (await remote.get(N)).data;
        assert.deepEqual(await local.conflicts(), []);
        assert.equal(server.parentItem, key("resnet"));
        assert.match(server.note, /Edited before the move/);
        assert.equal((await local.row(N)).parentItem, key("resnet"));
    });
});

describe("the server changes an item again around its conflict", () => {
    const N = () => key("attention-note");

    async function changedConflict() {
        await local.editNote(N(), "Local text");
        await remote.patch(N(), { note: "<p>Remote text</p>" });
        await local.sync();
        assert.equal((await local.conflict(N()))?.kind, "changed");
    }

    test("while in conflict: the conflict shows the newest server copy, keep-local uploads once", async () => {
        await changedConflict();
        await remote.patch(N(), { note: "<p>Remote text, second edit</p>" });
        await local.sync();

        const conflicts = await local.conflicts();
        assert.equal(conflicts.length, 1);
        assert.match(conflicts[0].remoteData.note, /second edit/);

        await local.resolve(N(), "keep-local");
        assert.deepEqual(await syncAndWrites(), ["POST /items → 200"], "no refused upload against a stale version");
        assert.match((await remote.get(N())).data.note, /Local text/);
    });

    test("after keep-local, before the upload: a new conflict, nothing overwritten", async () => {
        await changedConflict();
        await local.resolve(N(), "keep-local");
        await remote.patch(N(), { note: "<p>Remote text after keep-local</p>" });
        await local.sync();

        const c = await local.conflict(N());
        fact(F, "server edit between keep-local and its upload", { kind: c?.kind, fields: c?.conflictFields });
        assert.equal(c?.kind, "changed");
        assert.match(c.remoteData.note, /after keep-local/);
        assert.match((await remote.get(N())).data.note, /after keep-local/, "the server's edit is not overwritten unseen");
    });
});

describe("several conflicts at once", () => {
    test("resolve-all keep-local uploads every one in the next sync", async () => {
        const N = key("attention-note");
        const A = key("attention-pdf-highlight-transformer");
        const P = key("legal-patent");
        await local.editNote(N, "Local note text");
        await local.editAnnotationComment(A, "local comment");
        await local.setTags(P, [{ tag: "keep-me" }]);
        await remote.patch(N, { note: "<p>Remote note text</p>" });
        await remote.patch(A, { annotationComment: "remote comment" });
        await remote.delete(P);
        await local.sync();
        assert.deepEqual((await local.conflicts()).map((c) => c.kind).sort(), ["changed", "changed", "remote-deleted"]);

        const count = await local.resolveAll("keep-local");
        await local.sync();

        assert.equal(count, 3);
        assert.deepEqual(await local.conflicts(), []);
        assert.match((await remote.get(N)).data.note, /Local note text/);
        assert.equal((await remote.get(A)).data.annotationComment, "local comment");
        assert.deepEqual((await remote.get(P)).data.tags.map((t) => t.tag), ["keep-me"]);
    });
});

describe("a keep-local upload whose answer is lost", () => {
    test("is recognised on the next sync: no new conflict, the local text stays", async () => {
        const N = key("attention-note");
        await local.editNote(N, "Local text");
        await remote.patch(N, { note: "<p>Remote text</p>" });
        await local.sync();
        await local.resolve(N, "keep-local");

        await syncWithPause({ method: "POST" }, "lost");
        assert.match((await remote.get(N)).data.note, /Local text/, "the server applied it");
        await local.sync();

        assert.deepEqual(await local.conflicts(), []);
        assert.equal((await local.row(N)).syncStatus, "synced");
        assert.match((await remote.get(N)).data.note, /Local text/);
    });
});

describe("an annotation edited here and deleted in Zotero", () => {
    const A = () => key("attention-pdf-highlight-transformer");
    const PDF = () => key("attention-pdf");

    async function deletedConflict() {
        await local.editAnnotationComment(A(), "local comment");
        await remote.delete(A());
        await local.sync();
        assert.equal((await local.conflict(A()))?.kind, "remote-deleted");
    }

    test("keep-local creates it again with the local comment, shown in the reader", async () => {
        await deletedConflict();
        await local.resolve(A(), "keep-local");
        await local.sync();

        const server = await remote.get(A());
        assert.ok(server, "recreated");
        assert.equal(server.data.annotationComment, "local comment");
        assert.equal(server.data.parentItem, PDF());
        assert.ok((await visible(PDF())).includes(A()));
    });

    test("accept-remote removes it from the reader", async () => {
        await deletedConflict();
        await local.resolve(A(), "accept-remote");

        assert.equal(await local.row(A()), undefined);
        assert.ok(!(await visible(PDF())).includes(A()));
        assert.deepEqual(await syncAndWrites(), []);
    });
});
