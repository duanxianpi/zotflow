/**
 * `AnnotationService` + `db/annotation.ts` — the cloud half of the annotation
 * round trip.
 *
 * This is the one failure a user cannot undo: a lost or mangled annotation is
 * gone. `AnnotationService` was at 0% and `db/annotation.ts` at 60% with no
 * suite of its own, while the reader bridge tests mock
 * `workerBridge.annotation.getAnnotations` — so the contract was asserted from
 * the caller's side and the implementation was not exercised at all.
 *
 * Both directions of the conversion are tested together, because that is where
 * the risk is: `annotationItemFromJSON` writes flat `annotation*` columns and
 * `getAnnotationJson` reads them back into reader JSON, and a field either side
 * forgets is silently dropped rather than reported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    API_KEY,
    createAnnotationHarness,
    db,
    GROUP_ID,
    makeAnnotationJson,
    USER_ID,
} from "../fakes/annotation-harness";

import type { AnnotationHarness } from "../fakes/annotation-harness";

let h: AnnotationHarness;

beforeEach(async () => {
    h = await createAnnotationHarness();
});

/* ================================================================ */
/*  The round trip                                                  */
/* ================================================================ */

describe("round trip: reader JSON -> IDB -> reader JSON", () => {
    it("preserves every field the reader sent", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        const sent = makeAnnotationJson("ANNO0001", {
            type: "highlight",
            text: "the quoted sentence",
            comment: "my note",
            color: "#a28ae5",
            pageLabel: "42",
            sortIndex: "00042|000123|00045",
            position: { pageIndex: 41, rects: [[1, 2, 3, 4]] },
            tags: [{ name: "method" }, { name: "alpha" }],
        });

        await h.service.saveAnnotations(attachment, h.keyInfo, [sent]);
        const [back] = await h.service.getAnnotations(attachment, API_KEY);

        expect(back).toMatchObject({
            id: "ANNO0001",
            type: "highlight",
            text: "the quoted sentence",
            comment: "my note",
            color: "#a28ae5",
            pageLabel: "42",
            sortIndex: "00042|000123|00045",
            position: { pageIndex: 41, rects: [[1, 2, 3, 4]] },
        });
        // Tags come back sorted by name, and as `{name}` not `{tag}`.
        expect(back!.tags).toEqual([{ name: "alpha" }, { name: "method" }]);
    });

    it("stamps libraryID and parentItem, which the reader strips in transit", async () => {
        // `IframeReaderBridge` restores these from the attachment when building
        // a drag payload; this is the side that puts them there in the first place.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001"),
        ]);

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back).toMatchObject({
            libraryID: USER_ID,
            parentItem: "ATTACH01",
        });
    });

    it("does not store text for a type that has none", async () => {
        // The write path (`annotationItemFromJSON`) only copies `text` for
        // highlight/underline. A note's body is its comment, and storing the
        // reader's stray `text` would resurface as phantom quoted content in the
        // source note. Asserted through saveAnnotations, because the read-side
        // mirror of this branch is covered separately and would mask it.
        const attachment = await h.seedAttachment("ATTACH01");

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("NOTE0001", {
                type: "note",
                text: "should not be stored",
                comment: "the actual body",
            }),
        ]);

        const row = await h.getRow("NOTE0001");
        expect(row!.raw.data.annotationText).toBeUndefined();
        expect(row!.raw.data.annotationComment).toBe("the actual body");
    });

    it("survives an edit made through the reader", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { comment: "first" }),
        ]);

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { comment: "second" }),
        ]);

        const back = await h.service.getAnnotations(attachment, API_KEY);
        expect(back).toHaveLength(1);
        expect(back[0]!.comment).toBe("second");
    });

    it("survives a delete-then-recreate of the same key", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001"),
        ]);
        await h.service.deleteAnnotations(attachment, ["ANNO0001"]);
        expect(await h.service.getAnnotations(attachment, API_KEY)).toEqual([]);

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { comment: "back again" }),
        ]);
        const back = await h.service.getAnnotations(attachment, API_KEY);
        expect(back).toHaveLength(1);
        expect(back[0]!.comment).toBe("back again");
    });
});

/* ================================================================ */
/*  Field mapping (db/annotation.ts)                                */
/* ================================================================ */

describe("annotationItemFromJSON: field mapping", () => {
    it("defaults a missing author name to an empty string", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001"),
        ]);

        // Not `undefined`: the field is sent to the Zotero API as-is.
        expect((await h.getRow("ANNO0001"))!.raw.data.annotationAuthorName).toBe(
            "",
        );
    });

    it("keeps an author name the reader supplied", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { authorName: "Ada Lovelace" }),
        ]);

        expect((await h.getRow("ANNO0001"))!.raw.data.annotationAuthorName).toBe(
            "Ada Lovelace",
        );
    });

    it.each(["highlight", "underline"] as const)(
        "carries the quoted text of a %s",
        async (type) => {
            const attachment = await h.seedAttachment("ATTACH01");
            await h.service.saveAnnotations(attachment, h.keyInfo, [
                makeAnnotationJson("ANNO0001", { type, text: "quoted words" }),
            ]);

            expect((await h.getRow("ANNO0001"))!.raw.data.annotationText).toBe(
                "quoted words",
            );
        },
    );

    it("carries the external flag", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { isExternal: true }),
        ]);

        expect(
            (await h.getRow("ANNO0001"))!.raw.data.annotationIsExternal,
        ).toBe(true);
    });

    it("stores a missing position as an empty object", async () => {
        // The type says `position` is required, but the PDF extractor builds
        // these from untyped parse output, so the copy is what actually keeps
        // `JSON.stringify(undefined)` from writing `undefined` to the field.
        const attachment = await h.seedAttachment("ATTACH01");
        const json = makeAnnotationJson("ANNO0001");
        delete (json as unknown as Record<string, unknown>).position;

        await h.service.saveAnnotations(attachment, h.keyInfo, [json]);

        expect(
            (await h.getRow("ANNO0001"))!.raw.data.annotationPosition,
        ).toBe("{}");
    });
});

/* ================================================================ */
/*  Reading (db/annotation.ts)                                      */
/* ================================================================ */

describe("getAnnotations", () => {
    it("returns nothing for an item that is not an attachment", async () => {
        // The annotation has to exist, or the query would return [] anyway and
        // the type guard would be untested.
        const notAnAttachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01");
        (notAnAttachment as any).itemType = "journalArticle";

        expect(await h.service.getAnnotations(notAnAttachment, API_KEY)).toEqual(
            [],
        );
    });

    it("reports a missing external flag as false, not undefined", async () => {
        // `annotationIsExternal` is ZotFlow's own field — sync strips it before
        // pushing — so a row that came down from Zotero does not have it at
        // all. The seeder always writes it, so remove it to get the real shape.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01");
        const row = (await h.getRow("ANNO0001"))!;
        delete (row.raw.data as { annotationIsExternal?: boolean })
            .annotationIsExternal;
        await db.items.put(row);

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        // The reader reads this field, so it has to be a boolean either way.
        expect(back!.isExternal).toBe(false);
    });

    it("reports dateCreated as the date added, not the date modified", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            dateAdded: "2020-01-01T00:00:00.000Z",
            dateModified: "2024-12-31T00:00:00.000Z",
        });

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back!.dateCreated).toBe("2020-01-01T00:00:00.000Z");
        expect(back!.dateAdded).toBe("2020-01-01T00:00:00.000Z");
        expect(back!.dateModified).toBe("2024-12-31T00:00:00.000Z");
    });

    it("does not show a deleted annotation awaiting its upload", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("KEEPME01", "ATTACH01");
        await h.seedAnnotation("GONE0001", "ATTACH01");
        await h.service.deleteAnnotations(attachment, ["GONE0001"]);

        const back = await h.service.getAnnotations(attachment, API_KEY);
        expect(back.map((a) => a.id)).toEqual(["KEEPME01"]);
    });

    it("orders by sortIndex, not by key", async () => {
        // The keys are deliberately in the OPPOSITE alphabetical order to their
        // sortIndex. Dexie returns rows in primary-key order, so a test whose
        // keys already sort correctly would pass with the comparator removed.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("AAAALATE", "ATTACH01", {
            sortIndex: "00010|000000|00000",
        });
        await h.seedAnnotation("ZZZZEARL", "ATTACH01", {
            sortIndex: "00002|000000|00000",
        });

        const back = await h.service.getAnnotations(attachment, API_KEY);
        expect(back.map((a) => a.id)).toEqual(["ZZZZEARL", "AAAALATE"]);
    });

    it("parses the stored position back into an object", async () => {
        // Stored as a JSON string; the reader needs the structure.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            position: { pageIndex: 3, rects: [[10, 20, 30, 40]] },
        });

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back!.position).toEqual({
            pageIndex: 3,
            rects: [[10, 20, 30, 40]],
        });
    });

    it.each([
        ["highlight", true],
        ["underline", true],
        ["note", false],
        ["image", false],
        ["ink", false],
    ] as const)(
        "%s annotations carry text: %s",
        async (type, shouldHaveText) => {
            // Only text-bearing types get `text`; a note's body is its comment.
            const attachment = await h.seedAttachment("ATTACH01");
            await h.seedAnnotation("ANNO0001", "ATTACH01", {
                type,
                text: "some text",
            });

            const [back] = await h.service.getAnnotations(attachment, API_KEY);
            expect(back!.text === "some text").toBe(shouldHaveText);
        },
    );

    it("sorts tags by name and drops the internal position field", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            tags: [{ tag: "zebra" }, { tag: "Apple" }, { tag: "mango" }],
        });

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back!.tags).toEqual([
            { name: "Apple" },
            { name: "mango" },
            { name: "zebra" },
        ]);
        expect(back!.tags.every((t) => !("position" in t))).toBe(true);
    });

    it("marks an external annotation read-only", async () => {
        // Owned by the embedded PDF, not by Zotero — the reader must not offer
        // to edit it, because re-extraction would overwrite the edit.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", { isExternal: true });

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back).toMatchObject({ isExternal: true, readOnly: true });
    });

    it("leaves an own annotation editable", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01");

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back).toMatchObject({ isExternal: false, readOnly: false });
    });

    it("marks another user's annotation read-only", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            createdByUser: { id: 999, name: "Someone Else" },
        });

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back!.readOnly).toBe(true);
    });

    it("keeps an explicit author name", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            authorName: "Ada Lovelace",
        });

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back!.authorName).toBe("Ada Lovelace");
    });

    it("derives an authoritative author name in a group library", async () => {
        h = await createAnnotationHarness({ withGroup: true });
        const attachment = await h.seedAttachment("ATTACH01", {
            libraryID: GROUP_ID,
            libraryType: "group",
        });
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            libraryID: GROUP_ID,
            createdByUser: { id: 42, username: "grace", name: "Grace Hopper" },
        });

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back).toMatchObject({
            authorName: "grace",
            isAuthorNameAuthoritative: true,
        });
    });

    it("does not derive an author name in a personal library", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            createdByUser: { id: 42, username: "grace" },
        });

        const [back] = await h.service.getAnnotations(attachment, API_KEY);
        expect(back!.isAuthorNameAuthoritative).toBeUndefined();
    });

    it("ignores annotations belonging to a different attachment", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAttachment("ATTACH02");
        await h.seedAnnotation("MINE0001", "ATTACH01");
        await h.seedAnnotation("THEIRS01", "ATTACH02");

        const back = await h.service.getAnnotations(attachment, API_KEY);
        expect(back.map((a) => a.id)).toEqual(["MINE0001"]);
    });
});

describe("getKeyInfo", () => {
    it("resolves the stored key record", async () => {
        // The reader view needs this to decide the author name for group items.
        expect(await h.service.getKeyInfo(API_KEY)).toMatchObject({
            key: API_KEY,
            userID: USER_ID,
            username: "test-user",
        });
    });

    it("returns undefined for an unknown key", async () => {
        expect(await h.service.getKeyInfo("NOPE")).toBeUndefined();
    });
});

describe("getAllItemAnnotations", () => {
    it("collects across every attachment of one parent item", async () => {
        await h.seedAttachment("ATTACH01", { parentItem: "PAPER001" });
        await h.seedAttachment("ATTACH02", { parentItem: "PAPER001" });
        await h.seedAttachment("OTHER001", { parentItem: "PAPER999" });
        await h.seedAnnotation("A0000001", "ATTACH01");
        await h.seedAnnotation("A0000002", "ATTACH02");
        await h.seedAnnotation("A0000003", "OTHER001");

        const back = await h.service.getAllItemAnnotations(
            USER_ID,
            "PAPER001",
            API_KEY,
        );
        expect(back.map((a) => a.id).sort()).toEqual(["A0000001", "A0000002"]);
    });

    it("returns nothing for a parent with no attachments", async () => {
        expect(
            await h.service.getAllItemAnnotations(USER_ID, "PAPER404", API_KEY),
        ).toEqual([]);
    });
});

/* ================================================================ */
/*  saveAnnotations — creating                                      */
/* ================================================================ */

describe("saveAnnotations: create", () => {
    it("writes a new annotation as locally created and pending push", async () => {
        const attachment = await h.seedAttachment("ATTACH01");

        const result = await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001"),
        ]);

        expect(result).toEqual({ hasChanges: true });
        const row = await h.getRow("ANNO0001");
        expect(row).toMatchObject({
            itemType: "annotation",
            parentItem: "ATTACH01",
            // "created" is what makes sync push it; version 0 marks it as
            // never having existed on the server.
            syncStatus: "created",
            version: 0,
        });
    });

    it("marks an external annotation as ignored rather than pending", async () => {
        // External annotations live in the PDF. Pushing them to Zotero would
        // duplicate them on every re-extraction.
        const attachment = await h.seedAttachment("ATTACH01");

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("EXTERN01", { isExternal: true }),
        ]);

        expect((await h.getRow("EXTERN01"))?.syncStatus).toBe("ignore");
    });

    it("records the creating user in a group library", async () => {
        h = await createAnnotationHarness({ withGroup: true });
        const attachment = await h.seedAttachment("ATTACH01", {
            libraryID: GROUP_ID,
            libraryType: "group",
        });

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001"),
        ]);

        const row = await h.getRow("ANNO0001", GROUP_ID);
        expect(row!.raw.meta.createdByUser).toMatchObject({
            id: USER_ID,
            username: "test-user",
            name: "Test User",
        });
    });

    it("does not record a creating user in a personal library", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001"),
        ]);

        expect((await h.getRow("ANNO0001"))!.raw.meta.createdByUser).toBeUndefined();
    });

    it("writes several annotations in one batch", async () => {
        const attachment = await h.seedAttachment("ATTACH01");

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("A0000001"),
            makeAnnotationJson("A0000002"),
            makeAnnotationJson("A0000003"),
        ]);

        expect((await h.rowsFor("ATTACH01")).map((r) => r.key).sort()).toEqual([
            "A0000001",
            "A0000002",
            "A0000003",
        ]);
    });

    it.each(["image", "ink"] as const)(
        "persists the rendered image for a %s annotation",
        async (type) => {
            const attachment = await h.seedAttachment("ATTACH01");

            await h.service.saveAnnotations(attachment, h.keyInfo, [
                makeAnnotationJson("VISUAL01", {
                    type,
                    image: "data:image/png;base64,AAAA",
                }),
            ]);

            expect(h.noteService.savedImages).toEqual([
                { image: "data:image/png;base64,AAAA", annotationKey: "VISUAL01" },
            ]);
        },
    );

    it("does not persist an image for a highlight", async () => {
        const attachment = await h.seedAttachment("ATTACH01");

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { image: "data:x" }),
        ]);

        expect(h.noteService.savedImages).toEqual([]);
    });

    it("logs and notifies when the image write fails, without failing the save", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        h.noteService.failSaveImage = true;

        const result = await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("VISUAL01", { type: "image", image: "x" }),
        ]);

        // The annotation itself must still be recorded.
        expect(result.hasChanges).toBe(true);
        expect(await h.getRow("VISUAL01")).toBeDefined();
        await vi.waitFor(() => {
            expect(
                h.host.logsAt("error").some((l) =>
                    l.message.includes("Failed to save annotation image"),
                ),
            ).toBe(true);
        });
        expect(
            h.host.notices.some((n) => n.type === "error"),
        ).toBe(true);
    });
});

/* ================================================================ */
/*  saveAnnotations — updating                                      */
/* ================================================================ */

describe("saveAnnotations: update", () => {
    it("writes nothing when nothing changed", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            comment: "same",
            tags: [{ tag: "one" }],
        });

        const result = await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", {
                comment: "same",
                tags: [{ name: "one" }],
            }),
        ]);

        expect(result).toEqual({ hasChanges: false });
        // Still "synced" — a no-op edit must not queue a pointless push.
        expect((await h.getRow("ANNO0001"))!.syncStatus).toBe("synced");
        expect(h.noteService.triggerUpdateCalls).toEqual([]);
    });

    it.each([
        ["comment", { comment: "changed" }],
        ["color", { color: "#ff6666" }],
        ["pageLabel", { pageLabel: "99" }],
        ["sortIndex", { sortIndex: "00099|000000|00000" }],
        ["text", { text: "different text" }],
        ["type", { type: "underline" as const }],
        ["position", { position: { pageIndex: 9, rects: [] } }],
    ])("detects a changed %s", async (_field, patch) => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01");

        const result = await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", patch),
        ]);

        expect(result).toEqual({ hasChanges: true });
        expect((await h.getRow("ANNO0001"))!.syncStatus).toBe("updated");
    });

    it("keeps the searchTags index in step with changed tags", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            tags: [{ tag: "one" }],
        });

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", {
                tags: [{ name: "one" }, { name: "two" }],
            }),
        ]);

        expect((await h.getRow("ANNO0001"))!.searchTags).toEqual(["one", "two"]);
    });

    it("leaves a conflicted annotation conflicted", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", { syncStatus: "conflict" });

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { comment: "changed" }),
        ]);

        expect((await h.getRow("ANNO0001"))!.syncStatus).toBe("conflict");
    });

    it("treats a reordered tag list as unchanged", async () => {
        // The signature is order-independent on purpose: the reader hands tags
        // back in its own order, and a spurious "updated" would push a no-op
        // write to Zotero on every open.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            tags: [{ tag: "alpha" }, { tag: "beta" }],
        });

        const result = await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", {
                tags: [{ name: "beta" }, { name: "alpha" }],
            }),
        ]);

        expect(result).toEqual({ hasChanges: false });
    });

    it("detects an added tag", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            tags: [{ tag: "alpha" }],
        });

        const result = await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", {
                tags: [{ name: "alpha" }, { name: "beta" }],
            }),
        ]);

        expect(result).toEqual({ hasChanges: true });
    });

    it("detects a removed tag", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            tags: [{ tag: "alpha" }, { tag: "beta" }],
        });

        const result = await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { tags: [{ name: "alpha" }] }),
        ]);

        expect(result).toEqual({ hasChanges: true });
    });

    it("keeps a never-pushed annotation marked created, not updated", async () => {
        // Downgrading "created" to "updated" would make sync PATCH an item the
        // server has never seen.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            syncStatus: "created",
        });

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { comment: "edited" }),
        ]);

        expect((await h.getRow("ANNO0001"))!.syncStatus).toBe("created");
    });

    it("refuses to update an external annotation", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            comment: "from the pdf",
            isExternal: true,
        });

        const result = await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", {
                comment: "my edit",
                isExternal: true,
            }),
        ]);

        expect(result).toEqual({ hasChanges: false });
        expect((await h.getRow("ANNO0001"))!.raw.data.annotationComment).toBe(
            "from the pdf",
        );
    });

    it("saving an annotation deleted but not yet uploaded takes the delete back", async () => {
        // The reader can hand back an annotation it still showed. Zotero has
        // the item; the pending DELETE is dropped and the save becomes an
        // edit of it, not a create that Zotero would refuse.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01");
        await h.service.deleteAnnotations(attachment, ["ANNO0001"]);

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001", { comment: "re-added" }),
        ]);

        const row = await h.getRow("ANNO0001");
        expect(row!.syncStatus).toBe("updated");
        expect(row!.version).toBe(1);
        expect(row!.raw.data.annotationComment).toBe("re-added");
        expect(await db.syncDeleteLog.count()).toBe(0);
    });
});

/* ================================================================ */
/*  saveAnnotations — note update side effect                       */
/* ================================================================ */

describe("saveAnnotations: source-note update", () => {
    it("asks for a note update against the parent item", async () => {
        const attachment = await h.seedAttachment("ATTACH01", {
            parentItem: "PAPER001",
        });

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001"),
        ]);

        expect(h.noteService.triggerUpdateCalls).toEqual([
            {
                libraryID: USER_ID,
                key: "PAPER001",
                options: { forceUpdateContent: true, forceUpdateImages: false },
                debounce: true,
            },
        ]);
    });

    it("falls back to the attachment key for a standalone attachment", async () => {
        const attachment = await h.seedAttachment("ATTACH01", {
            parentItem: "",
        });

        await h.service.saveAnnotations(attachment, h.keyInfo, [
            makeAnnotationJson("ANNO0001"),
        ]);

        expect(h.noteService.triggerUpdateCalls[0]!.key).toBe("ATTACH01");
    });

    it("logs and notifies when the note update rejects", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        h.noteService.failTriggerUpdate = true;

        // Fire-and-forget: the save itself must still resolve.
        await expect(
            h.service.saveAnnotations(attachment, h.keyInfo, [
                makeAnnotationJson("ANNO0001"),
            ]),
        ).resolves.toEqual({ hasChanges: true });

        await vi.waitFor(() => {
            expect(
                h.host.logsAt("error").some((l) =>
                    l.message.includes(
                        "Failed to trigger note update after annotation save",
                    ),
                ),
            ).toBe(true);
        });
    });
});

/* ================================================================ */
/*  deleteAnnotations                                               */
/* ================================================================ */

describe("deleteAnnotations", () => {
    it("does nothing for an empty id list", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.service.deleteAnnotations(attachment, []);

        expect(h.noteService.triggerUpdateCalls).toEqual([]);
        expect(h.host.logs).toEqual([]);
    });

    it("hard-deletes an annotation the server has never seen", async () => {
        // Nothing to tell Zotero about, so no tombstone is needed.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("LOCAL001", "ATTACH01", {
            syncStatus: "created",
        });

        await h.service.deleteAnnotations(attachment, ["LOCAL001"]);

        expect(await h.getRow("LOCAL001")).toBeUndefined();
    });

    it("removes a synced annotation and queues its DELETE", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("SYNCED01", "ATTACH01", {
            syncStatus: "synced",
        });

        await h.service.deleteAnnotations(attachment, ["SYNCED01"]);

        expect(await h.getRow("SYNCED01")).toBeUndefined();
        expect(await db.syncDeleteLog.get([USER_ID, "SYNCED01"])).toMatchObject({ version: 1 });
    });

    it("handles a mixed batch in one pass", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("LOCAL001", "ATTACH01", {
            syncStatus: "created",
        });
        await h.seedAnnotation("SYNCED01", "ATTACH01", {
            syncStatus: "synced",
        });

        await h.service.deleteAnnotations(attachment, ["LOCAL001", "SYNCED01"]);

        expect(await h.getRow("LOCAL001")).toBeUndefined();
        expect(await h.getRow("SYNCED01")).toBeUndefined();
        expect((await db.syncDeleteLog.toArray()).map((l) => l.key)).toEqual(["SYNCED01"]);
    });

    it.each(["image", "ink"] as const)(
        "removes the rendered image for a %s annotation",
        async (type) => {
            const attachment = await h.seedAttachment("ATTACH01");
            await h.seedAnnotation("VISUAL01", "ATTACH01", { type });

            await h.service.deleteAnnotations(attachment, ["VISUAL01"]);

            expect(h.noteService.deletedImages).toContain("VISUAL01");
        },
    );

    it("does not chase an image for a highlight that exists in the DB", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", { type: "highlight" });

        await h.service.deleteAnnotations(attachment, ["ANNO0001"]);

        expect(h.noteService.deletedImages).toEqual([]);
    });

    it("still removes the image of an id that is no longer in the DB", async () => {
        // The row may already be gone while its rendered PNG is not — without
        // this the file would be orphaned in the vault forever.
        const attachment = await h.seedAttachment("ATTACH01");

        await h.service.deleteAnnotations(attachment, ["MISSING1"]);

        expect(h.noteService.deletedImages).toEqual(["MISSING1"]);
    });

    it("ignores an image-delete failure", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("VISUAL01", "ATTACH01", { type: "image" });
        h.noteService.failDeleteImage = true;

        await expect(
            h.service.deleteAnnotations(attachment, ["VISUAL01"]),
        ).resolves.toBeUndefined();

        await vi.waitFor(() => {
            expect(
                h.host.logsAt("error").some((l) =>
                    l.message.includes("Failed to delete annotation image"),
                ),
            ).toBe(true);
        });
    });

    it("asks for a note update even when no row matched", async () => {
        // The note may still contain a stale block for the annotation.
        const attachment = await h.seedAttachment("ATTACH01", {
            parentItem: "PAPER001",
        });

        await h.service.deleteAnnotations(attachment, ["MISSING1"]);

        expect(h.noteService.triggerUpdateCalls).toEqual([
            {
                libraryID: USER_ID,
                key: "PAPER001",
                options: { forceUpdateContent: true },
                debounce: true,
            },
        ]);
    });

    it("falls back to the attachment key for a standalone attachment", async () => {
        const attachment = await h.seedAttachment("ATTACH01", {
            parentItem: "",
        });
        await h.seedAnnotation("ANNO0001", "ATTACH01");

        await h.service.deleteAnnotations(attachment, ["ANNO0001"]);

        expect(h.noteService.triggerUpdateCalls[0]!.key).toBe("ATTACH01");
    });

    it("logs and notifies when the note update rejects", async () => {
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01");
        h.noteService.failTriggerUpdate = true;

        await expect(
            h.service.deleteAnnotations(attachment, ["ANNO0001"]),
        ).resolves.toBeUndefined();

        await vi.waitFor(() => {
            expect(
                h.host.logsAt("error").some((l) =>
                    l.message.includes(
                        "Failed to trigger note update after annotation delete",
                    ),
                ),
            ).toBe(true);
        });
    });

    it("deletes by key alone, not scoped to the attachment passed in", async () => {
        // The lookup is `[libraryID+key] anyOf ids` — the `attachmentItem`
        // argument is used only for its libraryID and for the note-update
        // target, never to scope the match. Harmless in practice because Zotero
        // annotation keys are unique per library, but it means an id belonging
        // to a different attachment WOULD be deleted. Pinned so the scoping is
        // a decision rather than an accident.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAttachment("ATTACH02");
        await h.seedAnnotation("OTHER001", "ATTACH02", {
            syncStatus: "created",
        });

        await h.service.deleteAnnotations(attachment, ["OTHER001"]);

        expect(await h.getRow("OTHER001")).toBeUndefined();
    });
});

/* ================================================================ */
/*  updateAnnotationComment                                         */
/* ================================================================ */

describe("updateAnnotationComment", () => {
    it("converts markdown to Zotero's restricted HTML subset", async () => {
        await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", { comment: "" });

        await h.service.updateAnnotationComment(
            USER_ID,
            "ANNO0001",
            "**bold** and *italic*",
        );

        const stored = (await h.getRow("ANNO0001"))!.raw.data.annotationComment;
        expect(stored).toContain("<b>bold</b>");
        expect(stored).toContain("<i>italic</i>");
    });

    it("marks the annotation for push", async () => {
        await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01");

        await h.service.updateAnnotationComment(USER_ID, "ANNO0001", "edited");

        expect((await h.getRow("ANNO0001"))!.syncStatus).toBe("updated");
    });

    it("keeps a never-pushed annotation marked created", async () => {
        await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            syncStatus: "created",
        });

        await h.service.updateAnnotationComment(USER_ID, "ANNO0001", "edited");

        expect((await h.getRow("ANNO0001"))!.syncStatus).toBe("created");
    });

    it("ignores an annotation already deleted in the reader", async () => {
        // Its region can linger in a source note until the next re-render;
        // editing it must not resurrect it.
        const attachment = await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", { comment: "old" });
        await h.service.deleteAnnotations(attachment, ["ANNO0001"]);

        await h.service.updateAnnotationComment(USER_ID, "ANNO0001", "edited");

        expect(await h.getRow("ANNO0001")).toBeUndefined();
        expect((await db.syncDeleteLog.get([USER_ID, "ANNO0001"]))!.snapshot.raw.data).toMatchObject({ annotationComment: "old" });
        expect(h.host.events).toEqual([]);
    });

    it("tells the main thread the annotation changed", async () => {
        await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01");

        await h.service.updateAnnotationComment(USER_ID, "ANNO0001", "edited");

        expect(
            h.host.events.filter((e) => e.name === "annotationChanged"),
        ).toEqual([
            { name: "annotationChanged", args: [USER_ID, "ANNO0001", "ATTACH01"] },
        ]);
    });

    it("writes nothing when the converted comment is identical", async () => {
        await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            comment: "<b>bold</b>",
            syncStatus: "synced",
        });

        await h.service.updateAnnotationComment(USER_ID, "ANNO0001", "**bold**");

        // No spurious push, and no event.
        expect((await h.getRow("ANNO0001"))!.syncStatus).toBe("synced");
        expect(h.host.events).toEqual([]);
    });

    it("refuses to touch an external annotation", async () => {
        await h.seedAttachment("ATTACH01");
        await h.seedAnnotation("ANNO0001", "ATTACH01", {
            comment: "from the pdf",
            isExternal: true,
        });

        await h.service.updateAnnotationComment(USER_ID, "ANNO0001", "my edit");

        expect((await h.getRow("ANNO0001"))!.raw.data.annotationComment).toBe(
            "from the pdf",
        );
        expect(h.host.events).toEqual([]);
    });

    it("warns and stops when the key does not exist", async () => {
        await h.service.updateAnnotationComment(USER_ID, "NOSUCH01", "x");

        expect(
            h.host.logsAt("warn").some((l) => l.message.includes("not found")),
        ).toBe(true);
    });

    it("warns and stops when the key is not an annotation", async () => {
        await h.seedAttachment("ATTACH01");

        await h.service.updateAnnotationComment(USER_ID, "ATTACH01", "x");

        expect(
            h.host
                .logsAt("warn")
                .some((l) => l.message.includes("not an annotation")),
        ).toBe(true);
    });
});
