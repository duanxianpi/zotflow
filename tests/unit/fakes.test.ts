/**
 * Self-tests for the test fixtures.
 *
 * The fakes are load-bearing for every service-level suite, so they get their
 * own coverage — a silently wrong fake server produces silently wrong sync
 * tests.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { db, resetDb, seedItem, seedLibrary } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";
import { createFakeZoteroServer } from "../fakes/zotero-server";

describe("resetDb", () => {
    beforeEach(async () => {
        await resetDb();
    });

    test("opens the real schema with all tables", async () => {
        expect(db.isOpen()).toBe(true);
        const names = db.tables.map((t) => t.name).sort();
        expect(names).toEqual([
            "collections",
            "cslCache",
            "files",
            "groups",
            "items",
            "keys",
            "libraries",
        ]);
    });

    test("compound and multi-entry indexes are queryable", async () => {
        await seedItem({
            libraryID: 1,
            key: "AAAAAAAA",
            syncStatus: "updated",
            collections: ["COLLONE"],
        });
        await seedItem({ libraryID: 1, key: "BBBBBBBB", syncStatus: "synced" });

        const dirty = await db.items
            .where("[libraryID+syncStatus]")
            .equals([1, "updated"])
            .toArray();
        expect(dirty.map((i) => i.key)).toEqual(["AAAAAAAA"]);

        const inCollection = await db.items
            .where("collections")
            .equals("COLLONE")
            .toArray();
        expect(inCollection.map((i) => i.key)).toEqual(["AAAAAAAA"]);
    });

    test("wipes state between calls", async () => {
        await seedLibrary({ id: 1 });
        expect(await db.libraries.count()).toBe(1);
        await resetDb();
        expect(await db.libraries.count()).toBe(0);
    });
});

describe("fake parent host", () => {
    test("records logs and notices", () => {
        const host = createFakeParentHost();
        host.log("error", "boom", "SyncService");
        host.log("debug", "chatter");
        host.notify("success", "done");

        expect(host.logsAt("error")).toHaveLength(1);
        expect(host.logsAt("error")[0]!.message).toBe("boom");
        expect(host.notices).toEqual([{ type: "success", message: "done" }]);
    });

    test("backs file operations with an in-memory vault", async () => {
        const host = createFakeParentHost({ files: { "a.md": "hello" } });

        expect(await host.readTextFile("a.md")).toBe("hello");
        expect(await host.readTextFile("missing.md")).toBeNull();
        expect((await host.checkFile("a.md")).exists).toBe(true);

        await host.writeTextFile("b.md", "world");
        expect(host.vault.get("b.md")).toBe("world");

        await host.deleteFile("a.md");
        expect((await host.checkFile("a.md")).exists).toBe(false);
    });

    test("round-trips flat frontmatter YAML", async () => {
        const host = createFakeParentHost();
        const yaml = await host.stringifyYaml({
            "zotero-key": "AAAAAAAA",
            version: 3,
            tags: ["one", "two"],
        });
        expect(await host.parseYaml(yaml)).toEqual({
            "zotero-key": "AAAAAAAA",
            version: 3,
            tags: ["one", "two"],
        });
    });

    test("throws on unconfigured capabilities rather than returning junk", async () => {
        const host = createFakeParentHost();
        await expect(host.readExternalBinaryFile("/tmp/x")).rejects.toThrow(
            /readExternalBinaryFile/,
        );
        await expect(host.request({ url: "https://x" } as any)).rejects.toThrow(
            /request/,
        );
    });
});

describe("fake zotero server", () => {
    let server: ReturnType<typeof createFakeZoteroServer>;

    beforeEach(() => {
        server = createFakeZoteroServer({ apiKey: "KEY", userID: 1 });
        server.install();
    });
    afterEach(() => server.restore());

    const get = (url: string) =>
        fetch(url, { headers: { "Zotero-API-Key": "KEY" } });

    test("bumps the library version on every write", () => {
        const lib = server.library(1);
        expect(lib.version).toBe(0);
        lib.addItem({ key: "AAAAAAAA" });
        expect(lib.version).toBe(1);
        lib.updateItem("AAAAAAAA", { title: "changed" });
        expect(lib.version).toBe(2);
        lib.deleteItem("AAAAAAAA");
        expect(lib.version).toBe(3);
    });

    test("format=versions returns only entries newer than `since`", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA" }); // v1
        lib.addItem({ key: "BBBBBBBB" }); // v2

        const all = await get(
            "https://api.zotero.org/users/1/items?format=versions&since=0",
        );
        expect(await all.json()).toEqual({ AAAAAAAA: 1, BBBBBBBB: 2 });
        expect(all.headers.get("Last-Modified-Version")).toBe("2");

        const delta = await get(
            "https://api.zotero.org/users/1/items?format=versions&since=1",
        );
        expect(await delta.json()).toEqual({ BBBBBBBB: 2 });
    });

    test("itemKey batch fetch honours the include param", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA", data: { title: "One" }, csljson: { id: "x" } });
        lib.addItem({ key: "BBBBBBBB", data: { title: "Two" } });

        const res = await get(
            "https://api.zotero.org/users/1/items?itemKey=AAAAAAAA,BBBBBBBB&include=data,csljson",
        );
        const body = (await res.json()) as any[];
        expect(body.map((i) => i.data.title)).toEqual(["One", "Two"]);
        expect(body[0].csljson).toEqual({ id: "x" });
        expect(body[1].csljson).toBeUndefined();
    });

    test("deleted endpoint reports tombstones newer than `since`", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA" }); // v1
        lib.deleteItem("AAAAAAAA"); // v2
        lib.addCollection({ key: "CCCCCCCC" }); // v3
        lib.deleteCollection("CCCCCCCC"); // v4

        const res = await get("https://api.zotero.org/users/1/deleted?since=2");
        expect(await res.json()).toMatchObject({
            items: [],
            collections: ["CCCCCCCC"],
        });
    });

    test("POST /items gives each object its own version, like the real API", async () => {
        // Measured against api.zotero.org: a multi-object write moves the
        // library by one version per object sent.
        server.library(1).addItem({ key: "AAAAAAAA" }); // v1

        const res = await fetch("https://api.zotero.org/users/1/items", {
            method: "POST",
            headers: {
                "Zotero-API-Key": "KEY",
                "If-Unmodified-Since-Version": "1",
            },
            body: JSON.stringify([
                { key: "BBBBBBBB", data: { key: "BBBBBBBB", title: "New" } },
                { key: "CCCCCCCC", data: { key: "CCCCCCCC", title: "Also new" } },
            ]),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("Last-Modified-Version")).toBe("3");
        const body = (await res.json());
        expect(Object.keys(body.successful)).toEqual(["0", "1"]);
        expect(body.successful["0"].version).toBe(2);
        expect(body.successful["1"].version).toBe(3);
        expect(server.library(1).items.get("BBBBBBBB")!.data.title).toBe("New");
    });

    test("POST /items 412s on a stale If-Unmodified-Since-Version", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA" }); // v1
        lib.addItem({ key: "BBBBBBBB" }); // v2 — written by another client

        const res = await fetch("https://api.zotero.org/users/1/items", {
            method: "POST",
            headers: {
                "Zotero-API-Key": "KEY",
                "If-Unmodified-Since-Version": "1",
            },
            body: JSON.stringify([{ key: "CCCCCCCC", data: {} }]),
        });

        expect(res.status).toBe(412);
        expect(res.headers.get("Last-Modified-Version")).toBe("2");
    });

    test("DELETE /items 412s when the item moved on, 404s when it is gone", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA" }); // v1
        lib.updateItem("AAAAAAAA", { title: "remote edit" }); // v2

        const stale = await fetch(
            "https://api.zotero.org/users/1/items/AAAAAAAA",
            {
                method: "DELETE",
                headers: {
                    "Zotero-API-Key": "KEY",
                    "If-Unmodified-Since-Version": "1",
                },
            },
        );
        expect(stale.status).toBe(412);

        const ok = await fetch("https://api.zotero.org/users/1/items/AAAAAAAA", {
            method: "DELETE",
            headers: {
                "Zotero-API-Key": "KEY",
                "If-Unmodified-Since-Version": "2",
            },
        });
        expect(ok.status).toBe(204);

        const gone = await fetch(
            "https://api.zotero.org/users/1/items/AAAAAAAA",
            {
                method: "DELETE",
                headers: { "Zotero-API-Key": "KEY" },
            },
        );
        expect(gone.status).toBe(404);
    });

    /*
     * Behaviour below is measured on api.zotero.org by
     * tests/live/sync/server.live.mjs; keep the two in step.
     */
    const post = (objects: unknown[], headers: Record<string, string> = {}) =>
        fetch("https://api.zotero.org/users/1/items", {
            method: "POST",
            headers: { "Zotero-API-Key": "KEY", ...headers },
            body: JSON.stringify(objects),
        }).then(async (r) => ({
            status: r.status,
            version: Number(r.headers.get("Last-Modified-Version")),
            body: (await r.json()) as {
                successful: Record<string, { version: number }>;
                unchanged: Record<string, string>;
                failed: Record<string, { code: number; message: string }>;
            },
        }));
    const batchDelete = (keys: string[], since?: number) =>
        fetch(`https://api.zotero.org/users/1/items?itemKey=${keys.join(",")}`, {
            method: "DELETE",
            headers: {
                "Zotero-API-Key": "KEY",
                ...(since === undefined ? {} : { "If-Unmodified-Since-Version": String(since) }),
            },
        });

    test("a key-based write needs a version or the library precondition (428)", async () => {
        const res = await post([{ key: "AAAAAAAA", itemType: "book" }]);
        expect(res.body.failed["0"]!.code).toBe(428);
        expect(server.library(1).items.has("AAAAAAAA")).toBe(false);
    });

    test("a create with version 0 on an existing key is a per-item 412", async () => {
        server.library(1).addItem({ key: "AAAAAAAA" });
        const res = await post([{ key: "AAAAAAAA", version: 0, itemType: "book" }]);
        expect(res.body.failed["0"]!.code).toBe(412);
    });

    test("a create without a version on an existing key merges into it", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA", data: { title: "old", tags: [{ tag: "kept" }] } });
        const res = await post([{ key: "AAAAAAAA", itemType: "journalArticle", title: "new" }], {
            "If-Unmodified-Since-Version": String(lib.version),
        });
        expect(res.body.failed).toEqual({});
        expect(lib.items.get("AAAAAAAA")!.data).toMatchObject({ title: "new", tags: [{ tag: "kept" }] });
    });

    test("an update is a patch: fields not sent are kept", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA", data: { title: "kept", extra: "kept too", tags: [] } });
        const item = lib.items.get("AAAAAAAA")!;
        await post([{ key: "AAAAAAAA", version: item.version, tags: [{ tag: "patched" }] }]);
        expect(lib.items.get("AAAAAAAA")!.data).toMatchObject({
            title: "kept",
            extra: "kept too",
            tags: [{ tag: "patched" }],
        });
    });

    test("a stale item version is a per-item 412; a missing item a 404", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA" }); // v1
        lib.updateItem("AAAAAAAA", { title: "moved on" }); // v2
        const res = await post(
            [
                { key: "AAAAAAAA", version: 1, title: "late" },
                { key: "BBBBBBBB", version: 5, title: "gone" },
            ],
            { "If-Unmodified-Since-Version": String(lib.version) },
        );
        expect(res.body.failed["0"]!.code).toBe(412);
        expect(res.body.failed["1"]!.code).toBe(404);
        expect(lib.items.get("AAAAAAAA")!.data.title).toBe("moved on");
    });

    test("batch DELETE removes the keys and their children, one version per request", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "PARENT01" });
        lib.addItem({ key: "CHILD001", data: { itemType: "note", parentItem: "PARENT01" } });
        lib.addItem({ key: "OTHER001" });
        const v0 = lib.version;

        const res = await batchDelete(["PARENT01", "OTHER001", "MISSING1"], v0);

        expect(res.status).toBe(204);
        expect(Number(res.headers.get("Last-Modified-Version"))).toBe(v0 + 1);
        expect([...lib.items.keys()]).toEqual([]);
        const log = (await (await get(`https://api.zotero.org/users/1/deleted?since=${v0}`)).json()) as {
            items: string[];
        };
        expect(log.items.sort()).toEqual(["CHILD001", "OTHER001", "PARENT01"]);
    });

    test("batch DELETE needs the library precondition and 412s as a whole when stale", async () => {
        const lib = server.library(1);
        lib.addItem({ key: "AAAAAAAA" });
        expect((await batchDelete(["AAAAAAAA"])).status).toBe(428);
        expect((await batchDelete(["AAAAAAAA"], lib.version - 1)).status).toBe(412);
        expect(lib.items.has("AAAAAAAA")).toBe(true);
    });

    test("rejects a wrong API key", async () => {
        const res = await fetch("https://api.zotero.org/users/1/items", {
            headers: { "Zotero-API-Key": "WRONG" },
        });
        expect(res.status).toBe(403);
    });

    test("failNext forces a one-shot failure on a matching path", async () => {
        server.library(1).addItem({ key: "AAAAAAAA" });
        server.failNext({ status: 500, pathIncludes: "/items" });

        expect((await get("https://api.zotero.org/users/1/items")).status).toBe(500);
        expect((await get("https://api.zotero.org/users/1/items")).status).toBe(200);
    });

    test("an unmodelled route throws instead of silently 404ing", async () => {
        await expect(get("https://api.zotero.org/users/1/searches")).rejects.toThrow(
            /unmodelled/,
        );
    });

    test("records every request", async () => {
        await get("https://api.zotero.org/users/1/items?format=versions&since=0");
        expect(server.requestsFor("/items")).toHaveLength(1);
        expect(server.requestsFor("/items")[0]!.query.get("since")).toBe("0");
    });
});
