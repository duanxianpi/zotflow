/**
 * LibraryNoteService — creates and refreshes the source-note files in the vault.
 *
 * This is the last hop before user data is overwritten, so the tests are about
 * what it refuses to do: overwrite a file it could not read, overwrite one
 * whose persist markers do not parse, delete a file that is not the note it
 * thinks it is, or clobber a note that is already up to date.
 *
 * LibraryTemplateService is faked — its rendering has its own suite, and a
 * controllable return value is what makes the splice assertions legible.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { LibraryNoteService } from "worker/services/library-note";
import { NotePathService } from "worker/services/note-path";
import { DbHelperService } from "worker/services/db-helper";
import { LibraryService } from "worker/services/library";
import { SearchService } from "worker/services/search";
import { DEFAULT_SETTINGS } from "settings/types";
import { db, resetDb, seedItem, seedLibrary } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";

import type { FakeParentHost } from "../fakes/parent-host";
import type { LibraryTemplateService } from "worker/services/library-template";
import type { AttachmentService } from "worker/services/attachment";
import type { DocumentWorkerService } from "worker/services/document-worker";
import type { ZotFlowSettings } from "settings/types";
import type { AnyIDBZoteroItem } from "types/db-schema";

const LIB = 1;
const DEBOUNCE_DELAY = 2000;

let host: FakeParentHost;
let settings: ZotFlowSettings;
let service: LibraryNoteService;
/** What the faked template service returns for the next render. */
let rendered: string;
let renderCalls: { key: string; frontmatter: Record<string, unknown> }[];
let renderedImages: { libraryID: number; count: number }[];
/** Callbacks fired on each render, so tests can await the event itself. */
let renderWaiters: (() => void)[];

/**
 * Resolve once `count` renders have happened.
 *
 * Debounced work resumes on a timer but finishes through the DB, whose
 * microtasks `advanceTimersByTime` does not wait for. Waiting on the render
 * itself keeps these tests independent of how many turns that takes.
 */
function awaitRenders(count: number): Promise<void> {
    const start = renderCalls.length;
    if (renderCalls.length - start >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const check = () => {
            if (renderCalls.length - start >= count) resolve();
            else renderWaiters.push(check);
        };
        renderWaiters.push(check);
    });
}

async function setup(over: Partial<ZotFlowSettings> = {}) {
    await resetDb();
    await seedLibrary({ id: LIB, type: "user", name: "My Library" });

    host = createFakeParentHost();
    settings = {
        ...DEFAULT_SETTINGS,
        zoteroapikey: "TESTKEY",
        librariesConfig: { [LIB]: { mode: "bidirectional" } },
        librarySourceNotePathTemplate: "Source/@{{key}}",
        annotationImageFolder: "ZotFlow/images",
        ...over,
    };

    rendered =
        "---\nzotero-key: PARENT01\nitem-version: 7\n---\nrendered body\n";
    renderCalls = [];
    renderedImages = [];

    renderWaiters = [];
    const templateService = {
        renderLibrarySourceNote: (
            item: AnyIDBZoteroItem,
            _template: string | null,
            frontmatter: Record<string, unknown>,
        ) => {
            renderCalls.push({ key: item.key, frontmatter });
            renderWaiters.splice(0).forEach((notify) => notify());
            return Promise.resolve(rendered);
        },
        updateSettings: () => undefined,
    } as unknown as LibraryTemplateService;

    const attachmentService = {
        getFileBlob: () => Promise.resolve(new Blob(["pdf"])),
    } as unknown as AttachmentService;

    const documentWorker = {
        renderAnnotations: (
            libraryID: number,
            _buf: ArrayBuffer,
            annos: unknown[],
        ) => {
            renderedImages.push({ libraryID, count: annos.length });
            return Promise.resolve();
        },
    } as unknown as DocumentWorkerService;

    const library = new LibraryService(settings, host);
    const dbHelper = new DbHelperService(
        settings,
        host,
        library,
        new SearchService(),
    );

    service = new LibraryNoteService(
        settings,
        templateService,
        host,
        attachmentService,
        documentWorker,
        new NotePathService(settings, dbHelper),
    );
}

beforeEach(() => setup());
afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function seedArticle(key = "PARENT01", version = 7) {
    await seedItem({
        libraryID: LIB,
        key,
        itemType: "journalArticle",
        title: "A Study",
        version,
        raw: {
            key,
            version,
            library: { type: "user", id: LIB, name: "My Library" },
            meta: {},
            data: { key, version, itemType: "journalArticle", relations: {} },
        } as any,
    } as any);
}

/** Put a note file in the fake vault with the frontmatter checkFile reports. */
function placeNote(
    path: string,
    content: string,
    frontmatter: Record<string, unknown>,
) {
    host.vault.set(path, content);
    host.frontmatter.set(path, frontmatter);
}

describe("creating a note", () => {
    test("writes the rendered content and indexes the file", async () => {
        await seedArticle();

        const path = await service.ensureNote(LIB, "PARENT01", {});

        expect(path).toBe("Source/@PARENT01.md");
        expect(host.vault.get(path)).toBe(rendered);
        expect(host.indexed).toContain(path);
    });

    test("an unrelated file at the target path is stepped around", async () => {
        // Never overwrite something the user wrote that is not a source note.
        await seedArticle();
        host.vault.set("Source/@PARENT01.md", "someone else's note");

        await service.ensureNote(LIB, "PARENT01", {});

        expect(host.vault.get("Source/@PARENT01.md")).toBe(
            "someone else's note",
        );
        expect(host.vault.get("Source/@PARENT01 (1).md")).toBe(rendered);
        expect(host.indexed).toEqual(["Source/@PARENT01 (1).md"]);
    });

    test("collisions keep counting up", async () => {
        await seedArticle();
        host.vault.set("Source/@PARENT01.md", "x");
        host.vault.set("Source/@PARENT01 (1).md", "y");
        host.vault.set("Source/@PARENT01 (2).md", "z");

        await service.ensureNote(LIB, "PARENT01", {});

        expect(host.vault.get("Source/@PARENT01 (3).md")).toBe(rendered);
    });

    test("the returned path is the one the note was written to", async () => {
        // Two items rendering to the same path is ordinary — two untitled or
        // identically-titled items with no citation key do, under the default
        // template. Returning the requested path instead of the resolved one
        // makes openNote open the file that caused the collision.
        await seedArticle();
        host.vault.set("Source/@PARENT01.md", "someone else's note");

        const returned = await service.ensureNote(LIB, "PARENT01", {});

        expect(returned).toBe("Source/@PARENT01 (1).md");
        expect(host.vault.get(returned)).toBe(rendered);
    });

    test("openNote opens the note it just created, not the collision", async () => {
        await seedArticle();
        host.vault.set("Source/@PARENT01.md", "someone else's note");

        await service.openNote(LIB, "PARENT01");

        expect(host.opened).toEqual(["Source/@PARENT01 (1).md"]);
    });

    test("a hundred collisions is treated as a problem, not a hundredth suffix", async () => {
        await seedArticle();
        host.vault.set("Source/@PARENT01.md", "x");
        for (let i = 1; i < 101; i++) {
            host.vault.set(`Source/@PARENT01 (${i}).md`, "x");
        }

        await expect(service.ensureNote(LIB, "PARENT01", {})).rejects.toThrow(
            /unique filename/,
        );
    });

    test("a missing item or library is refused", async () => {
        await expect(service.ensureNote(LIB, "MISSING1", {})).rejects.toThrow(
            /Item or Library not found/,
        );

        await seedArticle();
        await db.libraries.clear();
        await expect(service.ensureNote(LIB, "PARENT01", {})).rejects.toThrow(
            /Item or Library not found/,
        );
    });

    test("the indexed path is preferred over the template", async () => {
        // The user may have moved the note; the index knows where it went.
        await seedArticle();
        placeNote("Moved/Elsewhere.md", "old", { "zotero-key": "PARENT01" });
        host.keyIndex.set("PARENT01", "Moved/Elsewhere.md");

        const path = await service.ensureNote(LIB, "PARENT01", {
            forceUpdateContent: true,
        });

        expect(path).toBe("Moved/Elsewhere.md");
        expect(host.vault.get("Moved/Elsewhere.md")).toBe(rendered);
    });
});

describe("updating an existing note", () => {
    beforeEach(async () => {
        await seedArticle("PARENT01", 7);
    });

    test("a note already at the item's version is left alone", async () => {
        placeNote("Source/@PARENT01.md", "existing body", {
            "zotero-key": "PARENT01",
            "item-version": 7,
        });

        await service.ensureNote(LIB, "PARENT01", {});

        expect(host.vault.get("Source/@PARENT01.md")).toBe("existing body");
        expect(renderCalls).toHaveLength(0);
    });

    test("an out-of-date note is re-rendered", async () => {
        placeNote("Source/@PARENT01.md", "stale body", {
            "zotero-key": "PARENT01",
            "item-version": 3,
        });

        await service.ensureNote(LIB, "PARENT01", {});

        expect(host.vault.get("Source/@PARENT01.md")).toBe(rendered);
    });

    test("forceUpdateContent re-renders even at the same version", async () => {
        // Annotation and child-note edits do not bump the item version, so the
        // version check alone would skip exactly the updates that matter.
        placeNote("Source/@PARENT01.md", "existing body", {
            "zotero-key": "PARENT01",
            "item-version": 7,
        });

        await service.ensureNote(LIB, "PARENT01", {
            forceUpdateContent: true,
        });

        expect(host.vault.get("Source/@PARENT01.md")).toBe(rendered);
    });

    test("the existing frontmatter is handed to the renderer to merge", async () => {
        placeNote("Source/@PARENT01.md", "body", {
            "zotero-key": "PARENT01",
            "item-version": 3,
            rating: "5 stars",
        });

        await service.ensureNote(LIB, "PARENT01", {});

        expect(renderCalls[0]!.frontmatter).toMatchObject({
            rating: "5 stars",
        });
    });

    test("a file whose frontmatter names another item is not updated in place", async () => {
        placeNote("Source/@PARENT01.md", "someone else's note", {
            "zotero-key": "OTHERKEY",
        });

        await service.ensureNote(LIB, "PARENT01", {});

        expect(host.vault.get("Source/@PARENT01.md")).toBe(
            "someone else's note",
        );
        expect(host.vault.get("Source/@PARENT01 (1).md")).toBe(rendered);
    });
});

describe("persist regions", () => {
    const BEG = "<!-- ZF_PERSIST_BEG_summary -->";
    const END = "<!-- ZF_PERSIST_END_summary -->";

    beforeEach(async () => {
        await seedArticle("PARENT01", 7);
    });

    test("user content is carried across a re-render", async () => {
        placeNote(
            "Source/@PARENT01.md",
            `---\n---\nold\n${BEG}\nmy own notes\n${END}\n`,
            { "zotero-key": "PARENT01", "item-version": 3 },
        );
        rendered = `---\n---\nfresh\n${BEG}\n\n${END}\n`;

        await service.ensureNote(LIB, "PARENT01", {});

        const out = host.vault.get("Source/@PARENT01.md")!;
        expect(out).toContain("fresh");
        expect(out).toContain(`${BEG}\nmy own notes\n${END}`);
    });

    test("a region the template dropped is preserved and reported", async () => {
        placeNote(
            "Source/@PARENT01.md",
            `---\n---\n${BEG}\nsalvage me\n${END}\n`,
            { "zotero-key": "PARENT01", "item-version": 3 },
        );
        rendered = "---\n---\nfresh with no regions\n";

        await service.ensureNote(LIB, "PARENT01", {});

        const out = host.vault.get("Source/@PARENT01.md")!;
        expect(out).toContain("salvage me");
        expect(
            host
                .logsAt("warn")
                .some((l) =>
                    /orphaned in Source\/@PARENT01\.md/.test(l.message),
                ),
        ).toBe(true);
    });

    test("orphan notices are batched into one summary", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await seedArticle("SECOND01", 7);
        for (const key of ["PARENT01", "SECOND01"]) {
            placeNote(
                `Source/@${key}.md`,
                `---\n---\n<!-- ZF_PERSIST_BEG_x -->\nkeep\n<!-- ZF_PERSIST_END_x -->\n`,
                { "zotero-key": key, "item-version": 3 },
            );
        }
        rendered = "---\n---\nno regions\n";

        await service.ensureNote(LIB, "PARENT01", {});
        await service.ensureNote(LIB, "SECOND01", {});

        expect(host.notices).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY);

        // A template change hitting hundreds of notes must not produce
        // hundreds of Notices.
        expect(host.notices).toEqual([
            {
                type: "warning",
                message:
                    "2 note(s) have orphaned persist regions — content was preserved at the bottom of each note (see log)",
            },
        ]);
    });

    test("markers that do not parse refuse the update rather than lose content", async () => {
        placeNote(
            "Source/@PARENT01.md",
            `---\n---\n${BEG}\nunclosed region\n`,
            { "zotero-key": "PARENT01", "item-version": 3 },
        );

        await expect(service.ensureNote(LIB, "PARENT01", {})).rejects.toThrow(
            /Invalid persist markers/,
        );
        expect(host.vault.get("Source/@PARENT01.md")).toContain(
            "unclosed region",
        );
    });

    test("a file that cannot be read is never overwritten blindly", async () => {
        // checkFile says it exists but the read comes back empty — writing the
        // render anyway would silently destroy whatever is there.
        placeNote("Source/@PARENT01.md", "precious content", {
            "zotero-key": "PARENT01",
            "item-version": 3,
        });
        host.readTextFile = () => Promise.resolve(null);

        await expect(service.ensureNote(LIB, "PARENT01", {})).rejects.toThrow(
            /refused to overwrite blindly/,
        );
    });
});

describe("ensureNotePath", () => {
    beforeEach(async () => {
        await seedArticle();
    });

    test("an indexed note is returned without touching the vault", async () => {
        host.keyIndex.set("PARENT01", "Source/@PARENT01.md");

        expect(await service.ensureNotePath(LIB, "PARENT01")).toBe(
            "Source/@PARENT01.md",
        );
        expect(host.vault.size).toBe(0);
    });

    test("a stub is written so a citation can link somewhere immediately", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const path = await service.ensureNotePath(LIB, "PARENT01");

        expect(path).toBe("Source/@PARENT01.md");
        const stub = host.vault.get(path)!;
        expect(stub).toContain("zotflow-locked: true");
        expect(stub).toContain('zotero-key: "PARENT01"');
        expect(stub).toContain("item-version: 0");
        expect(host.indexed).toContain(path);
    });

    test("the full render is scheduled in the background", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        await service.ensureNotePath(LIB, "PARENT01");
        expect(renderCalls).toHaveLength(0);

        const rendered = awaitRenders(1);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY);
        await rendered;
        expect(renderCalls).toHaveLength(1);
    });

    test("an existing note of ours is returned as-is", async () => {
        placeNote("Source/@PARENT01.md", "already here", {
            "zotero-key": "PARENT01",
        });

        expect(await service.ensureNotePath(LIB, "PARENT01")).toBe(
            "Source/@PARENT01.md",
        );
        expect(host.vault.get("Source/@PARENT01.md")).toBe("already here");
    });

    test("an unrelated file at the path pushes the stub aside", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        host.vault.set("Source/@PARENT01.md", "not ours");

        expect(await service.ensureNotePath(LIB, "PARENT01")).toBe(
            "Source/@PARENT01 (1).md",
        );
        expect(host.vault.get("Source/@PARENT01.md")).toBe("not ours");
    });

    test("an unknown item is refused", async () => {
        await expect(service.ensureNotePath(LIB, "MISSING1")).rejects.toThrow(
            /Item not found/,
        );
    });
});

describe("triggerUpdate", () => {
    beforeEach(async () => {
        await seedArticle();
    });

    test("immediate mode surfaces failures to the caller", async () => {
        await expect(
            service.triggerUpdate(LIB, "MISSING1", {}, false),
        ).rejects.toThrow(/Item or Library not found/);
    });

    test("debounced mode swallows failures — it is a background refresh", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const logged = new Promise<void>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/unbound-method -- the fake's methods are closures
            const original = host.log;
            host.log = (level, message, context, details) => {
                original(level, message, context, details);
                if (/Debounced update failed/.test(message)) resolve();
            };
        });

        await service.triggerUpdate(LIB, "MISSING1", {}, true);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY);
        await logged;
    });

    test("repeated requests for one note collapse into a single render", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        await service.triggerUpdate(LIB, "PARENT01", {}, true);
        await service.triggerUpdate(LIB, "PARENT01", {}, true);
        await service.triggerUpdate(LIB, "PARENT01", {}, true);

        // Each request must cancel the pending one. Counting timers rather
        // than renders keeps this deterministic: "only one render happened" is
        // a negative claim that needs a settle window, while "only one timer
        // is pending" is observable the moment the calls return.
        expect(vi.getTimerCount()).toBe(1);

        const rendered = awaitRenders(1);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY);
        await rendered;

        expect(renderCalls).toHaveLength(1);
    });

    test("different notes debounce independently", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await seedArticle("SECOND01");

        await service.triggerUpdate(LIB, "PARENT01", {}, true);
        await service.triggerUpdate(LIB, "SECOND01", {}, true);

        const rendered = awaitRenders(2);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY);
        await rendered;

        expect(renderCalls.map((c) => c.key).sort()).toEqual([
            "PARENT01",
            "SECOND01",
        ]);
    });

    test("dispose cancels work that has not fired yet", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        await service.triggerUpdate(LIB, "PARENT01", {}, true);
        service.dispose();
        await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY);

        expect(renderCalls).toHaveLength(0);
    });
});

describe("batch creation", () => {
    test("one failure does not stop the batch", async () => {
        await seedArticle("GOODITEM");
        const items = [
            { libraryID: LIB, key: "GOODITEM" },
            { libraryID: LIB, key: "MISSING1" },
        ] as AnyIDBZoteroItem[];

        await service.batchCreateNotes(items);

        expect(host.vault.has("Source/@GOODITEM.md")).toBe(true);
        expect(host.notices).toContainEqual({
            type: "info",
            message: "Batch finished: 1 success, 1 failed.",
        });
    });

    test("a clean batch reports success", async () => {
        await seedArticle("GOODITEM");

        await service.batchCreateNotes([
            { libraryID: LIB, key: "GOODITEM" },
        ] as AnyIDBZoteroItem[]);

        expect(host.notices).toContainEqual({
            type: "info",
            message: "Batch creation finished successfully.",
        });
    });
});

describe("purging notes for trashed items", () => {
    async function seedTrashed(key: string) {
        await seedItem({
            libraryID: LIB,
            key,
            itemType: "journalArticle",
            trashed: 1,
        });
    }

    test("removes the note of a trashed item", async () => {
        await seedTrashed("TRASHED1");
        placeNote("Source/@TRASHED1.md", "body", { "zotero-key": "TRASHED1" });
        host.keyIndex.set("TRASHED1", "Source/@TRASHED1.md");

        expect(await service.purgeTrashedSourceNotes([LIB])).toBe(1);
        expect(host.vault.has("Source/@TRASHED1.md")).toBe(false);
        expect(host.notices).toContainEqual({
            type: "info",
            message: "Removed 1 source note(s) for trashed items.",
        });
    });

    test("a file whose frontmatter names another item is never deleted", async () => {
        // The index can go stale; the frontmatter is the authority.
        await seedTrashed("TRASHED1");
        placeNote("Source/@TRASHED1.md", "someone else's", {
            "zotero-key": "OTHERKEY",
        });
        host.keyIndex.set("TRASHED1", "Source/@TRASHED1.md");

        expect(await service.purgeTrashedSourceNotes([LIB])).toBe(0);
        expect(host.vault.has("Source/@TRASHED1.md")).toBe(true);
    });

    test("an item with no note on disk is skipped quietly", async () => {
        await seedTrashed("TRASHED1");

        expect(await service.purgeTrashedSourceNotes([LIB])).toBe(0);
        expect(host.notices).toHaveLength(0);
    });

    test("untrashed items and child items are left alone", async () => {
        await seedItem({ libraryID: LIB, key: "ALIVE001" });
        await seedItem({
            libraryID: LIB,
            key: "CHILDNTE",
            itemType: "note",
            parentItem: "ALIVE001",
            trashed: 1,
        });
        placeNote("Source/@ALIVE001.md", "body", { "zotero-key": "ALIVE001" });
        host.keyIndex.set("ALIVE001", "Source/@ALIVE001.md");

        expect(await service.purgeTrashedSourceNotes([LIB])).toBe(0);
        expect(host.vault.has("Source/@ALIVE001.md")).toBe(true);
    });

    test("one failure does not abort the rest of the purge", async () => {
        await seedTrashed("TRASHED1");
        await seedTrashed("TRASHED2");
        placeNote("Source/@TRASHED1.md", "a", { "zotero-key": "TRASHED1" });
        placeNote("Source/@TRASHED2.md", "b", { "zotero-key": "TRASHED2" });
        host.keyIndex.set("TRASHED1", "Source/@TRASHED1.md");
        host.keyIndex.set("TRASHED2", "Source/@TRASHED2.md");
        host.deleteFile = (path: string) => {
            if (path.includes("TRASHED1")) {
                return Promise.reject(new Error("locked"));
            }
            host.vault.delete(path);
            return Promise.resolve();
        };

        expect(await service.purgeTrashedSourceNotes([LIB])).toBe(1);
        expect(
            host.logsAt("warn").some((l) => /Failed to purge/.test(l.message)),
        ).toBe(true);
    });

    test("no libraries means no work", async () => {
        expect(await service.purgeTrashedSourceNotes([])).toBe(0);
    });
});

describe("opening a note", () => {
    test("creates if needed, then opens in a new leaf", async () => {
        await seedArticle();

        await service.openNote(LIB, "PARENT01");

        expect(host.opened).toEqual(["Source/@PARENT01.md"]);
    });

    test("a failure to prepare the note is reported as an open failure", async () => {
        await expect(service.openNote(LIB, "MISSING1")).rejects.toThrow(
            /Item or Library not found/,
        );
        expect(host.opened).toEqual([]);
    });
});

describe("annotation images", () => {
    test("a base64 payload is decoded and written as png", async () => {
        // "hi" base64-encoded.
        await service.saveBase64Image("data:image/png;base64,aGk=", "ANNOTAT1");

        const written = host.binaryVault.get("ZotFlow/images/ANNOTAT1.png")!;
        expect(new TextDecoder().decode(written)).toBe("hi");
    });

    test("a malformed payload is reported, not written", async () => {
        await expect(
            service.saveBase64Image("not-a-data-url", "ANNOTAT1"),
        ).rejects.toThrow(/Failed to save image/);
    });

    test("a trailing slash on the folder setting does not double up", async () => {
        await setup({ annotationImageFolder: "ZotFlow/images/" });

        await service.saveBase64Image("data:image/png;base64,aGk=", "ANNOTAT1");

        expect(host.binaryVault.has("ZotFlow/images/ANNOTAT1.png")).toBe(true);
    });

    test("deleting removes an existing image", async () => {
        host.vault.set("ZotFlow/images/ANNOTAT1.png", "bytes");

        await service.deleteAnnotationImage("ANNOTAT1");

        expect(host.vault.has("ZotFlow/images/ANNOTAT1.png")).toBe(false);
    });

    test("deleting an image that is not there is a no-op", async () => {
        await expect(
            service.deleteAnnotationImage("NOSUCHAN"),
        ).resolves.toBeUndefined();
    });

    test("a delete failure is surfaced", async () => {
        host.vault.set("ZotFlow/images/ANNOTAT1.png", "bytes");
        host.deleteFile = () => Promise.reject(new Error("locked"));

        await expect(service.deleteAnnotationImage("ANNOTAT1")).rejects.toThrow(
            /Failed to delete image/,
        );
    });
});

describe("extracting annotation images", () => {
    async function seedPdfWithImageAnnotation(annotationType = "image") {
        await seedArticle();
        await seedItem({
            libraryID: LIB,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
            raw: {
                key: "ATTACH01",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: {
                    key: "ATTACH01",
                    itemType: "attachment",
                    contentType: "application/pdf",
                    tags: [],
                },
            } as any,
        } as any);
        await seedItem({
            libraryID: LIB,
            key: "ANNOTAT1",
            itemType: "annotation",
            parentItem: "ATTACH01",
            version: 5,
            raw: {
                key: "ANNOTAT1",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: {
                    key: "ANNOTAT1",
                    itemType: "annotation",
                    annotationType,
                    annotationPosition: JSON.stringify({ pageIndex: 0 }),
                    tags: [],
                },
            } as any,
        } as any);
    }

    test("an unrendered image annotation is sent to the Document Worker", async () => {
        await seedPdfWithImageAnnotation();
        const item = (await db.items.get([LIB, "PARENT01"]))!;

        await service.extractAnnotationImages(item, false);

        expect(renderedImages).toEqual([{ libraryID: LIB, count: 1 }]);
    });

    test("an unrendered ink annotation is sent to the Document Worker", async () => {
        await seedPdfWithImageAnnotation("ink");
        const item = (await db.items.get([LIB, "PARENT01"]))!;

        await service.extractAnnotationImages(item, false);

        expect(renderedImages).toEqual([{ libraryID: LIB, count: 1 }]);
    });

    test("a highlight annotation has no image to render", async () => {
        await seedPdfWithImageAnnotation("highlight");
        const item = (await db.items.get([LIB, "PARENT01"]))!;

        await service.extractAnnotationImages(item, false);

        expect(renderedImages).toEqual([]);
    });

    test("an already-rendered image is skipped until its version moves", async () => {
        await seedPdfWithImageAnnotation();
        await db.items.update([LIB, "ANNOTAT1"], {
            annotationImageVersion: 5,
        });
        const item = (await db.items.get([LIB, "PARENT01"]))!;

        await service.extractAnnotationImages(item, false);
        expect(renderedImages).toEqual([]);

        // Forcing overrides the version check.
        await service.extractAnnotationImages(item, true);
        expect(renderedImages).toEqual([{ libraryID: LIB, count: 1 }]);
    });

    test("non-PDF attachments are ignored", async () => {
        await seedArticle();
        await seedItem({
            libraryID: LIB,
            key: "ATTACH01",
            itemType: "attachment",
            parentItem: "PARENT01",
            raw: {
                key: "ATTACH01",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: {
                    key: "ATTACH01",
                    itemType: "attachment",
                    contentType: "text/html",
                    tags: [],
                },
            } as any,
        } as any);
        const item = (await db.items.get([LIB, "PARENT01"]))!;

        await service.extractAnnotationImages(item, true);

        expect(renderedImages).toEqual([]);
    });

    test("an image failure during an update is surfaced, not swallowed", async () => {
        await setup({ autoImportAnnotationImages: true });
        await seedPdfWithImageAnnotation();
        placeNote("Source/@PARENT01.md", "old", {
            "zotero-key": "PARENT01",
            "item-version": 3,
        });
        vi.spyOn(service, "extractAnnotationImages").mockRejectedValue(
            new Error("pdf.js blew up"),
        );

        await expect(service.ensureNote(LIB, "PARENT01", {})).rejects.toThrow(
            /Image update failed/,
        );
    });

    test("an image failure on first creation leaves the note in place", async () => {
        // The note is already written by then; losing the images is not worth
        // discarding it.
        await setup({ autoImportAnnotationImages: true });
        await seedPdfWithImageAnnotation();
        vi.spyOn(service, "extractAnnotationImages").mockRejectedValue(
            new Error("pdf.js blew up"),
        );

        await expect(service.ensureNote(LIB, "PARENT01", {})).resolves.toBe(
            "Source/@PARENT01.md",
        );
        expect(host.vault.has("Source/@PARENT01.md")).toBe(true);
        expect(
            host
                .logsAt("warn")
                .some((l) => /Initial image extraction failed/.test(l.message)),
        ).toBe(true);
    });
});

describe("template path handling", () => {
    test("a template path without an extension gets one", async () => {
        await setup({ librarySourceNoteTemplatePath: "Templates/source" });
        await seedArticle();
        host.vault.set("Templates/source.md", "# template");

        const reads: string[] = [];
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the fake's methods are closures
        const original = host.readTextFile;
        host.readTextFile = (path: string) => {
            reads.push(path);
            return original(path);
        };

        placeNote("Source/@PARENT01.md", "old", {
            "zotero-key": "PARENT01",
            "item-version": 3,
        });
        await service.ensureNote(LIB, "PARENT01", {});

        expect(reads).toContain("Templates/source.md");
    });

    test("an empty template path stays empty", async () => {
        await setup({ librarySourceNoteTemplatePath: "" });
        await seedArticle();

        const reads: string[] = [];
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the fake's methods are closures
        const original = host.readTextFile;
        host.readTextFile = (path: string) => {
            reads.push(path);
            return original(path);
        };

        placeNote("Source/@PARENT01.md", "old", {
            "zotero-key": "PARENT01",
            "item-version": 3,
        });
        await service.ensureNote(LIB, "PARENT01", {});

        expect(reads).toContain("");
    });
});
