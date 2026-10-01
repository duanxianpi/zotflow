import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unzipSync } from "fflate";

import spec from "./fixture-library.mjs";
import {
    buildDesired,
    diffFields,
    fixtureKey,
    makeEpub,
    makePdf,
    md5,
    ownedSets,
    plan,
    planIsEmpty,
    purgePlan,
} from "./zotero-fixtures-lib.mjs";

const KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

/** Remote snapshot equal to the spec, as if apply had just run. */
function remoteFrom(desired) {
    return {
        collections: desired.collections.map((c) => ({ key: c.key, version: 1, data: { ...c.data } })),
        items: desired.items.map((i) => ({
            key: i.key,
            version: 1,
            data: { ...i.data, ...(i.file ? { md5: i.file.md5 } : {}) },
        })),
    };
}

const userItem = (key, data) => ({ key, version: 1, data: { key, ...data } });

describe("fixture keys", () => {
    it("are valid, prefixed Zotero keys and stable", () => {
        assert.match(fixtureKey("attention"), KEY);
        assert.ok(fixtureKey("attention").startsWith("ZFX"));
        assert.equal(fixtureKey("attention"), fixtureKey("attention"));
        assert.notEqual(fixtureKey("attention"), fixtureKey("attention-pdf"));
    });

    it("cover every spec object without collisions", () => {
        const desired = buildDesired(spec);
        const keys = [...desired.collections, ...desired.items].map((o) => o.key);
        assert.equal(new Set(keys).size, keys.length);
        for (const k of keys) assert.match(k, KEY);
    });
});

describe("generated files", () => {
    it("PDF bytes are deterministic and phrases resolve to rects", () => {
        const a = makePdf([["Hello fixture world"]]);
        const b = makePdf([["Hello fixture world"]]);
        assert.equal(a.md5, b.md5);
        assert.ok(a.bytes.toString("latin1").startsWith("%PDF-1.4"));
        const at = a.find("fixture");
        const [x0, , x1] = at.rects[0];
        // "Hello " is 2556/1000 em in Helvetica: 72 + 2.556 × 12.
        assert.equal(x0, 102.672);
        assert.ok(x1 > x0);
        assert.match(at.sortIndex, /^00000\|000006\|\d{5}$/);
        assert.throws(() => a.find("missing"), /not on page/);
    });

    it("PDF rejects non-ASCII text (Helvetica has no CJK glyphs)", () => {
        assert.throws(() => makePdf([["中文"]]).find("中文"), /ASCII only/);
    });

    it("EPUB is a valid, deterministic zip with mimetype first and stored", () => {
        const book = { title: "T", chapters: [{ title: "C", paragraphs: ["One two three."] }] };
        const a = makeEpub(book);
        assert.equal(a.md5, makeEpub(book).md5);
        assert.equal(a.bytes.subarray(30, 38).toString(), "mimetype");
        assert.equal(a.bytes.readUInt16LE(8), 0, "mimetype must be stored, not deflated");
        const files = unzipSync(a.bytes);
        assert.equal(Buffer.from(files.mimetype).toString(), "application/epub+zip");
        assert.ok(files["OEBPS/chapter1.xhtml"]);
        assert.equal(
            a.find("two").position.value,
            "epubcfi(/6/2!/4/4,/1:4,/1:7)",
        );
    });
});

describe("buildDesired", () => {
    const desired = buildDesired(spec);
    const byId = new Map(desired.items.map((i) => [i.id, i]));

    it("marks regular items in extra and notes with a data attribute", () => {
        assert.match(byId.get("attention").data.extra, /^zotflow-fixture: attention$/m);
        assert.match(byId.get("attention-note").data.note, /data-zotflow-fixture="attention-note"/);
        assert.equal(byId.get("attention-pdf").data.extra, undefined);
    });

    it("links children and annotations by fixture key, parents first", () => {
        const pdf = byId.get("attention-pdf");
        assert.equal(pdf.data.parentItem, fixtureKey("attention"));
        assert.equal(byId.get("attention-pdf-ink").data.parentItem, pdf.key);
        assert.equal(byId.get("attention-pdf-ink").depth, 2);
        assert.equal(typeof byId.get("attention-pdf-ink").data.annotationPosition, "string");
        assert.equal(md5(pdf.file.bytes), pdf.file.md5);
    });

    it("maps collection ids to keys under the root", () => {
        const papers = desired.collections.find((c) => c.id === "papers");
        assert.equal(papers.data.parentCollection, desired.rootKey);
        assert.ok(byId.get("attention").data.collections.includes(papers.key));
    });
});

describe("plan", () => {
    const desired = buildDesired(spec);

    it("creates everything in an empty library, uploading every file", () => {
        const p = plan(desired, { items: [], collections: [] });
        assert.equal(p.items.create.length, desired.items.length);
        assert.equal(p.collections.create.length, desired.collections.length);
        assert.equal(p.uploads.length, desired.items.filter((i) => i.file).length);
    });

    it("is empty when the library already matches", () => {
        assert.ok(planIsEmpty(plan(desired, remoteFrom(desired))));
    });

    it("never touches the user's own items or collections", () => {
        const remote = remoteFrom(desired);
        remote.items.push(
            userItem("USER2222", { itemType: "book", title: "Mine", extra: "" }),
            userItem("USER3333", { itemType: "note", parentItem: "USER2222", note: "<p>mine</p>" }),
            userItem("USER4444", { itemType: "attachment", linkMode: "imported_file", title: "x.pdf" }),
        );
        remote.collections.push({ key: "USERCOLL", version: 1, data: { key: "USERCOLL", name: "Mine", parentCollection: false } });
        const own = ownedSets(desired, remote);
        for (const k of ["USER2222", "USER3333", "USER4444"]) assert.ok(!own.items.has(k));
        assert.ok(!own.collections.has("USERCOLL"));
        assert.ok(planIsEmpty(plan(desired, remote)));
        const purge = purgePlan(desired, remote);
        assert.ok(!purge.deletes.items.some((i) => i.key.startsWith("USER")));
        assert.ok(!purge.deletes.collections.some((c) => c.key === "USERCOLL"));
    });

    it("refuses fixture keys held by objects it does not own", () => {
        const key = fixtureKey("attention");
        const remote = { collections: [], items: [userItem(key, { itemType: "book", title: "Someone else's" })] };
        const p = plan(desired, remote);
        assert.deepEqual(p.conflicts.map((c) => c.id), ["attention"]);
    });

    it("restores edited fields, clears added ones, and untrashes", () => {
        const remote = remoteFrom(desired);
        const attention = remote.items.find((i) => i.key === fixtureKey("attention"));
        attention.data.title = "Tampered";
        attention.data.series = "Added by a test";
        attention.data.deleted = 1;
        const p = plan(desired, remote);
        assert.deepEqual(p.items.update.map((u) => u.id), ["attention"]);
        assert.deepEqual(p.items.update[0].changes, {
            title: "Attention Is All You Need",
            series: "",
            deleted: 0,
        });
    });

    it("deletes things tests created under fixture items, but only the topmost", () => {
        const remote = remoteFrom(desired);
        const parent = fixtureKey("attention");
        remote.items.push(
            userItem("TEST2222", { itemType: "note", parentItem: parent, note: "<p>test</p>" }),
            userItem("TEST3333", { itemType: "attachment", parentItem: parent, linkMode: "linked_url" }),
            userItem("TEST4444", { itemType: "annotation", parentItem: "TEST3333" }),
        );
        const p = plan(desired, remote);
        assert.deepEqual(p.deletes.items.map((i) => i.key).sort(), ["TEST2222", "TEST3333"]);
    });

    it("re-uploads a file whose md5 changed", () => {
        const remote = remoteFrom(desired);
        const pdf = remote.items.find((i) => i.key === fixtureKey("attention-pdf"));
        pdf.data.md5 = "0".repeat(32);
        const p = plan(desired, remote);
        assert.deepEqual(p.uploads.map((u) => u.id), ["attention-pdf"]);
        assert.equal(p.uploads[0].oldMd5, "0".repeat(32));
    });

    it("purge deletes the root collection and top-level fixture items only", () => {
        const p = purgePlan(desired, remoteFrom(desired));
        assert.deepEqual(p.deletes.collections.map((c) => c.key), [desired.rootKey]);
        assert.ok(p.deletes.items.every((i) => !i.data.parentItem));
    });
});

describe("diffFields", () => {
    it("compares annotation positions as JSON and tags as sets", () => {
        const want = { annotationPosition: '{"a":1,"b":2}', tags: [{ tag: "b" }, { tag: "a" }] };
        const have = { annotationPosition: '{"a": 1, "b": 2}', tags: [{ tag: "a", type: 0 }, { tag: "b" }] };
        assert.deepEqual(diffFields(want, have), {});
    });
});
