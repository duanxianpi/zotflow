// Server semantics the sync design relies on (docs/sync-architecture.md §8.5),
// probed straight against the API — no Obsidian involved. Every observation is
// recorded with fact(); assertions state what the design assumes, so a
// failure here means the design (or the fake server) has to change.
//
// Probe items are top-level items marked `zotflow-fixture: probe-…` in
// `extra`, so the fixture reset deletes them.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { api, fact, key, remote, resetServer } from "./lib.mjs";

const F = import.meta.filename;
const ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

beforeEach(resetServer);

const newKey = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

/** Create probe items (top-level reports); returns their keys. */
async function probeItems(n) {
    const keys = Array.from({ length: n }, newKey);
    const res = await remote.post(
        keys.map((k, i) => ({
            key: k,
            version: 0, // a key-based create needs version 0 or the library precondition (428 otherwise)
            itemType: "report",
            title: `probe ${i}`,
            extra: `zotflow-fixture: probe-${k}`,
            tags: [{ tag: "probe" }],
        })),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.failed ?? {}), []);
    return keys;
}

async function deleted(since) {
    const res = await api("GET", `/deleted?since=${since}`);
    return (await res.json()).items ?? [];
}

const lmv = (res) => Number(res.headers.get("Last-Modified-Version"));

describe("batch DELETE /items?itemKey=…", () => {
    test("deletes every key at once, one library version per key", async () => {
        const keys = await probeItems(3);
        const v0 = await remote.libraryVersion();

        const res = await api("DELETE", `/items?itemKey=${keys.join(",")}`, {
            headers: { "If-Unmodified-Since-Version": String(v0) },
        });

        const bump = lmv(res) - v0;
        fact(F, "batch DELETE of 3 items: status and version bump", { status: res.status, bump });
        assert.equal(res.status, 204);
        for (const k of keys) assert.equal(await remote.get(k), null);
        const log = await deleted(v0);
        assert.deepEqual(keys.filter((k) => !log.includes(k)), [], "all listed in /deleted");
        assert.equal(await remote.libraryVersion(), lmv(res), "response version is the library version");
    });

    test("is refused as a whole when the library moved on", async () => {
        const keys = await probeItems(2);
        const v0 = await remote.libraryVersion();
        await remote.patch(key("resnet"), { title: "moved on" });

        const res = await api("DELETE", `/items?itemKey=${keys.join(",")}`, {
            headers: { "If-Unmodified-Since-Version": String(v0) },
        });

        fact(F, "batch DELETE with a stale library version", { status: res.status });
        assert.equal(res.status, 412);
        for (const k of keys) assert.ok(await remote.get(k), `${k} kept`);
    });

    test("keys the server does not have are ignored", async () => {
        const [k] = await probeItems(1);
        const missing = newKey();
        const v0 = await remote.libraryVersion();

        const res = await api("DELETE", `/items?itemKey=${k},${missing}`, {
            headers: { "If-Unmodified-Since-Version": String(v0) },
        });

        fact(F, "batch DELETE including a missing key", { status: res.status, bump: lmv(res) - v0 });
        assert.equal(res.status, 204);
        assert.equal(await remote.get(k), null);
    });

    test("only missing keys: still a success", async () => {
        const v0 = await remote.libraryVersion();
        const res = await api("DELETE", `/items?itemKey=${newKey()},${newKey()}`, {
            headers: { "If-Unmodified-Since-Version": String(v0) },
        });
        fact(F, "batch DELETE of only missing keys", { status: res.status, bump: lmv(res) - v0 });
        assert.equal(res.status, 204);
    });

    test("deleting a parent through the batch also deletes its children", async () => {
        const [parent] = await probeItems(1);
        const child = newKey();
        const made = await remote.post([{ key: child, version: 0, itemType: "note", parentItem: parent, note: "<p>child</p>" }]);
        assert.deepEqual(Object.keys(made.body.failed ?? {}), []);
        const v0 = await remote.libraryVersion();

        const res = await api("DELETE", `/items?itemKey=${parent}`, {
            headers: { "If-Unmodified-Since-Version": String(v0) },
        });

        const log = await deleted(v0);
        fact(F, "batch DELETE of a parent: children deleted and logged", {
            status: res.status,
            childGone: (await remote.get(child)) === null,
            childLogged: log.includes(child),
        });
        assert.equal(res.status, 204);
        assert.equal(await remote.get(child), null);
        assert.ok(log.includes(child));
    });

    test("more than 50 keys in one request", async () => {
        const v0 = await remote.libraryVersion();
        const keys = Array.from({ length: 51 }, newKey);
        const res = await api("DELETE", `/items?itemKey=${keys.join(",")}`, {
            headers: { "If-Unmodified-Since-Version": String(v0) },
        });
        fact(F, "batch DELETE with 51 keys", { status: res.status, body: (await res.text()).slice(0, 120) });
        // Recorded only: the design sends at most 50 per request.
    });
});

describe("key-based writes without a version", () => {
    test("need version 0 or the library precondition", async () => {
        const k = newKey();
        const res = await remote.post([{ key: k, itemType: "report", title: "no version", extra: `zotflow-fixture: probe-${k}` }]);
        fact(F, "key-based create with neither version nor If-Unmodified-Since-Version", { failed: res.body.failed });
        assert.equal(res.body.failed?.["0"]?.code, 428);
    });

    test("with the library precondition a key-based create works", async () => {
        const k = newKey();
        const v0 = await remote.libraryVersion();
        const res = await remote.post([{ key: k, itemType: "report", title: "precondition", extra: `zotflow-fixture: probe-${k}` }], {
            "If-Unmodified-Since-Version": String(v0),
        });
        fact(F, "key-based create with only the library precondition", { failed: res.body.failed });
        assert.deepEqual(res.body.failed ?? {}, {});
        assert.ok(await remote.get(k));
    });
});

describe("creating an item whose key the server already has", () => {
    test("with the library precondition and no version", async () => {
        const [k] = await probeItems(1);
        const before = await remote.get(k);
        const v0 = await remote.libraryVersion();

        const res = await remote.post([{ key: k, itemType: "report", title: "create again", extra: `zotflow-fixture: probe-${k}` }], {
            "If-Unmodified-Since-Version": String(v0),
        });

        const after = await remote.get(k);
        fact(F, "create (precondition, no version) for an existing key", {
            failed: res.body.failed,
            successful: Object.keys(res.body.successful ?? {}),
            titleAfter: after.data.title,
            tagsKept: JSON.stringify(after.data.tags) === JSON.stringify(before.data.tags),
        });
    });

    test("with version 0", async () => {
        const [k] = await probeItems(1);
        const res = await remote.post([{ key: k, version: 0, itemType: "report", title: "version 0" }]);
        fact(F, "create (version 0) for an existing key", {
            failed: res.body.failed,
            successful: Object.keys(res.body.successful ?? {}),
        });
    });
});

describe("partial (patch-mode) upload", () => {
    test("an existing item: only the fields sent change", async () => {
        const [k] = await probeItems(1);
        const before = await remote.get(k);

        const res = await remote.post([{ key: k, version: before.version, tags: [{ tag: "patched" }] }]);

        const after = await remote.get(k);
        fact(F, "partial POST of an item (tags only)", {
            failed: res.body.failed,
            titleKept: after.data.title === before.data.title,
            extraKept: after.data.extra === before.data.extra,
            tags: after.data.tags,
        });
        assert.deepEqual(res.body.failed ?? {}, {});
        assert.equal(after.data.title, before.data.title);
        assert.equal(after.data.extra, before.data.extra);
        assert.deepEqual(after.data.tags, [{ tag: "patched" }]);
    });

    test("a note: parent and other fields kept", async () => {
        const note = await remote.get(key("attention-note"));

        const res = await remote.post([{ key: note.key, version: note.version, note: "<p>patched note</p>" }]);

        const after = await remote.get(note.key);
        fact(F, "partial POST of a note (note only)", {
            failed: res.body.failed,
            parentKept: after.data.parentItem === note.data.parentItem,
            noteSet: after.data.note === "<p>patched note</p>",
        });
        assert.deepEqual(res.body.failed ?? {}, {});
        assert.equal(after.data.parentItem, note.data.parentItem);
    });

    test("an annotation: position, text and colour kept", async () => {
        const a = await remote.get(key("attention-pdf-highlight-transformer"));

        const res = await remote.post([{ key: a.key, version: a.version, annotationComment: "patched comment" }]);

        const after = await remote.get(a.key);
        const kept = ["annotationPosition", "annotationText", "annotationColor", "annotationSortIndex", "parentItem"]
            .filter((f) => after.data[f] === a.data[f]);
        fact(F, "partial POST of an annotation (comment only)", { failed: res.body.failed, kept });
        assert.deepEqual(res.body.failed ?? {}, {});
        assert.equal(after.data.annotationComment, "patched comment");
        assert.equal(kept.length, 5);
    });

    test("trash and restore through a partial upload", async () => {
        const [k] = await probeItems(1);
        let item = await remote.get(k);
        await remote.post([{ key: k, version: item.version, deleted: 1 }]);
        item = await remote.get(k);
        const trashed = !!item.data.deleted;
        await remote.post([{ key: k, version: item.version, deleted: 0 }]);
        const restored = !(await remote.get(k)).data.deleted;
        fact(F, "partial POST of deleted: 1 then 0", { trashed, restored });
        assert.ok(trashed && restored);
    });

    test("an unchanged partial upload is reported as unchanged", async () => {
        const [k] = await probeItems(1);
        const item = await remote.get(k);
        const v0 = await remote.libraryVersion();
        const res = await remote.post([{ key: k, version: item.version, title: item.data.title }], {
            "If-Unmodified-Since-Version": String(v0),
        });
        fact(F, "partial POST that changes nothing", {
            unchanged: Object.keys(res.body.unchanged ?? {}),
            bump: res.version - v0,
        });
    });
});

describe("per-item version checks in a multi-object POST", () => {
    test("a stale item version with a current library version", async () => {
        const [k] = await probeItems(1);
        const stale = await remote.get(k);
        await remote.patch(k, { title: "changed meanwhile" });
        const v0 = await remote.libraryVersion();

        const res = await remote.post([{ key: k, version: stale.version, tags: [{ tag: "late" }] }], {
            "If-Unmodified-Since-Version": String(v0),
        });

        fact(F, "POST with a stale item version, library precondition current", {
            status: res.status,
            failed: res.body.failed,
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.failed?.["0"]?.code, 412);
        assert.equal((await remote.get(k)).data.title, "changed meanwhile", "not overwritten");
    });

    test("a version newer than the server's", async () => {
        const [k] = await probeItems(1);
        const item = await remote.get(k);
        const res = await remote.post([{ key: k, version: item.version + 1000, tags: [{ tag: "future" }] }]);
        fact(F, "POST with an item version ahead of the server", { status: res.status, failed: res.body.failed });
    });
});
