/**
 * ItemNoteService — CRUD for Zotero child note items.
 *
 * This is the only place in the plugin that puts an item into a dirty sync
 * status, so every push, conflict and 412 the sync suites cover ultimately
 * originates here. The DB writes matter more than the conversion: a note left
 * in the wrong status either never reaches Zotero or overwrites the wrong
 * version of it.
 *
 * The real ConvertService and the real DB-backed link resolver run;
 * LibraryNoteService is faked, since re-rendering a source note is a separate
 * concern with its own file surface.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { ItemNoteService } from "worker/services/item-note";
import { ConvertService } from "worker/services/convert";
import { db, resetDb, seedItem, seedLibrary } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";
import { DEFAULT_SETTINGS } from "settings/types";

import type { FakeParentHost } from "../fakes/parent-host";
import type { LibraryNoteService, UpdateOptions } from "worker/services/library-note";
import type { ZotFlowSettings } from "settings/types";

const LIB = 1;
const GROUP = 777;

interface TriggerCall {
    libraryID: number;
    key: string;
    options: UpdateOptions;
    debounce: boolean;
}

let host: FakeParentHost;
let settings: ZotFlowSettings;
let service: ItemNoteService;
let triggerCalls: TriggerCall[];
let triggerResult: () => Promise<void>;

async function setup(over: Partial<ZotFlowSettings> = {}) {
    await resetDb();
    await seedLibrary({ id: LIB, type: "user", name: "My Library" });

    host = createFakeParentHost({ vaultConfig: { strictLineBreaks: false } });
    settings = { ...DEFAULT_SETTINGS, convertNoteLinks: true, ...over };
    triggerCalls = [];
    triggerResult = () => Promise.resolve();

    const sourceNotes = {
        triggerUpdate: (
            libraryID: number,
            key: string,
            options: UpdateOptions = {},
            debounce = false,
        ) => {
            triggerCalls.push({ libraryID, key, options, debounce });
            return triggerResult();
        },
    } as unknown as LibraryNoteService;

    service = new ItemNoteService(
        settings,
        host,
        new ConvertService(),
        sourceNotes,
    );
}

beforeEach(() => setup());

/** Seed a child note carrying `html` as its Zotero note body. */
async function seedNote(
    key: string,
    html: string,
    over: Record<string, unknown> = {},
) {
    await seedItem({
        libraryID: LIB,
        key,
        itemType: "note",
        parentItem: "PARENT01",
        raw: {
            key,
            version: 3,
            library: { type: "user", id: LIB, name: "My Library" },
            data: {
                key,
                version: 3,
                itemType: "note",
                parentItem: "PARENT01",
                note: html,
            },
        } as any,
        ...over,
    } as any);
}

describe("reading a note", () => {
    test("converts the stored HTML to markdown", async () => {
        await seedNote("NOTEKEY1", "<p>Hello <strong>world</strong></p>");

        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toContain(
            "Hello **world**",
        );
    });

    test("a missing item yields an empty string and a warning", async () => {
        expect(await service.getNoteAsMarkdown(LIB, "MISSING1")).toBe("");
        expect(
            host.logsAt("warn").some((l) => /not found or not a note/.test(l.message)),
        ).toBe(true);
    });

    test("an item that is not a note is refused", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1" });
        expect(await service.getNoteAsMarkdown(LIB, "ARTICLE1")).toBe("");
    });

    test("an empty or whitespace-only body short-circuits", async () => {
        await seedNote("NOTEKEY1", "   \n  ");
        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toBe("");
    });

    test("native zotero links become ZotFlow links when the setting is on", async () => {
        await seedNote(
            "NOTEKEY1",
            '<p><a href="zotero://select/library/items/ITEM0001">ref</a></p>',
        );

        const md = await service.getNoteAsMarkdown(LIB, "NOTEKEY1");
        expect(md).toContain("obsidian://zotflow?type=open-note");
        expect(md).toContain("libraryID=1");
        expect(md).toContain("key=ITEM0001");
    });

    test("with the setting off the zotero link is left alone", async () => {
        await setup({ convertNoteLinks: false });
        await seedNote(
            "NOTEKEY1",
            '<p><a href="zotero://select/library/items/ITEM0001">ref</a></p>',
        );

        const md = await service.getNoteAsMarkdown(LIB, "NOTEKEY1");
        expect(md).toContain("zotero://select/library/items/ITEM0001");
        expect(md).not.toContain("obsidian://zotflow");
    });

    test("group libraries resolve to their own libraryID", async () => {
        await seedLibrary({ id: GROUP, type: "group", name: "Group" });
        await seedItem({
            libraryID: GROUP,
            key: "NOTEKEY1",
            itemType: "note",
            raw: {
                key: "NOTEKEY1",
                library: { type: "group", id: GROUP, name: "Group" },
                data: {
                    key: "NOTEKEY1",
                    itemType: "note",
                    note: '<p><a href="zotero://select/groups/777/items/ITEM0001">ref</a></p>',
                },
            } as any,
        } as any);

        const md = await service.getNoteAsMarkdown(GROUP, "NOTEKEY1");
        expect(md).toContain("libraryID=777");
    });

    test("a raw payload with no note field is treated as empty", async () => {
        await seedItem({
            libraryID: LIB,
            key: "NOTEKEY1",
            itemType: "note",
            raw: { key: "NOTEKEY1", data: { key: "NOTEKEY1", itemType: "note" } } as any,
        } as any);

        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toBe("");
    });

    test("with no personal library on record the link cannot be resolved", async () => {
        // getPersonalLibraryID has nothing to return, so the conversion
        // declines rather than guessing a libraryID.
        await seedNote(
            "NOTEKEY1",
            '<p><a href="zotero://select/library/items/ITEM0001">ref</a></p>',
        );
        await db.libraries.clear();

        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toContain(
            "zotero://select/library/items/ITEM0001",
        );
    });

    test("annotation spans get display anchors", async () => {
        const payload = encodeURIComponent(
            JSON.stringify({
                attachmentURI: "http://zotero.org/users/1/items/ATTACH01",
                annotationKey: "ANNOTAT1",
            }),
        );
        await seedNote(
            "NOTEKEY1",
            `<p><span class="highlight" data-annotation="${payload}">quoted</span></p>`,
        );

        // linkCitationSpans is unconditional — the anchors are display-only
        // and stripped again on save.
        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toContain(
            "zotflow-span-link",
        );
    });
});

describe("creating a child note", () => {
    beforeEach(async () => {
        await seedItem({ libraryID: LIB, key: "PARENT01" });
    });

    test("persists a note the next sync will push", async () => {
        const key = await service.createChildNote(LIB, "PARENT01");

        const stored = (await db.items.get([LIB, key]))!;
        expect(stored.itemType).toBe("note");
        expect(stored.parentItem).toBe("PARENT01");
        expect(stored.syncStatus).toBe("created");
        // Version 0 tells push to omit it so the server assigns one.
        expect(stored.version).toBe(0);
        expect(stored.trashed).toBe(0);
        expect((stored.raw.data as any).note).toBe("");
    });

    test("the generated key uses Zotero's unambiguous alphabet", async () => {
        // 0, 1 and O are excluded so a key is never misread; I is kept.
        const ZOTERO_KEY = /^[23456789A-NP-Z]{8}$/;

        // Sampling once would only catch a wrong character class about one run
        // in five, which is a flake rather than a test.
        for (let i = 0; i < 50; i++) {
            expect(await service.createChildNote(LIB, "PARENT01")).toMatch(
                ZOTERO_KEY,
            );
        }
    });

    test("successive notes get distinct keys", async () => {
        const keys = new Set<string>();
        for (let i = 0; i < 20; i++) {
            keys.add(await service.createChildNote(LIB, "PARENT01"));
        }
        expect(keys.size).toBe(20);
        expect(await db.items.where({ libraryID: LIB, itemType: "note" }).count()).toBe(
            20,
        );
    });

    test("the library stub is inherited from the parent", async () => {
        const key = await service.createChildNote(LIB, "PARENT01");
        const stored = (await db.items.get([LIB, key]))!;
        expect(stored.raw.library).toEqual(
            (await db.items.get([LIB, "PARENT01"]))!.raw.library,
        );
    });

    test("the tree is told to refresh", async () => {
        const key = await service.createChildNote(LIB, "PARENT01");
        expect(host.events).toContainEqual({
            name: "noteChangedByNoteView",
            args: [LIB, key, "PARENT01"],
        });
    });

    test("a missing parent is a resource error", async () => {
        await expect(service.createChildNote(LIB, "MISSING1")).rejects.toThrow(
            /Parent item MISSING1 not found/,
        );
    });

    for (const itemType of ["attachment", "note", "annotation"] as const) {
        test(`Zotero forbids a child note under a ${itemType}`, async () => {
            await seedItem({ libraryID: LIB, key: "BADPAREN", itemType });
            await expect(
                service.createChildNote(LIB, "BADPAREN"),
            ).rejects.toThrow(new RegExp(`Cannot create a child note under a ${itemType}`));
            expect(await db.items.where({ libraryID: LIB, itemType: "note" }).count()).toBe(
                itemType === "note" ? 1 : 0,
            );
        });
    }
});

describe("updating note content", () => {
    test("stores the markdown back as HTML", async () => {
        await seedNote("NOTEKEY1", "<p>old</p>");

        await service.updateNoteContent(LIB, "NOTEKEY1", "new **content**");

        const stored = (await db.items.get([LIB, "NOTEKEY1"]))!;
        expect((stored.raw.data as any).note).toContain("<strong>content</strong>");
    });

    test("a synced note becomes updated so the next sync pushes it", async () => {
        await seedNote("NOTEKEY1", "<p>old</p>", { syncStatus: "synced" });

        await service.updateNoteContent(LIB, "NOTEKEY1", "edited");

        expect((await db.items.get([LIB, "NOTEKEY1"]))!.syncStatus).toBe(
            "updated",
        );
    });

    test("a note that has never been pushed stays `created`", async () => {
        // Downgrading to "updated" would make push send a version the server
        // has never seen.
        await seedNote("NOTEKEY1", "", { syncStatus: "created", version: 0 });

        await service.updateNoteContent(LIB, "NOTEKEY1", "first draft");

        expect((await db.items.get([LIB, "NOTEKEY1"]))!.syncStatus).toBe(
            "created",
        );
    });

    test("a conflicted note stays conflicted until the user resolves it", async () => {
        // Moving it to `updated` would push the edit over the server copy.
        await seedNote("NOTEKEY1", "<p>old</p>", { syncStatus: "conflict" });

        await service.updateNoteContent(LIB, "NOTEKEY1", "edited");

        expect((await db.items.get([LIB, "NOTEKEY1"]))!.syncStatus).toBe(
            "conflict",
        );
    });

    test("paragraphs end the title line, as they do after a sync", async () => {
        await seedNote("NOTEKEY1", "");

        await service.updateNoteContent(LIB, "NOTEKEY1", "First\n\nSecond");

        expect((await db.items.get([LIB, "NOTEKEY1"]))!.title).toBe("First");
    });

    test("dateModified is refreshed", async () => {
        await seedNote("NOTEKEY1", "<p>old</p>", {
            dateModified: "2020-01-01T00:00:00.000Z",
        });

        await service.updateNoteContent(LIB, "NOTEKEY1", "edited");

        const stored = (await db.items.get([LIB, "NOTEKEY1"]))!;
        expect(stored.dateModified).not.toBe("2020-01-01T00:00:00.000Z");
    });

    test("the title is derived from the first line of the body", async () => {
        await seedNote("NOTEKEY1", "");

        await service.updateNoteContent(
            LIB,
            "NOTEKEY1",
            "# A Heading\n\nsome body text",
        );

        expect((await db.items.get([LIB, "NOTEKEY1"]))!.title).toContain(
            "A Heading",
        );
    });

    test("the title is capped at 50 characters", async () => {
        await seedNote("NOTEKEY1", "");
        await service.updateNoteContent(LIB, "NOTEKEY1", "x".repeat(120));

        expect(
            (await db.items.get([LIB, "NOTEKEY1"]))!.title.length,
        ).toBeLessThanOrEqual(50);
    });

    test("an emptied note falls back to a key-based title", async () => {
        await seedNote("NOTEKEY1", "<p>had content</p>");
        await service.updateNoteContent(LIB, "NOTEKEY1", "");

        expect((await db.items.get([LIB, "NOTEKEY1"]))!.title).toBe(
            "Note NOTEKEY1",
        );
    });

    test("ZotFlow links are stored back in Zotero's native form", async () => {
        await seedItem({
            libraryID: LIB,
            key: "ITEM0001",
            itemType: "journalArticle",
        });
        await seedNote("NOTEKEY1", "");

        await service.updateNoteContent(
            LIB,
            "NOTEKEY1",
            "see [ref](obsidian://zotflow?type=open-note&libraryID=1&key=ITEM0001)",
        );

        const html = (await db.items.get([LIB, "NOTEKEY1"]))!.raw.data as any;
        expect(html.note).toContain("zotero://select/library/items/ITEM0001");
        expect(html.note).not.toContain("obsidian://zotflow");
    });

    test("an annotation link is stored as open-pdf against its attachment", async () => {
        // The zotflow form names only the annotation; Zotero's form needs the
        // attachment it lives on, which the resolver looks up in the DB.
        await seedItem({
            libraryID: LIB,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
        });
        await seedItem({
            libraryID: LIB,
            key: "ANNOTAT1",
            itemType: "annotation",
            parentItem: "ATTACH01",
        });
        await seedNote("NOTEKEY1", "");

        await service.updateNoteContent(
            LIB,
            "NOTEKEY1",
            "see [hl](obsidian://zotflow?type=open-annotation&libraryID=1&key=ANNOTAT1)",
        );

        expect(
            ((await db.items.get([LIB, "NOTEKEY1"]))!.raw.data as any).note,
        ).toContain(
            "zotero://open-pdf/library/items/ATTACH01?annotation=ANNOTAT1",
        );
    });

    test("an open-annotation link naming a non-annotation is refused", async () => {
        // The key resolves to a row, but not to an annotation. Following its
        // parentItem anyway would emit an open-pdf link against the wrong
        // file — worse than leaving the link unconverted.
        await seedItem({ libraryID: LIB, key: "PARENT01" });
        await seedItem({
            libraryID: LIB,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
        });
        await seedNote("NOTEKEY1", "");

        await service.updateNoteContent(
            LIB,
            "NOTEKEY1",
            "see [x](obsidian://zotflow?type=open-annotation&libraryID=1&key=ATTACH01)",
        );

        const stored = ((await db.items.get([LIB, "NOTEKEY1"]))!.raw.data as any)
            .note as string;
        expect(stored).toContain("obsidian://zotflow?type=open-annotation");
        expect(stored).not.toContain("zotero://open-pdf");
    });

    test("an annotation the DB does not know is left as a ZotFlow link", async () => {
        await seedNote("NOTEKEY1", "");

        await service.updateNoteContent(
            LIB,
            "NOTEKEY1",
            "see [hl](obsidian://zotflow?type=open-annotation&libraryID=1&key=GHOSTANN)",
        );

        // Better an un-migrated link than one pointing at the wrong file.
        expect(
            ((await db.items.get([LIB, "NOTEKEY1"]))!.raw.data as any).note,
        ).toContain("obsidian://zotflow?type=open-annotation");
    });

    test("with the setting off ZotFlow links are stored verbatim", async () => {
        await setup({ convertNoteLinks: false });
        await seedNote("NOTEKEY1", "");

        await service.updateNoteContent(
            LIB,
            "NOTEKEY1",
            "see [ref](obsidian://zotflow?type=open-note&libraryID=1&key=ITEM0001)",
        );

        expect(
            ((await db.items.get([LIB, "NOTEKEY1"]))!.raw.data as any).note,
        ).toContain("obsidian://zotflow");
    });

    test("a missing note is reported gone, with a warning, and nothing is written", async () => {
        // Deleted in Zotero and removed by a sync while the user typed: the
        // caller keeps the text and offers to save it as a new note.
        const result = await service.updateNoteContent(LIB, "MISSING1", "content", "editor", "PARENT01");

        expect(result).toEqual({ status: "gone", parentKey: "PARENT01", parentExists: false });
        expect(await db.items.count()).toBe(0);
        expect(host.logsAt("warn").some((l) => /is gone/.test(l.message))).toBe(true);
    });

    test("a gone note whose parent (the source note's item) still exists is saved back under it", async () => {
        await seedItem({ libraryID: LIB, key: "PARENT01" });

        const result = await service.updateNoteContent(LIB, "MISSING1", "kept text", "editor", "PARENT01");
        expect(result).toEqual({ status: "gone", parentKey: "PARENT01", parentExists: true });

        // What the prompt does with that answer.
        const key = await service.saveAsNewNote(LIB, result.status === "gone" && result.parentExists ? result.parentKey : "", "kept text");
        expect((await db.items.get([LIB, key]))!.parentItem).toBe("PARENT01");
    });

    test("a gone note whose parent is gone too is saved standalone", async () => {
        const result = await service.updateNoteContent(LIB, "MISSING1", "kept text", "editor", "PARENT01");
        expect(result).toEqual({ status: "gone", parentKey: "PARENT01", parentExists: false });

        const key = await service.saveAsNewNote(LIB, result.status === "gone" && result.parentExists ? result.parentKey : "", "kept text");
        const row = (await db.items.get([LIB, key]))!;
        expect(row.parentItem).toBe("");
        expect(row.syncStatus).toBe("created");
    });

    test("saveAsNewNote itself falls back to standalone if the parent vanished meanwhile", async () => {
        const key = await service.saveAsNewNote(LIB, "GONE0001", "kept text");
        expect((await db.items.get([LIB, key]))!.parentItem).toBe("");
    });

    test("the text of a gone note can be saved as a new note under its parent", async () => {
        await seedItem({ libraryID: LIB, key: "PARENT01" });

        const key = await service.saveAsNewNote(LIB, "PARENT01", "kept text");

        const row = (await db.items.get([LIB, key]))!;
        expect(row).toMatchObject({ itemType: "note", parentItem: "PARENT01", syncStatus: "created" });
        expect((row.raw.data as any).note).toContain("kept text");
        // The parent's source note is re-rendered at once: an editor open on
        // it then edits the new note, not the gone one.
        expect(triggerCalls).toContainEqual({
            libraryID: LIB,
            key: "PARENT01",
            options: { forceUpdateContent: true, forceUpdateImages: false },
            debounce: false,
        });
    });

    test("with its parent gone too, the text becomes a standalone note", async () => {
        const key = await service.saveAsNewNote(LIB, "PARENT01", "kept text");

        expect((await db.items.get([LIB, key]))!.parentItem).toBe("");
    });

    test("text that converts to the stored note is not written again", async () => {
        // A flush of what is already saved (or an edit typed and undone)
        // must not mark the note for upload.
        await seedNote("NOTEKEY1", "<p>old</p>");
        await service.updateNoteContent(LIB, "NOTEKEY1", "same text");
        const once = (await db.items.get([LIB, "NOTEKEY1"]))!;

        const result = await service.updateNoteContent(LIB, "NOTEKEY1", "same text");

        expect(result).toEqual({ status: "saved" });
        const twice = (await db.items.get([LIB, "NOTEKEY1"]))!;
        expect(twice.localRevision).toBe(once.localRevision);
        expect(twice.dateModified).toBe(once.dateModified);
    });

    test("a non-note item is never rewritten", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1", title: "Untouched" });

        await service.updateNoteContent(LIB, "ARTICLE1", "content");

        const stored = (await db.items.get([LIB, "ARTICLE1"]))!;
        expect(stored.title).toBe("Untouched");
        expect(stored.syncStatus).toBe("synced");
    });
});

describe("update notifications and source-note refresh", () => {
    beforeEach(async () => {
        await seedNote("NOTEKEY1", "<p>old</p>");
    });

    test("an edit from the note view re-renders the parent source note", async () => {
        await service.updateNoteContent(LIB, "NOTEKEY1", "edited", "note-view");

        expect(host.events).toContainEqual({
            name: "noteChangedByNoteView",
            args: [LIB, "NOTEKEY1", "PARENT01"],
        });
        expect(triggerCalls).toEqual([
            {
                libraryID: LIB,
                key: "PARENT01",
                options: { forceUpdateContent: true, forceUpdateImages: false },
                debounce: true,
            },
        ]);
    });

    test("an edit from the source note itself must not re-render it", async () => {
        // The edit came from the editable region inside the source note;
        // re-rendering would overwrite what the user just typed.
        await service.updateNoteContent(LIB, "NOTEKEY1", "edited", "editor");

        expect(host.events).toContainEqual({
            name: "noteChangedByEditor",
            args: [LIB, "NOTEKEY1", "PARENT01"],
        });
        // The tree patches the one node instead of rebuilding.
        expect(host.events).toContainEqual({
            name: "treeChanged",
            args: [{ libraryID: LIB, keys: ["NOTEKEY1"] }],
        });
        expect(triggerCalls).toEqual([]);
    });

    test("note-view is the default origin", async () => {
        await service.updateNoteContent(LIB, "NOTEKEY1", "edited");
        expect(triggerCalls).toHaveLength(1);
    });

    test("a parentless note triggers no refresh", async () => {
        await seedNote("ORPHAN01", "<p>x</p>", { parentItem: "" });

        await service.updateNoteContent(LIB, "ORPHAN01", "edited", "note-view");

        expect(triggerCalls).toEqual([]);
    });

    test("a failed refresh is logged, not thrown", async () => {
        // The note itself is already saved at this point; losing the re-render
        // must not turn into a rejected save.
        triggerResult = () => Promise.reject(new Error("render exploded"));

        // The refresh is fire-and-forget, so its rejection handler runs after
        // updateNoteContent has already resolved. Wait on the log line itself
        // rather than polling a deadline — the assertion then depends on the
        // event happening, not on how fast the machine is.
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the fake's log is a closure, not a method using `this`
        const original = host.log;
        const logged = new Promise<void>((resolve) => {
            host.log = (level, message, context, details) => {
                original(level, message, context, details);
                if (
                    level === "error" &&
                    /Failed to trigger source note update/.test(message)
                ) {
                    resolve();
                }
            };
        });

        await expect(
            service.updateNoteContent(LIB, "NOTEKEY1", "edited", "note-view"),
        ).resolves.toEqual({ status: "saved" });
        await logged;

        expect((await db.items.get([LIB, "NOTEKEY1"]))!.title).toBe("edited");
    });
});

describe("deleting a note", () => {
    test("a note that was never pushed is removed outright", async () => {
        await seedNote("NOTEKEY1", "<p>draft</p>", { syncStatus: "created" });

        await service.deleteNote(LIB, "NOTEKEY1");

        // Zotero never saw it, so there is nothing to tombstone.
        expect(await db.items.get([LIB, "NOTEKEY1"])).toBeUndefined();
        expect(
            host.logsAt("info").some((l) => /Deleted note NOTEKEY1 \(hard\)/.test(l.message)),
        ).toBe(true);
    });

    test("a synced note is trashed so the deletion can be pushed", async () => {
        await seedNote("NOTEKEY1", "<p>real</p>", { syncStatus: "synced" });

        await service.deleteNote(LIB, "NOTEKEY1");

        const stored = (await db.items.get([LIB, "NOTEKEY1"]))!;
        expect(stored.trashed).toBe(1);
        expect(stored.syncStatus).toBe("updated");
        expect((stored.raw.data as any).deleted).toBe(true);
        expect(
            host.logsAt("info").some((l) => /Deleted note NOTEKEY1 \(soft\)/.test(l.message)),
        ).toBe(true);
    });

    test("trashing a note stamps dateModified", async () => {
        await seedNote("NOTEKEY1", "<p>real</p>", {
            dateModified: "2020-01-01T00:00:00Z",
        });

        await service.deleteNote(LIB, "NOTEKEY1");

        expect((await db.items.get([LIB, "NOTEKEY1"]))!.dateModified).not.toBe(
            "2020-01-01T00:00:00Z",
        );
    });

    test("trashing a conflicted note keeps the conflict", async () => {
        await seedNote("NOTEKEY1", "<p>real</p>", { syncStatus: "conflict" });

        await service.deleteNote(LIB, "NOTEKEY1");

        const stored = (await db.items.get([LIB, "NOTEKEY1"]))!;
        expect(stored.trashed).toBe(1);
        expect(stored.syncStatus).toBe("conflict");
    });

    test("a missing item is a silent no-op", async () => {
        await expect(
            service.deleteNote(LIB, "MISSING1"),
        ).resolves.toBeUndefined();
        expect(host.logsAt("info")).toHaveLength(0);
    });

    test("a non-note item is never touched", async () => {
        await seedItem({ libraryID: LIB, key: "ARTICLE1" });

        await service.deleteNote(LIB, "ARTICLE1");

        expect((await db.items.get([LIB, "ARTICLE1"]))!.trashed).toBe(0);
    });
});

describe("round trip", () => {
    test("markdown survives a save and reload", async () => {
        await seedNote("NOTEKEY1", "");
        const source = [
            "# Heading",
            "",
            "Body with **bold**, *italic* and `code`.",
            "",
            "- one",
            "- two",
        ].join("\n");

        await service.updateNoteContent(LIB, "NOTEKEY1", source);
        const reloaded = await service.getNoteAsMarkdown(LIB, "NOTEKEY1");

        await service.updateNoteContent(LIB, "NOTEKEY1", reloaded);
        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toBe(reloaded);
    });

    test("a zotero link survives a save and reload as a ZotFlow link", async () => {
        await seedItem({ libraryID: LIB, key: "ITEM0001" });
        await seedNote(
            "NOTEKEY1",
            '<p><a href="zotero://select/library/items/ITEM0001">ref</a></p>',
        );

        const first = await service.getNoteAsMarkdown(LIB, "NOTEKEY1");
        await service.updateNoteContent(LIB, "NOTEKEY1", first);

        // Stored natively, displayed as ZotFlow — stable across the cycle.
        expect(
            ((await db.items.get([LIB, "NOTEKEY1"]))!.raw.data as any).note,
        ).toContain("zotero://select/library/items/ITEM0001");
        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toBe(first);
    });
});

describe("settings updates", () => {
    test("updateSettings changes link handling for later calls", async () => {
        await seedNote(
            "NOTEKEY1",
            '<p><a href="zotero://select/library/items/ITEM0001">ref</a></p>',
        );
        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toContain(
            "obsidian://zotflow",
        );

        service.updateSettings({ ...settings, convertNoteLinks: false });

        expect(await service.getNoteAsMarkdown(LIB, "NOTEKEY1")).toContain(
            "zotero://select",
        );
    });
});
