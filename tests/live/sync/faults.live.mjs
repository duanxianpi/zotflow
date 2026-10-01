// Faults: a sync cut off partway. "lost" lets a request reach the real server
// and then drops its answer — what a dropped connection or Obsidian closing
// mid-sync leaves behind. "not-sent" fails it before it leaves.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { fact, intercept, key, local, remote, requests, reset, syncWithPause, writes } from "./lib.mjs";

const F = import.meta.filename;

beforeEach(reset);

async function syncAndWrites() {
    await intercept();
    await local.sync();
    return writes();
}

describe("a push whose answer was lost after the server applied it", () => {
    test("an update is recognised on the next sync: clean, no conflict, not sent again", async () => {
        await local.setTags(key("resnet"), [{ tag: "lost-answer" }]);
        await syncWithPause({ method: "POST" }, "lost");
        assert.deepEqual((await remote.get(key("resnet"))).data.tags, [{ tag: "lost-answer" }], "the server applied it");
        assert.equal((await local.row(key("resnet"))).syncStatus, "updated", "locally still pending");

        const w = await syncAndWrites();

        const row = await local.row(key("resnet"));
        fact(F, "lost update recognised from the real server copy", row.syncStatus);
        assert.equal(row.syncStatus, "synced");
        assert.equal(row.version, (await remote.get(key("resnet"))).version);
        assert.deepEqual(w, [], "not sent twice");
    });

    test("a create is recognised: one item on the server, clean locally", async () => {
        const noteKey = await local.createNote(key("resnet"));
        await local.editNote(noteKey, "Lost create");
        await syncWithPause({ method: "POST" }, "lost");
        assert.ok(await remote.get(noteKey), "the server created it");

        const w = await syncAndWrites();

        assert.equal((await local.row(noteKey)).syncStatus, "synced");
        assert.deepEqual(w, []);
        const children = await remote.children(key("resnet"));
        assert.equal(children.filter((c) => c === noteKey).length, 1);
    });

    test("deleting the lost create still deletes it on the server (annotation)", async () => {
        const newKey = "ZFTLSTAB"; // no O, 0 or 1: Zotero's key alphabet
        await local.createAnnotation(key("attention-pdf"), key("attention-pdf-highlight-transformer"), newKey, "lost create");
        await syncWithPause({ method: "POST" }, "lost");
        assert.ok(await remote.get(newKey), "the server created it");

        await local.deleteAnnotations(key("attention-pdf"), [newKey]);
        await local.sync();

        assert.equal(await remote.get(newKey), null, "deleted on the server");
        assert.equal(await local.row(newKey), undefined);
    });

    test("trashing the lost create trashes it on the server (note)", async () => {
        const noteKey = await local.createNote(key("resnet"));
        await local.editNote(noteKey, "Lost then trashed");
        await syncWithPause({ method: "POST" }, "lost");

        await local.deleteNote(noteKey);
        await local.sync();

        const server = await remote.get(noteKey);
        assert.ok(server?.data.deleted, "in the server's trash");
        assert.deepEqual(await local.conflicts(), []);
    });

    test("a further edit after the lost answer is pushed as an update", async () => {
        await local.setTags(key("resnet"), [{ tag: "first" }]);
        await syncWithPause({ method: "POST" }, "lost");
        await local.setTags(key("resnet"), [{ tag: "second" }]);

        await local.sync();

        assert.deepEqual((await remote.get(key("resnet"))).data.tags, [{ tag: "second" }]);
        assert.equal((await local.row(key("resnet"))).syncStatus, "synced");
        assert.deepEqual(await local.conflicts(), []);
    });

    test("a DELETE's lost answer is completed by the next pull", async () => {
        const A = key("attention-pdf-ink");
        await local.deleteAnnotations(key("attention-pdf"), [A]);
        await syncWithPause({ method: "DELETE" }, "lost");
        assert.equal(await remote.get(A), null, "the server deleted it");

        await local.sync();

        assert.equal(await local.row(A), undefined);
        assert.deepEqual(await local.conflicts(), []);
    });
});

describe("a push that never left", () => {
    test("an update stays pending and goes out next time", async () => {
        await local.setTags(key("resnet"), [{ tag: "retry-me" }]);
        await syncWithPause({ method: "POST" }, "not-sent");
        assert.equal((await local.row(key("resnet"))).syncStatus, "updated");
        assert.deepEqual((await remote.get(key("resnet"))).data.tags, []);

        await local.sync();

        assert.deepEqual((await remote.get(key("resnet"))).data.tags, [{ tag: "retry-me" }]);
        assert.equal((await local.row(key("resnet"))).syncStatus, "synced");
    });

    test("a create that never left, then deleted, sends nothing", async () => {
        const noteKey = await local.createNote(key("resnet"));
        await local.editNote(noteKey, "never sent");
        await syncWithPause({ method: "POST" }, "not-sent");
        await local.deleteNote(noteKey);

        const w = await syncAndWrites();

        fact(F, "writes after deleting a create that never left", w);
        assert.deepEqual(w, [], "the server never had it");
        assert.equal(await remote.get(noteKey), null);
        assert.equal(await local.row(noteKey), undefined);
        assert.deepEqual(await local.conflicts(), []);
    });

    test("a DELETE stays pending and goes out next time", async () => {
        const A = key("attention-pdf-ink");
        await local.deleteAnnotations(key("attention-pdf"), [A]);
        await syncWithPause({ method: "DELETE" }, "not-sent");
        assert.ok(await remote.get(A));

        await local.sync();

        assert.equal(await remote.get(A), null);
        assert.equal(await local.row(A), undefined);
    });
});

describe("a pull cut off partway", () => {
    test("leaves the library version alone, so the next sync gets everything", async () => {
        const before = (await local.library()).itemVersion;
        await remote.patch(key("resnet"), { title: "Remote A" });
        await remote.patch(key("morphology"), { title: "Remote B" });

        await syncWithPause({ method: "GET", url: "itemKey=" }, "not-sent");
        assert.equal((await local.library()).itemVersion, before);

        await local.sync();
        assert.equal((await local.row(key("resnet"))).title, "Remote A");
        assert.equal((await local.row(key("morphology"))).title, "Remote B");
        assert.equal((await local.library()).itemVersion, await remote.libraryVersion());
    });

    test("losing the versions listing changes nothing", async () => {
        await remote.patch(key("resnet"), { title: "Remote A" });
        await syncWithPause({ method: "GET", url: "format=versions" }, "lost");
        await local.sync();
        assert.equal((await local.row(key("resnet"))).title, "Remote A");
        const log = await requests();
        assert.ok(log.length > 0);
    });
});
