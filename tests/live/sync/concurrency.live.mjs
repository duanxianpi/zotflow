// Concurrency: other writers while a sync is in flight — another Zotero
// client changing the library mid-push, and the user editing locally while
// their own push is on the wire.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { fact, key, local, remote, requests, reset, syncWithPause } from "./lib.mjs";

const F = import.meta.filename;

beforeEach(reset);

describe("another client writes while we push", () => {
    test("its edit landing between our pull and our DELETE is not skipped", async () => {
        // A DELETE checks only its own item, so it succeeds; advancing the
        // library version to its answer would skip the other edit forever.
        await local.deleteAnnotations(key("attention-pdf"), [key("attention-pdf-ink")]);
        await syncWithPause({ method: "DELETE" }, "pass", () =>
            remote.patch(key("morphology"), { title: "By another client" }),
        );

        await local.sync();

        assert.equal((await local.row(key("morphology"))).title, "By another client");
        assert.equal((await local.library()).itemVersion, await remote.libraryVersion());
    });

    test("its edit to another item before our POST: the POST is retried after a re-pull", async () => {
        await local.setTags(key("resnet"), [{ tag: "ours" }]);
        await syncWithPause({ method: "POST" }, "pass", () =>
            remote.patch(key("morphology"), { title: "By another client" }),
        );

        const log = await requests();
        const posts = log.filter((r) => r.method === "POST").map((r) => r.status);
        fact(F, "POST statuses when the library moved under it", posts);
        assert.deepEqual((await remote.get(key("resnet"))).data.tags, [{ tag: "ours" }]);
        assert.equal((await local.row(key("morphology"))).title, "By another client");
        assert.equal((await local.row(key("resnet"))).syncStatus, "synced");
    });

    test("its edit to the same item before our POST becomes a conflict", async () => {
        await local.setTags(key("resnet"), [{ tag: "ours" }]);
        await syncWithPause({ method: "POST" }, "pass", () =>
            remote.patch(key("resnet"), { title: "Theirs" }),
        );

        const row = await local.row(key("resnet"));
        fact(F, "same item edited remotely before our POST", { status: row.syncStatus, conflict: row.conflict, error: row.syncError });
        assert.equal(row.syncStatus, "conflict");
        assert.equal(row.serverCopyRaw.data.title, "Theirs");
        assert.equal((await remote.get(key("resnet"))).data.title, "Theirs", "not overwritten");
    });
});

describe("another client deletes an item we are updating, during our DELETE", () => {
    test("the item's own 404 is a conflict, and keep-local recreates it for good", async () => {
        // Our DELETE's answer carries the other client's version, so the POST
        // precondition passes and only the deleted item fails. The library
        // version stays behind; the next pull must not undo keep-local.
        await local.deleteAnnotations(key("attention-pdf"), [key("attention-pdf-ink")]);
        await local.setTags(key("legal-patent"), [{ tag: "ours" }]);
        await syncWithPause({ method: "DELETE" }, "pass", () => remote.delete(key("legal-patent")));

        const row = await local.row(key("legal-patent"));
        fact(F, "update of an item deleted mid-push", { status: row.syncStatus, conflict: row.conflict, error: row.syncError });
        assert.equal(row.syncStatus, "conflict");
        assert.equal(row.conflict.kind, "remote-delete");

        await local.resolve(key("legal-patent"), "keep-local");
        await local.sync();
        await local.sync();

        assert.equal((await local.row(key("legal-patent"))).syncStatus, "synced");
        assert.deepEqual((await remote.get(key("legal-patent"))).data.tags, [{ tag: "ours" }]);
        assert.deepEqual(await local.conflicts(), []);
    });
});

describe("the user edits while their own push is in flight", () => {
    test("the edit is kept and pushed next time", async () => {
        await local.setTags(key("resnet"), [{ tag: "first" }]);
        await syncWithPause({ method: "POST" }, "pass", () =>
            local.setTags(key("resnet"), [{ tag: "second" }]),
        );
        const mid = await local.row(key("resnet"));
        assert.equal(mid.syncStatus, "updated");
        assert.deepEqual(mid.searchTags, ["second"]);
        assert.deepEqual((await remote.get(key("resnet"))).data.tags, [{ tag: "first" }]);

        await local.sync();

        assert.deepEqual((await remote.get(key("resnet"))).data.tags, [{ tag: "second" }]);
        assert.equal((await local.row(key("resnet"))).syncStatus, "synced");
        assert.deepEqual(await local.conflicts(), []);
    });

    test("a note created and edited mid-push is created next time", async () => {
        const noteKey = await local.createNote(key("resnet"));
        await local.editNote(noteKey, "v1");
        await syncWithPause({ method: "POST" }, "pass", () => local.editNote(noteKey, "v2"));
        assert.equal((await local.row(noteKey)).syncStatus, "updated", "created by the push, edit pending");

        await local.sync();

        assert.match((await remote.get(noteKey)).data.note, /v2/);
        assert.equal((await local.row(noteKey)).syncStatus, "synced");
    });

    test("an annotation deleted mid-push of its create is deleted on the server", async () => {
        const newKey = "ZFTMIDDL";
        await local.createAnnotation(key("attention-pdf"), key("attention-pdf-highlight-transformer"), newKey, "mid-push");
        await syncWithPause({ method: "POST" }, "pass", () =>
            local.deleteAnnotations(key("attention-pdf"), [newKey]),
        );

        await local.sync();

        assert.equal(await remote.get(newKey), null);
        assert.equal(await local.row(newKey), undefined);
    });
});
