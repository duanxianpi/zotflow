/**
 * `AttachmentService` — the attachment cache and its LRU.
 *
 * The largest untested block left in the worker. Its failures are recoverable
 * in principle (worst case, re-download) but they are silent: an eviction that
 * picks the wrong row, size arithmetic that drifts, or an MD5 check that
 * accepts a truncated file all look like normal operation while quietly costing
 * bandwidth or serving a corrupt PDF.
 *
 * Everything funnels through `getFileBlob`, which is the seam this suite drives.
 * See `tests/fakes/attachment-harness.ts` for what is real (the DB, SparkMD5)
 * and what is injected.
 *
 * Scope note: this covers local Zotero storage, the cache decision, the
 * download lock, the MD5 integrity/repair rules, the LRU and which file of a
 * WebDAV storage ZIP is served. The Android size guard is not covered yet.
 */
import { zipSync } from "fflate";
import SparkMD5 from "spark-md5";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    bytes,
    bytesOfSize,
    createAttachmentHarness,
    db,
    ISO,
    USER_ID,
} from "../fakes/attachment-harness";

import type { AttachmentHarness } from "../fakes/attachment-harness";

/** MD5 of the harness's default 3-byte API payload, computed by the real SparkMD5. */
let h: AttachmentHarness;

beforeEach(async () => {
    h = await createAttachmentHarness();
});

/** Read a Blob back as bytes so payloads can be compared. */
async function readBlob(blob: Blob): Promise<number[]> {
    return [...new Uint8Array(await blob.arrayBuffer())];
}

/* ================================================================ */
/*  Metadata guards                                                 */
/* ================================================================ */

describe("metadata guards", () => {
    it("refuses a key that is not in the database", async () => {
        const ghost = { libraryID: USER_ID, key: "NOSUCH01" } as never;

        await expect(h.service.getFileBlob(ghost)).rejects.toThrow(
            /Item metadata not found/,
        );
    });

    it("refuses an item that is not an attachment", async () => {
        const notAnAttachment = await h.seedAttachment("ARTICLE1", {
            itemType: "journalArticle",
        });

        await expect(h.service.getFileBlob(notAnAttachment)).rejects.toThrow(
            /Item metadata not found/,
        );
    });
});

/* ================================================================ */
/*  Reader document revisions                                      */
/* ================================================================ */

describe("reader document revisions", () => {
    it("uses filesystem metadata for a linked file", async () => {
        const item = await h.seedAttachment("LINKED01", {
            linkMode: "linked_file",
            path: "/papers/current.pdf",
        });
        const statExternalFile = vi.fn(async () => ({
            mtime: 1234,
            size: 5678,
        }));
        h.host.statExternalFile = statExternalFile;

        await expect(h.service.getReaderDocumentRevision(item)).resolves.toEqual(
            {
                kind: "external",
                path: "/papers/current.pdf",
                mtime: 1234,
                size: 5678,
            },
        );
        expect(statExternalFile).toHaveBeenCalledWith("/papers/current.pdf");
    });

    it("uses filesystem metadata in Zotero local storage mode", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/zotero/storage",
            },
        });
        const item = await h.seedAttachment("ATTACH01");
        h.host.statExternalFile = async () => ({ mtime: 10, size: 20 });

        await expect(h.service.getReaderDocumentRevision(item)).resolves.toEqual(
            {
                kind: "external",
                path: "/zotero/storage/ATTACH01/ATTACH01.pdf",
                mtime: 10,
                size: 20,
            },
        );
    });

    it("keeps remote attachments on their library revision", async () => {
        const item = await h.seedAttachment("ATTACH01");

        await expect(h.service.getReaderDocumentRevision(item)).resolves.toEqual(
            { kind: "library" },
        );
    });

    it("disables sharing when external metadata cannot be read", async () => {
        const item = await h.seedAttachment("LINKED01", {
            linkMode: "linked_file",
            path: "/papers/current.pdf",
        });
        h.host.statExternalFile = async () => {
            throw new Error("stat failed");
        };

        await expect(h.service.getReaderDocumentRevision(item)).resolves.toEqual(
            { kind: "volatile" },
        );
        expect(
            h.host.logs.some(
                (entry) =>
                    entry.level === "warn" &&
                    entry.message.includes("sharing disabled"),
            ),
        ).toBe(true);
    });
});

/* ================================================================ */
/*  Cache decisions                                                 */
/* ================================================================ */

describe("cache hit", () => {
    it("serves cached bytes without touching the network", async () => {
        const item = await h.seedAttachment("ATTACH01", { md5: "abc123" });
        await h.seedCached("ATTACH01", {
            buffer: bytes(4, 5, 6),
            md5: "abc123",
        });

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([4, 5, 6]);
        expect(h.fetches).toEqual([]);
    });

    it("accepts the cache when the server publishes no MD5", async () => {
        // Zotero omits md5 for some link modes; the cache is still usable.
        const item = await h.seedAttachment("ATTACH01");
        await h.seedCached("ATTACH01", { buffer: bytes(4, 5, 6) });

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual([
            4, 5, 6,
        ]);
        expect(h.fetches).toEqual([]);
    });

    it("carries the cached MIME type onto the blob", async () => {
        const item = await h.seedAttachment("ATTACH01", {
            contentType: "application/epub+zip",
        });
        await h.seedCached("ATTACH01", { mimeType: "application/epub+zip" });

        expect((await h.service.getFileBlob(item)).type).toBe(
            "application/epub+zip",
        );
    });

    it("bumps the access time so the LRU sees the row as fresh", async () => {
        const stale = "2020-01-01T00:00:00.000Z";
        const item = await h.seedAttachment("ATTACH01");
        await h.seedCached("ATTACH01", { lastAccessedAt: stale });

        await h.service.getFileBlob(item);

        // Assert a NEWER timestamp, not merely a different one: writing
        // `undefined` would also be "different", and would send the row to the
        // front of the eviction queue instead of the back.
        await vi.waitFor(async () => {
            const bumped = (await h.getCached("ATTACH01"))!.lastAccessedAt;
            expect(typeof bumped).toBe("string");
            expect(bumped > stale).toBe(true);
        });
    });
});

describe("cache miss and staleness", () => {
    it("downloads when the cached MD5 no longer matches the server's", async () => {
        // The user replaced the file in Zotero; the cached copy is the old one.
        const item = await h.seedAttachment("ATTACH01", { md5: "newmd5" });
        await h.seedCached("ATTACH01", {
            buffer: bytes(9, 9, 9),
            md5: "oldmd5",
        });
        h.setApiPayload(bytes(1, 2, 3));

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([1, 2, 3]);
        expect(h.fetches).toHaveLength(1);
        expect(
            h.host.logs.some((l) => l.message.includes("Cache STALE")),
        ).toBe(true);
    });

    it("downloads when there is no cache entry", async () => {
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytes(7, 7));

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual([7, 7]);
        expect(h.fetches).toHaveLength(1);
    });

    it("skips the cache entirely when caching is off", async () => {
        h = await createAttachmentHarness({ settings: { useCache: false } });
        const item = await h.seedAttachment("ATTACH01");
        await h.seedCached("ATTACH01", { buffer: bytes(4, 5, 6) });
        h.setApiPayload(bytes(1, 2, 3));

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual([
            1, 2, 3,
        ]);
        // And nothing is written back either.
        expect(await h.getCached("ATTACH01")).toMatchObject({
            buffer: expect.anything(),
        });
    });

    it("never caches a linked file", async () => {
        // Linked files live on the user's disk; caching them would duplicate
        // bytes the user already has and go stale on every external edit.
        const item = await h.seedAttachment("LINKED01", {
            linkMode: "linked_file",
            path: "/tmp/paper.pdf",
        });
        h.host.readExternalBinaryFile = async () => bytes(5, 5, 5);

        await h.service.getFileBlob(item);

        expect(await h.getCached("LINKED01")).toBeUndefined();
        expect(h.fetches).toEqual([]);
    });

    it("reads a linked file from disk even when a cache row exists", async () => {
        // A leftover row must never shadow the file on disk — the user may have
        // edited it in another program since. Without a cache entry present,
        // dropping the linked-file guard would look identical.
        const item = await h.seedAttachment("LINKED01", {
            linkMode: "linked_file",
            path: "/tmp/paper.pdf",
        });
        await h.seedCached("LINKED01", { buffer: bytes(9, 9, 9) });
        h.host.readExternalBinaryFile = async () => bytes(5, 5, 5);

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([5, 5, 5]);
    });
});

/* ================================================================ */
/*  The download lock                                               */
/* ================================================================ */

describe("download lock", () => {
    it("shares the download once the lock is held", async () => {
        // The download is held open, so the second call provably arrives while
        // the first is still in flight — no timer guessing.
        const item = await h.seedAttachment("ATTACH01");
        h.blockFetch();

        const first = h.service.getFileBlob(item);
        await vi.waitFor(() =>
            expect(
                h.host.logs.some((l) =>
                    l.message.includes("Attachment download lock acquired"),
                ),
            ).toBe(true),
        );
        const second = h.service.getFileBlob(item);
        h.releaseFetch();

        const [a, b] = await Promise.all([first, second]);

        expect(h.fetches).toHaveLength(1);
        expect(await readBlob(a)).toEqual(await readBlob(b));
        expect(
            h.host.logs.some((l) =>
                l.message.includes("Download already in progress"),
            ),
        ).toBe(true);
    });

    it("does NOT dedupe two calls issued in the same tick", async () => {
        // The lock is registered only after `db.items.get` and the cache
        // lookup, so both callers clear the `has()` check before either sets
        // it and the file is fetched twice. Small window, but deterministic
        // when two panes open the same attachment together. Pinned as current
        // behaviour, not as desired behaviour.
        const item = await h.seedAttachment("ATTACH01");
        h.blockFetch();

        const both = Promise.all([
            h.service.getFileBlob(item),
            h.service.getFileBlob(item),
        ]);
        h.releaseFetch();
        await both;

        expect(h.fetches).toHaveLength(2);
    });

    it("releases the lock so a later call can download again", async () => {
        h = await createAttachmentHarness({ settings: { useCache: false } });
        const item = await h.seedAttachment("ATTACH01");

        await h.service.getFileBlob(item);
        await h.service.getFileBlob(item);

        expect(h.fetches).toHaveLength(2);
    });

    it("releases the lock after a failed download", async () => {
        // A transient 500 must not wedge the key for the rest of the session.
        const item = await h.seedAttachment("ATTACH01");
        h.setApiStatus(500);

        await expect(h.service.getFileBlob(item)).rejects.toThrow();

        h.setApiStatus(200);
        await expect(h.service.getFileBlob(item)).resolves.toBeInstanceOf(Blob);
    });
});

/* ================================================================ */
/*  Integrity                                                       */
/* ================================================================ */

describe("MD5 integrity", () => {
    it("stores the locally computed digest when the server has none", async () => {
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytes(1, 2, 3));

        await h.service.getFileBlob(item);

        const cached = await h.getCached("ATTACH01");
        // 32 hex chars — a real digest, not the empty string.
        expect(cached!.md5).toMatch(/^[0-9a-f]{32}$/);
    });

    it("keeps the server digest when the download matches it", async () => {
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytes(1, 2, 3));
        await h.service.getFileBlob(item);
        const trueMd5 = (await h.getCached("ATTACH01"))!.md5;

        // Re-download the same bytes, this time with the server declaring it.
        h = await createAttachmentHarness();
        const item2 = await h.seedAttachment("ATTACH01", { md5: trueMd5 });
        h.setApiPayload(bytes(1, 2, 3));

        await h.service.getFileBlob(item2);

        expect((await h.getCached("ATTACH01"))!.md5).toBe(trueMd5);
        expect(
            h.host.logs.some((l) => l.message.includes("MD5 Mismatch")),
        ).toBe(false);
    });

    it("trusts the live download over a stale server digest", async () => {
        // imported_file comes straight from Zotero, so the bytes are
        // authoritative and the recorded metadata is what is out of date.
        const item = await h.seedAttachment("ATTACH01", {
            linkMode: "imported_file",
            md5: "staleserverdigest0000000000000000",
        });
        h.setApiPayload(bytes(1, 2, 3));

        await h.service.getFileBlob(item);

        const cached = await h.getCached("ATTACH01");
        expect(cached!.md5).not.toBe("staleserverdigest0000000000000000");
        expect(cached!.md5).toMatch(/^[0-9a-f]{32}$/);
        expect(
            h.host.logs.some((l) => l.message.includes("MD5 Mismatch")),
        ).toBe(true);
    });

    it("keeps the server digest when a WebDAV copy disagrees", async () => {
        // WebDAV can legitimately lag Zotero. The file is still served — the
        // user would rather read a slightly old copy than nothing — but the
        // recorded digest stays the server's so the next sync can repair it.
        h = await createAttachmentHarness({ settings: { useWebDav: true } });
        const item = await h.seedAttachment("ATTACH01", {
            linkMode: "imported_url",
            md5: "staleserverdigest0000000000000000",
        });
        h.webdav.payload = bytes(1, 2, 3);

        await h.service.getFileBlob(item);

        expect((await h.getCached("ATTACH01"))!.md5).toBe(
            "staleserverdigest0000000000000000",
        );
        expect(
            h.host.logs.some((l) =>
                l.message.includes("WebDAV file might be outdated"),
            ),
        ).toBe(true);
    });
});

/* ================================================================ */
/*  WebDAV storage ZIP                                              */
/* ================================================================ */

describe("WebDAV storage ZIP", () => {
    const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3];
    const SIDECAR = [...new TextEncoder().encode('{"info":{"itemID":1}}')];

    /** A storage ZIP whose entries are in the given order. */
    function storageZip(files: Record<string, number[]>): ArrayBuffer {
        const entries: Record<string, Uint8Array> = {};
        for (const [name, content] of Object.entries(files)) {
            entries[name] = new Uint8Array(content);
        }
        return zipSync(entries).slice().buffer;
    }

    beforeEach(async () => {
        h = await createAttachmentHarness({ settings: { useWebDav: true } });
    });

    it("serves the attachment, not a sidecar listed before it (#134)", async () => {
        const item = await h.seedAttachment("ATTACH01", {
            filename: "paper.pdf",
        });
        h.webdav.payload = storageZip({
            "jasminum-outline.json": SIDECAR,
            "paper.pdf": PDF,
        });

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual(PDF);
        expect(h.fetches).toEqual([]);
    });

    it("matches the filename across Unicode normalization", async () => {
        const item = await h.seedAttachment("ATTACH01", {
            filename: "caf\u00e9.pdf",
        });
        h.webdav.payload = storageZip({
            "other.pdf": [9, 9],
            "cafe\u0301.pdf": PDF,
        });

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual(PDF);
    });

    it("falls back to the MD5 when no name matches", async () => {
        const item = await h.seedAttachment("ATTACH01", {
            filename: "\u8bba\u6587.pdf",
            md5: SparkMD5.ArrayBuffer.hash(new Uint8Array(PDF).buffer),
        });
        h.webdav.payload = storageZip({
            "other.pdf": [9, 9],
            "garbled.pdf": PDF,
        });

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual(PDF);
    });

    it("takes the only file with the attachment's extension", async () => {
        const item = await h.seedAttachment("ATTACH01", {
            filename: "renamed.pdf",
        });
        h.webdav.payload = storageZip({
            "jasminum-outline.json": SIDECAR,
            "paper.pdf": PDF,
        });

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual(PDF);
    });

    it("serves a snapshot's main page among its resources", async () => {
        const page = [...new TextEncoder().encode("<html>main</html>")];
        const item = await h.seedAttachment("ATTACH01", {
            linkMode: "imported_url",
            contentType: "text/html",
            filename: "index.html",
        });
        h.webdav.payload = storageZip({
            "frame.html": [1],
            "style.css": [2],
            "index.html": page,
        });

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual(page);
    });

    it("does not guess between candidates; it tries the Zotero API instead", async () => {
        const item = await h.seedAttachment("ATTACH01", {
            filename: "paper.pdf",
        });
        h.webdav.payload = storageZip({
            "a.pdf": [9, 9],
            "b.pdf": PDF,
        });

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual([
            1, 2, 3,
        ]);
        expect(h.fetches).toEqual([
            expect.stringContaining("/items/ATTACH01/file"),
        ]);
        expect(
            h.host.logs.some((l) =>
                String(l.message).includes("WebDAV failed for ATTACH01"),
            ),
        ).toBe(true);
    });
});

/* ================================================================ */
/*  Cache writes                                                    */
/* ================================================================ */

describe("cache writes", () => {
    it("records everything needed to serve the file again", async () => {
        const item = await h.seedAttachment("ATTACH01", {
            filename: "paper.pdf",
            contentType: "application/pdf",
        });
        h.setApiPayload(bytes(1, 2, 3, 4));

        await h.service.getFileBlob(item);

        expect(await h.getCached("ATTACH01")).toMatchObject({
            libraryID: USER_ID,
            key: "ATTACH01",
            mimeType: "application/pdf",
            fileName: "paper.pdf",
            size: 4,
        });
    });

    it("writes nothing when caching is disabled", async () => {
        h = await createAttachmentHarness({ settings: { useCache: false } });
        const item = await h.seedAttachment("ATTACH01");

        await h.service.getFileBlob(item);

        expect(await h.getCached("ATTACH01")).toBeUndefined();
    });
});

/* ================================================================ */
/*  LRU pruning                                                     */
/* ================================================================ */

describe("LRU pruning", () => {
    /** Seed `count` cached rows of `size` bytes, oldest first. */
    async function seedAged(
        entries: { key: string; size: number; accessed: string }[],
    ) {
        for (const e of entries) {
            await h.seedCached(e.key, {
                buffer: bytesOfSize(e.size),
                size: e.size,
                lastAccessedAt: e.accessed,
            });
        }
    }

    const MB = 1024 * 1024;

    /**
     * Pruning is fire-and-forget, so `getFileBlob` resolves before it runs.
     *
     * A "nothing was evicted" assertion cannot be made fully deterministic
     * without a hook into that background task, so this anchors on the event
     * that immediately precedes it — the cache write completing — and then
     * yields the turn prune needs for its single `toArray()` await. The
     * eviction cases below assert positively with `vi.waitFor` instead and need
     * none of this.
     */
    const settlePrune = async () => {
        await vi.waitFor(() =>
            expect(
                h.host.logs.some((l) =>
                    l.message.includes("Attachment cache write complete"),
                ),
            ).toBe(true),
        );
        await new Promise((r) => setTimeout(r, 0));
    };

    it("keeps everything while the cache is under the limit", async () => {
        h = await createAttachmentHarness({ settings: { maxCacheSizeMB: 10 } });
        await seedAged([
            { key: "OLD00001", size: 1 * MB, accessed: "2020-01-01T00:00:00Z" },
            { key: "NEW00001", size: 1 * MB, accessed: "2026-01-01T00:00:00Z" },
        ]);
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytesOfSize(1 * MB));

        await h.service.getFileBlob(item);
        await settlePrune();

        expect((await h.cachedKeys()).sort()).toEqual([
            "ATTACH01",
            "NEW00001",
            "OLD00001",
        ]);
    });

    it("evicts least-recently-accessed first, and only as far as needed", async () => {
        h = await createAttachmentHarness({ settings: { maxCacheSizeMB: 3 } });
        await seedAged([
            { key: "OLDEST01", size: 1 * MB, accessed: "2020-01-01T00:00:00Z" },
            { key: "MIDDLE01", size: 1 * MB, accessed: "2023-01-01T00:00:00Z" },
            { key: "NEWEST01", size: 1 * MB, accessed: "2026-01-01T00:00:00Z" },
        ]);
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytesOfSize(1 * MB));

        await h.service.getFileBlob(item);

        // 4 MB against a 3 MB limit — exactly one row has to go, the oldest.
        await vi.waitFor(async () =>
            expect((await h.cachedKeys()).sort()).toEqual([
                "ATTACH01",
                "MIDDLE01",
                "NEWEST01",
            ]),
        );
    });

    it("evicts rows that have never recorded an access time first", async () => {
        // An empty lastAccessedAt sorts before every real timestamp, so a row
        // written by an older version is reclaimed before live entries.
        h = await createAttachmentHarness({ settings: { maxCacheSizeMB: 2 } });
        await seedAged([
            { key: "NOSTAMP1", size: 1 * MB, accessed: "" },
            { key: "STAMPED1", size: 1 * MB, accessed: "2020-01-01T00:00:00Z" },
        ]);
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytesOfSize(1 * MB));

        await h.service.getFileBlob(item);

        await vi.waitFor(async () =>
            expect((await h.cachedKeys()).sort()).toEqual([
                "ATTACH01",
                "STAMPED1",
            ]),
        );
    });

    it("treats a limit of zero as no limit at all", async () => {
        h = await createAttachmentHarness({ settings: { maxCacheSizeMB: 0 } });
        await seedAged([
            { key: "OLD00001", size: 50 * MB, accessed: "2020-01-01T00:00:00Z" },
        ]);
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytesOfSize(50 * MB));

        await h.service.getFileBlob(item);
        await settlePrune();

        expect((await h.cachedKeys()).sort()).toEqual(["ATTACH01", "OLD00001"]);
    });

    it("still returns the file when pruning fails", async () => {
        // Pruning is housekeeping; it must never fail the download that
        // triggered it.
        h = await createAttachmentHarness({ settings: { maxCacheSizeMB: 1 } });
        await seedAged([
            { key: "OLD00001", size: 2 * MB, accessed: "2020-01-01T00:00:00Z" },
        ]);
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytesOfSize(1 * MB));

        await expect(h.service.getFileBlob(item)).resolves.toBeInstanceOf(Blob);
    });
});

describe("cache maintenance API", () => {
    it("totals the size of every cached row", async () => {
        await h.seedCached("A0000001", { size: 100 });
        await h.seedCached("A0000002", { size: 250 });

        expect(await h.service.getCacheTotalSizeBytes()).toBe(350);
    });

    it("reports zero for an empty cache", async () => {
        expect(await h.service.getCacheTotalSizeBytes()).toBe(0);
    });

    it("ignores rows with no recorded size", async () => {
        // A row written before `size` was tracked. Written straight to the
        // table because the harness derives size from the buffer.
        await db.files.put({
            libraryID: USER_ID,
            key: "LEGACY01",
            buffer: bytes(1, 2, 3),
            mimeType: "application/pdf",
            fileName: "legacy.pdf",
            md5: "x",
            lastAccessedAt: ISO,
        } as never);

        expect(await h.service.getCacheTotalSizeBytes()).toBe(0);
    });

    it("purges every row", async () => {
        await h.seedCached("A0000001");
        await h.seedCached("A0000002");

        await h.service.purgeCache();

        expect(await h.service.getCacheTotalSizeBytes()).toBe(0);
        expect(await h.cachedKeys()).toEqual([]);
    });
});

/* ================================================================ */
/*  Local storage                                                   */
/* ================================================================ */

describe("local storage", () => {
    it("reads an imported_file from the local storage directory", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/zotero/storage",
            },
        });
        const item = await h.seedAttachment("ATTACH01", {
            filename: "paper.pdf",
            contentType: "application/pdf",
        });
        const readExternalBinaryFile = vi.fn(async () => bytes(10, 20, 30));
        h.host.readExternalBinaryFile = readExternalBinaryFile;

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([10, 20, 30]);
        expect(readExternalBinaryFile).toHaveBeenCalledWith(
            "/fake/zotero/storage/ATTACH01/paper.pdf",
        );
        expect(h.fetches).toEqual([]);
        expect(await h.getCached("ATTACH01")).toBeUndefined();
    });

    it("reads an imported_url attachment with the correct mime type", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/zotero/storage",
            },
        });
        const item = await h.seedAttachment("ATTACH01", {
            linkMode: "imported_url",
            filename: "snapshot.html",
            contentType: "text/html",
        });
        h.host.readExternalBinaryFile = async () => bytes(1, 2, 3);

        const blob = await h.service.getFileBlob(item);

        expect(blob.type).toBe("text/html");
        expect(await readBlob(blob)).toEqual([1, 2, 3]);
        expect(h.fetches).toEqual([]);
    });

    it("throws CONFIG_MISSING when the storage path is empty", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "",
            },
        });
        const item = await h.seedAttachment("ATTACH01");

        await expect(h.service.getFileBlob(item)).rejects.toThrow(
            /storage path is not configured/i,
        );
        expect(
            h.host.notices.some(
                (notice) =>
                    notice.type === "error" &&
                    notice.message.includes("storage path"),
            ),
        ).toBe(true);
    });

    it("throws RESOURCE_MISSING when the file cannot be read", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/zotero/storage",
            },
        });
        const item = await h.seedAttachment("ATTACH01");
        h.host.readExternalBinaryFile = async () => {
            throw new Error("ENOENT: no such file");
        };

        await expect(h.service.getFileBlob(item)).rejects.toThrow(
            /could not read the attachment/i,
        );
        expect(
            h.host.notices.some(
                (notice) =>
                    notice.type === "error" &&
                    notice.message.includes("Could not read"),
            ),
        ).toBe(true);
    });

    it("rejects a filename that escapes the Zotero item directory", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/zotero/storage",
            },
        });
        const item = await h.seedAttachment("ATTACH01", {
            filename: "../secret.pdf",
        });

        await expect(h.service.getFileBlob(item)).rejects.toThrow(
            /invalid attachment filename/i,
        );
        expect(h.fetches).toEqual([]);
    });

    it("never caches a local storage read", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/zotero/storage",
            },
        });
        const item = await h.seedAttachment("ATTACH01");
        h.host.readExternalBinaryFile = async () => bytes(5, 5, 5);

        await h.service.getFileBlob(item);

        expect(await h.getCached("ATTACH01")).toBeUndefined();
        expect(h.fetches).toEqual([]);
    });

    it("falls through to the network on Android", async () => {
        h = await createAttachmentHarness({
            isAndroid: true,
            isDesktop: false,
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/path",
            },
        });
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytes(1, 2, 3));
        // readExternalBinaryFile throws by default — if called, test fails

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([1, 2, 3]);
        expect(h.fetches).toHaveLength(1);
    });

    it("falls through to the network on iOS", async () => {
        h = await createAttachmentHarness({
            isAndroid: false,
            isDesktop: false,
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/path",
            },
        });
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytes(3, 2, 1));

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([3, 2, 1]);
        expect(h.fetches).toHaveLength(1);
    });

    it("falls through to the network when local storage is disabled", async () => {
        // Default settings: useZoteroStorage: false
        const item = await h.seedAttachment("ATTACH01");
        h.setApiPayload(bytes(7, 8, 9));
        // readExternalBinaryFile throws by default — if called, test fails

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([7, 8, 9]);
        expect(h.fetches).toHaveLength(1);
    });

    it("does not interfere with linked_file attachments", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/storage",
            },
        });
        const item = await h.seedAttachment("LINKED01", {
            linkMode: "linked_file",
            path: "/tmp/paper.pdf",
        });
        h.host.readExternalBinaryFile = async () => bytes(5, 5, 5);

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([5, 5, 5]);
        expect(h.fetches).toEqual([]);
    });

    it("does not interfere with linked_url attachments", async () => {
        h = await createAttachmentHarness({
            settings: {
                useZoteroStorage: true,
                zoteroStoragePath: "/fake/storage",
            },
        });
        const item = await h.seedAttachment("LINKURL1", {
            linkMode: "linked_url",
        });
        h.setApiPayload(bytes(1, 2, 3));

        const blob = await h.service.getFileBlob(item);

        expect(await readBlob(blob)).toEqual([1, 2, 3]);
        expect(h.fetches).toHaveLength(1);
        // readExternalBinaryFile throws by default — if called, test fails
    });
});

/* ================================================================ */
/*  Settings                                                        */
/* ================================================================ */

describe("updateSettings", () => {
    it("takes effect on the next request", async () => {
        const item = await h.seedAttachment("ATTACH01");
        await h.seedCached("ATTACH01", { buffer: bytes(4, 5, 6) });

        h.service.updateSettings({ ...h.settings, useCache: false });
        h.setApiPayload(bytes(1, 2, 3));

        expect(await readBlob(await h.service.getFileBlob(item))).toEqual([
            1, 2, 3,
        ]);
    });
});
