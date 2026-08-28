/**
 * Extraction of external (embedded PDF) annotations, from the PDF worker's
 * reply to the shape the reader is handed.
 *
 * The interesting part is the boundary rather than the extraction: the PDF
 * worker already speaks the reader's annotation JSON, so anything that
 * reshapes it on the way through is a chance to hand the reader fields it
 * cannot read. These tests pin the shape at both ends of that path.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import SparkMD5 from "spark-md5";
import { DocumentWorkerService } from "worker/services/document-worker";
import { TaskManager } from "worker/tasks/manager";
import { resetDb, seedItem, seedLibrary } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";

import type { FakeParentHost } from "../fakes/parent-host";
import type { AttachmentService } from "worker/services/attachment";
import type { LibraryNoteService } from "worker/services/library-note";
import type { AnnotationJSON } from "types/zotero-reader";

const LIB = 1;

let host: FakeParentHost;
let manager: TaskManager;
let noteService: LibraryNoteService;
let triggerUpdate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    await resetDb();
    await seedLibrary({ id: LIB });
    host = createFakeParentHost();
    manager = new TaskManager(host);
    triggerUpdate = vi.fn(() => Promise.resolve());
    noteService = { triggerUpdate } as unknown as LibraryNoteService;
});

afterEach(() => vi.restoreAllMocks());

/**
 * A `DocumentWorkerService` with its transport replaced. The real constructor spins
 * up a nested Worker from a blob URL, which a test has no way to provide, so
 * the queue and the query are stubbed and the `import()` logic runs on top.
 */
function processorReplying(
    imported: unknown[],
    deleted: string[] = [],
): DocumentWorkerService {
    return processorQuerying(() => Promise.resolve({ imported, deleted }));
}

type QueryStub = (
    action: string,
    data: unknown,
    transfer?: Transferable[],
) => Promise<unknown>;

function processorQuerying(query: QueryStub): DocumentWorkerService {
    const processor = Object.create(
        DocumentWorkerService.prototype,
    ) as DocumentWorkerService;
    const internals = processor as unknown as {
        _enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
        _query: QueryStub;
    };
    internals._enqueue = (fn) => fn();
    internals._query = query;
    return processor;
}

/** What Zotero 10's Document Worker emits for one highlight. */
const importedHighlight = (overrides: Record<string, unknown> = {}) => ({
    type: "highlight",
    text: "a quoted sentence",
    comment: "my note",
    color: "#ffd400",
    pageLabel: "12",
    sortIndex: "00000|000000|00000",
    position: { pageIndex: 11, rects: [[1, 2, 3, 4]] },
    tags: ["method"],
    authorName: "A. Author",
    dateModified: "2026-01-02T03:04:05Z",
    ...overrides,
});

/**
 * A PDF attachment whose MD5 has never been extracted. Passing `null` models a
 * linked file, which the server has no MD5 for — `undefined` would silently
 * take the default instead.
 */
async function seedPdfAttachment(md5: string | null = "md5-of-the-pdf") {
    await seedItem({
        libraryID: LIB,
        key: "ATTACH01",
        itemType: "attachment",
        parentItem: "PARENT01",
        raw: {
            key: "ATTACH01",
            version: 1,
            library: { type: "user", id: LIB, name: "Library" },
            data: {
                key: "ATTACH01",
                version: 1,
                itemType: "attachment",
                contentType: "application/pdf",
                filename: "paper.pdf",
                linkMode: "imported_file",
                md5,
                tags: [],
                relations: {},
            },
        },
    } as never);
}

async function seedStoredAnnotation(
    key: string,
    isExternal: boolean,
    comment = "stored comment",
) {
    await seedItem({
        libraryID: LIB,
        key,
        itemType: "annotation",
        parentItem: "ATTACH01",
        syncStatus: isExternal ? "ignore" : "synced",
        raw: {
            key,
            version: 0,
            library: { type: "user", id: LIB, name: "Library" },
            data: {
                key,
                version: 0,
                itemType: "annotation",
                parentItem: "ATTACH01",
                annotationType: "highlight",
                annotationText: "stored text",
                annotationComment: comment,
                annotationColor: "#ffd400",
                annotationPageLabel: "1",
                annotationSortIndex: "00000|000000|00000",
                annotationPosition: JSON.stringify({
                    pageIndex: 0,
                    rects: [[1, 2, 3, 4]],
                }),
                annotationIsExternal: isExternal,
                dateAdded: "2026-01-01T00:00:00Z",
                dateModified: "2026-01-01T00:00:00Z",
                tags: [],
                relations: {},
                deleted: false,
            },
        },
    } as never);
}

const attachmentServiceYielding = (blob: Blob) =>
    ({
        getFileBlob: () => Promise.resolve(blob),
    }) as unknown as AttachmentService;

async function extract(imported: unknown[]): Promise<AnnotationJSON[]> {
    await seedPdfAttachment();
    return manager.createBatchExtractExternalAnnotationsTask(
        attachmentServiceYielding(new Blob(["%PDF-1.7"])),
        processorReplying(imported),
        noteService,
        { items: [{ libraryID: LIB, itemKey: "ATTACH01" }] },
    );
}

/**
 * Run an extraction over an already-seeded attachment, reporting whether the
 * PDF worker was reached — that is what the MD5 gates are there to prevent.
 */
async function extractAgainst(
    precomputedMD5: string | undefined,
    bytes = "%PDF-1.7",
) {
    const processor = processorReplying([importedHighlight()]);
    const spy = vi.spyOn(processor, "import");
    const attachmentService = attachmentServiceYielding(new Blob([bytes]));
    const readFile = vi.spyOn(attachmentService, "getFileBlob");
    const annotations = await manager.createBatchExtractExternalAnnotationsTask(
        attachmentService,
        processor,
        noteService,
        {
            items: [{ libraryID: LIB, itemKey: "ATTACH01", precomputedMD5 }],
        },
    );
    return { annotations, spy, readFile };
}

describe("DocumentWorkerService.import", () => {
    test("uses the Zotero 10 Document Worker import action", async () => {
        const query = vi
            .fn<QueryStub>()
            .mockResolvedValue({ imported: [], deleted: [] });
        const processor = processorQuerying(query);
        const buf = new ArrayBuffer(8);

        await processor.import(buf);

        expect(query).toHaveBeenCalledWith(
            "pdf.importAnnotations",
            {
                buf,
                existingAnnotations: [],
                password: undefined,
                transfer: false,
            },
            [buf],
        );
    });

    test("passes existing annotations through and returns the worker delta", async () => {
        const query = vi.fn<QueryStub>().mockResolvedValue({
            imported: [],
            deleted: ["EXTOLD01"],
        });
        const processor = processorQuerying(query);
        const buf = new ArrayBuffer(8);
        const existingAnnotations = [
            {
                id: "EXTOLD01",
                type: "highlight",
                position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
                comment: "stored comment",
            },
        ];

        const result = await processor.import(buf, { existingAnnotations });

        expect(result.deleted).toEqual(["EXTOLD01"]);
        expect(query).toHaveBeenCalledWith(
            "pdf.importAnnotations",
            {
                buf,
                existingAnnotations,
                password: undefined,
                transfer: false,
            },
            [buf],
        );
    });

    test("normalizes the worker annotation for the Reader bridge", async () => {
        // Document Worker emits tag names; the Reader consumes tag objects.
        const { imported } = await processorReplying([
            importedHighlight(),
        ]).import(new ArrayBuffer(8));
        const [annotation] = imported;

        expect(annotation).toMatchObject({
            type: "highlight",
            text: "a quoted sentence",
            comment: "my note",
            tags: [{ name: "method" }],
        });
    });

    test("marks everything it imports as external and gives it an id", async () => {
        const { imported } = await processorReplying([
            importedHighlight(),
        ]).import(new ArrayBuffer(8));
        const [annotation] = imported;

        expect(annotation!.isExternal).toBe(true);
        expect(annotation!.id).toMatch(/^[23456789A-NP-Z]{8}$/);
    });

    test("keeps the position as an object the reader can use", async () => {
        // Stringifying it here would force the caller to parse it back.
        const { imported } = await processorReplying([
            importedHighlight(),
        ]).import(new ArrayBuffer(8));
        const [annotation] = imported;

        expect(annotation!.position).toEqual({
            pageIndex: 11,
            rects: [[1, 2, 3, 4]],
        });
    });

    test("carries the modification stamp through", async () => {
        const { imported } = await processorReplying([
            importedHighlight(),
        ]).import(new ArrayBuffer(8));
        const [annotation] = imported;

        expect(annotation!.dateModified).toBe("2026-01-02T03:04:05Z");
    });

    test("dates an annotation the PDF never dated", async () => {
        // A PDF annotation records only `/M`, so `dateAdded` has no source.
        // The reader requires both, so the modification stamp stands in.
        const { imported } = await processorReplying([
            importedHighlight(),
        ]).import(new ArrayBuffer(8));
        const [annotation] = imported;

        expect(annotation!.dateAdded).toBe("2026-01-02T03:04:05Z");
    });

    test("gives an untagged annotation an empty tag list, not undefined", async () => {
        const { imported } = await processorReplying([
            importedHighlight({ tags: undefined }),
        ]).import(new ArrayBuffer(8));
        const [annotation] = imported;

        expect(annotation!.tags).toEqual([]);
    });

    test("gives each annotation a distinct id", async () => {
        const { imported: annotations } = await processorReplying([
            importedHighlight(),
            importedHighlight(),
            importedHighlight(),
        ]).import(new ArrayBuffer(8));

        expect(new Set(annotations.map((a) => a.id)).size).toBe(3);
    });
});

describe("DocumentWorkerService.renderAnnotations", () => {
    test("sends image and ink annotations through the Zotero 10 action", async () => {
        const query = vi.fn<QueryStub>().mockResolvedValue(2);
        const processor = processorQuerying(query);
        const buf = new ArrayBuffer(8);
        const annotations = [
            importedHighlight({ type: "image" }),
            importedHighlight({ type: "ink" }),
        ] as unknown as AnnotationJSON[];

        await processor.renderAnnotations(LIB, buf, annotations);

        expect(query).toHaveBeenCalledWith(
            "pdf.renderAnnotations",
            { libraryID: LIB, buf, annotations, password: undefined },
            [buf],
        );
    });
});

describe("BatchExtractExternalAnnotationsTask", () => {
    test("delivers the annotation to the reader with its tags intact", async () => {
        const annotations = await extract([importedHighlight()]);

        expect(annotations).toHaveLength(1);
        expect(annotations[0]).toMatchObject({
            type: "highlight",
            text: "a quoted sentence",
            tags: [{ name: "method" }],
            dateModified: "2026-01-02T03:04:05Z",
            authorName: "A. Author",
        });
    });

    test("locks every extracted annotation read-only", async () => {
        // They live in the PDF; an edit in the reader would have nowhere to go.
        const annotations = await extract([
            importedHighlight(),
            importedHighlight({ type: "note" }),
        ]);

        expect(annotations.every((a) => a.readOnly === true)).toBe(true);
        expect(annotations.every((a) => a.isExternal === true)).toBe(true);
    });

    test("records the extraction MD5 so the next run can skip the file", async () => {
        const { db } = await import("../fakes/db");
        await extract([importedHighlight()]);

        const row = await db.items.get([LIB, "ATTACH01"]);
        expect(row!.externalAnnotationExtractionFileMD5).toBe("md5-of-the-pdf");
    });

    test("persists imports as ignored external annotation rows", async () => {
        const { db } = await import("../fakes/db");

        await extract([importedHighlight()]);

        const rows = await db.items
            .where({
                libraryID: LIB,
                parentItem: "ATTACH01",
                itemType: "annotation",
            })
            .toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            syncStatus: "ignore",
            raw: {
                data: {
                    annotationIsExternal: true,
                    annotationComment: "my note",
                },
            },
        });
        expect(rows[0]!.annotationImageVersion).toBeUndefined();
    });

    test("reconciles deleted and imported annotations only after worker success", async () => {
        const { db } = await import("../fakes/db");
        await seedPdfAttachment();
        await seedStoredAnnotation("EXTOLD01", true);
        await seedStoredAnnotation("EXTKEEP1", true, "unchanged");
        await seedStoredAnnotation("INTERNAL", false);
        const query = vi.fn<QueryStub>().mockResolvedValue({
            imported: [importedHighlight({ comment: "new external" })],
            // A compromised/broken worker must not delete a non-external row.
            deleted: ["EXTOLD01", "INTERNAL"],
        });

        const annotations =
            await manager.createBatchExtractExternalAnnotationsTask(
                attachmentServiceYielding(new Blob(["%PDF-1.7"])),
                processorQuerying(query),
                noteService,
                { items: [{ libraryID: LIB, itemKey: "ATTACH01" }] },
            );

        expect(annotations).toHaveLength(1);
        expect(await db.items.get([LIB, "EXTOLD01"])).toBeUndefined();
        expect(await db.items.get([LIB, "EXTKEEP1"])).toBeDefined();
        expect(await db.items.get([LIB, "INTERNAL"])).toBeDefined();
        const imported = await db.items.get([LIB, annotations[0]!.id]);
        expect(imported).toMatchObject({
            syncStatus: "ignore",
            raw: { data: { annotationComment: "new external" } },
        });
        expect(query.mock.calls[0]?.[1]).toMatchObject({
            existingAnnotations: expect.arrayContaining([
                expect.objectContaining({
                    id: "EXTOLD01",
                    type: "highlight",
                    comment: "stored comment",
                    position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
                }),
                expect.objectContaining({ id: "EXTKEEP1" }),
            ]),
        });
        expect(triggerUpdate).toHaveBeenCalledOnce();
    });

    test("preserves the old snapshot and MD5 when the worker fails", async () => {
        const { db } = await import("../fakes/db");
        await seedPdfAttachment("new-file-md5");
        await seedStoredAnnotation("EXTOLD01", true);
        await db.items.update([LIB, "ATTACH01"], {
            externalAnnotationExtractionFileMD5: "old-file-md5",
        });
        const processor = processorQuerying(() =>
            Promise.reject(new Error("worker failed")),
        );

        const annotations =
            await manager.createBatchExtractExternalAnnotationsTask(
                attachmentServiceYielding(new Blob(["%PDF-1.7"])),
                processor,
                noteService,
                { items: [{ libraryID: LIB, itemKey: "ATTACH01" }] },
            );

        expect(annotations).toEqual([]);
        expect(await db.items.get([LIB, "EXTOLD01"])).toBeDefined();
        const attachment = await db.items.get([LIB, "ATTACH01"]);
        expect(attachment!.externalAnnotationExtractionFileMD5).toBe(
            "old-file-md5",
        );
        expect(triggerUpdate).not.toHaveBeenCalled();
    });

    test("skips a file whose server MD5 already matches the last extraction", async () => {
        const { db } = await import("../fakes/db");
        await seedPdfAttachment();
        await db.items.update([LIB, "ATTACH01"], {
            externalAnnotationExtractionFileMD5: "md5-of-the-pdf",
        });

        const { annotations, spy, readFile } = await extractAgainst(undefined);

        expect(spy).not.toHaveBeenCalled();
        expect(annotations).toEqual([]);
        // The point of checking the server MD5 first is that the file never
        // has to be downloaded to find out nothing changed.
        expect(readFile).not.toHaveBeenCalled();
    });

    test("trusts the hash of the local bytes over the server's", async () => {
        // A local file that has diverged from the server copy is still the
        // file that was extracted, so its own hash decides.
        const { db } = await import("../fakes/db");
        await seedPdfAttachment("md5-the-server-reports");
        await db.items.update([LIB, "ATTACH01"], {
            externalAnnotationExtractionFileMD5: "md5-of-the-local-bytes",
        });

        const { annotations, spy } = await extractAgainst(
            "md5-of-the-local-bytes",
        );

        expect(spy).not.toHaveBeenCalled();
        expect(annotations).toEqual([]);
    });

    test("skips a linked file whose precomputed MD5 matches", async () => {
        // No server MD5, but the caller already hashed the blob it loaded.
        const { db } = await import("../fakes/db");
        await seedPdfAttachment(null);
        await db.items.update([LIB, "ATTACH01"], {
            externalAnnotationExtractionFileMD5: "hash-of-the-linked-file",
        });

        const { annotations, spy, readFile } = await extractAgainst(
            "hash-of-the-linked-file",
        );

        expect(spy).not.toHaveBeenCalled();
        expect(annotations).toEqual([]);
        // A linked file lives on disk, so this gate exists to avoid re-reading
        // it once the caller has already hashed the bytes.
        expect(readFile).not.toHaveBeenCalled();
    });

    test("skips a linked file whose content hashes to the last extraction", async () => {
        // Neither MD5 is known up front, so the file is read and hashed. This
        // is the last gate before a redundant re-extraction of every page.
        const { db } = await import("../fakes/db");
        const bytes = "%PDF-1.7 linked";
        const contentMD5 = SparkMD5.ArrayBuffer.hash(
            await new Blob([bytes]).arrayBuffer(),
        );
        await seedPdfAttachment(null);
        await db.items.update([LIB, "ATTACH01"], {
            externalAnnotationExtractionFileMD5: contentMD5,
        });

        const { annotations, spy } = await extractAgainst(undefined, bytes);

        expect(spy).not.toHaveBeenCalled();
        expect(annotations).toEqual([]);
    });

    test("re-extracts when the content no longer hashes to the last extraction", async () => {
        const { db } = await import("../fakes/db");
        await seedPdfAttachment(null);
        await db.items.update([LIB, "ATTACH01"], {
            externalAnnotationExtractionFileMD5: "hash-of-an-older-revision",
        });

        const { annotations, spy } = await extractAgainst(undefined);

        expect(spy).toHaveBeenCalled();
        expect(annotations).toHaveLength(1);
    });
});
