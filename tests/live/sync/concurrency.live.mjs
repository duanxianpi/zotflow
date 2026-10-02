// Concurrency: other writers while a sync is in flight — another Zotero
// client changing the library mid-push, and the user editing locally while
// their own push is on the wire.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { fact, key, local, remote, requests, reset, syncWithPause } from "./lib.mjs";

const F = import.meta.filename;

beforeEach(reset);

describe("another client writes while we push", () => {
    test("its edit landing before our DELETE is not skipped", async () => {
        // The DELETE carries the library version as its precondition: it is
        // refused (412), the edit is downloaded, then the DELETE is retried.
        await local.deleteAnnotations(key("attention-pdf"), [key("attention-pdf-ink")]);
        await syncWithPause({ method: "DELETE" }, "pass", () =>
            remote.patch(key("morphology"), { title: "By another client" }),
        );

        await local.sync();

        assert.equal((await local.row(key("morphology"))).title, "By another client");
        assert.equal(await remote.get(key("attention-pdf-ink")), null);
        assert.deepEqual(await local.pendingDeletes(), []);
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

    test("its edit of another field of the same item before our POST merges", async () => {
        await local.setTags(key("resnet"), [{ tag: "ours" }]);
        await syncWithPause({ method: "POST" }, "pass", () =>
            remote.patch(key("resnet"), { title: "Theirs" }),
        );

        const server = (await remote.get(key("resnet"))).data;
        fact(F, "other field of the same item edited remotely before our POST", { title: server.title, tags: server.tags });
        assert.equal(server.title, "Theirs", "not overwritten");
        assert.deepEqual(server.tags, [{ tag: "ours" }]);
        assert.equal((await local.row(key("resnet"))).syncStatus, "synced");
    });

    test("its edit of the same field before our POST becomes a conflict", async () => {
        const N = key("attention-note");
        await local.editNote(N, "Ours");
        await syncWithPause({ method: "POST" }, "pass", () => remote.patch(N, { note: "<p>Theirs</p>" }));

        const c = await local.conflict(N);
        fact(F, "same field edited remotely before our POST", c && { kind: c.kind, fields: c.conflictFields });
        assert.equal(c?.kind, "changed");
        assert.match((await remote.get(N)).data.note, /Theirs/, "not overwritten");
    });
});

describe("another client deletes an item we are updating, before our POST", () => {
    test("it becomes a remote-deleted conflict, and keep-local recreates it for good", async () => {
        // The POST is refused as a whole (412); the download finds the
        // deletion of an item with a pending edit.
        await local.setTags(key("legal-patent"), [{ tag: "ours" }]);
        await syncWithPause({ method: "POST" }, "pass", () => remote.delete(key("legal-patent")));

        const c = await local.conflict(key("legal-patent"));
        fact(F, "update of an item deleted before our POST", c && { kind: c.kind, group: c.group });
        assert.equal(c?.kind, "remote-deleted");

        await local.resolve(key("legal-patent"), "keep-local");
        await local.sync();
        await local.sync();

        assert.equal((await local.row(key("legal-patent"))).syncStatus, "synced");
        assert.deepEqual((await remote.get(key("legal-patent"))).data.tags, [{ tag: "ours" }]);
        assert.deepEqual(await local.conflicts(), []);
    });
});

describe("the user edits while their own push is in flight", () => {
    test("the edit is kept and goes up in the same sync", async () => {
        await local.setTags(key("resnet"), [{ tag: "first" }]);
        await syncWithPause({ method: "POST" }, "pass", () =>
            local.setTags(key("resnet"), [{ tag: "second" }]),
        );

        assert.deepEqual((await remote.get(key("resnet"))).data.tags, [{ tag: "second" }]);
        assert.equal((await local.row(key("resnet"))).syncStatus, "synced");
        assert.deepEqual(await local.conflicts(), []);
    });

    test("a note created and edited mid-push ends with the edit", async () => {
        const noteKey = await local.createNote(key("resnet"));
        await local.editNote(noteKey, "v1");
        await syncWithPause({ method: "POST" }, "pass", () => local.editNote(noteKey, "v2"));

        assert.match((await remote.get(noteKey)).data.note, /v2/);
        assert.equal((await local.row(noteKey)).syncStatus, "synced");
    });

    test("an annotation deleted mid-push of its create is deleted on the server", async () => {
        const newKey = "ZFTMIDDL";
        await local.createAnnotation(key("attention-pdf"), key("attention-pdf-highlight-transformer"), newKey, "mid-push");
        await syncWithPause({ method: "POST" }, "pass", () =>
            local.deleteAnnotations(key("attention-pdf"), [newKey]),
        );

        assert.equal(await remote.get(newKey), null);
        assert.equal(await local.row(newKey), undefined);
        assert.deepEqual(await local.pendingDeletes(), []);
    });
});
