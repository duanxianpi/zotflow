import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EnhancementResourceService } from "worker/services/enhancement-resources";
import { DEFAULT_SETTINGS } from "settings/types";
import { DocumentWorkerService } from "worker/services/document-worker";
import { resetDb, seedItem } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";

interface DocumentWorkerInternals {
    _fetchDocumentWorkerResource(resourcePath: string): Promise<Uint8Array>;
}

interface PostedWorkerMessage {
    id: number;
    action: string;
    data: Record<string, unknown>;
}

function createWorkerHarness() {
    const messageListeners: Array<(event: MessageEvent) => void> = [];
    const postMessage = vi.fn();
    class WorkerStub {
        addEventListener(
            type: string,
            listener: (event: MessageEvent) => void,
        ) {
            if (type === "message") messageListeners.push(listener);
        }

        terminate() {}

        postMessage(message: unknown, transfer?: Transferable[]) {
            postMessage(message, transfer);
        }
    }
    vi.stubGlobal("Worker", WorkerStub);

    const emitMessage = (data: unknown) => {
        for (const listener of messageListeners) {
            listener({ data } as MessageEvent);
        }
    };
    return { emitMessage, postMessage };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

beforeEach(async () => {
    await resetDb();
});

describe("DocumentWorkerService resources", () => {
    test("leases the disabled Pack on SDT resource demand and never shadows it with inline data", async () => {
        createWorkerHarness();
        const host = createFakeParentHost();
        const acquire = (host.acquireEnhancementSdtResources = vi.fn(
            async () => ({
                leaseId: "lease",
                generationId: "generation",
                snapshotId: "snapshot",
            }),
        ));
        const getBlob = vi.fn(async () => new Blob([new Uint8Array([1, 2])]));
        const release = (host.releaseEnhancementResources = vi.fn(
            async () => {},
        ));
        const nativeFetch = vi.fn(
            async () => new Response(new Uint8Array([1, 2]).buffer),
        );
        vi.stubGlobal("self", { originalFetch: nativeFetch });
        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS },
            host,
            {
                "document-worker/worker.js": "blob:worker",
                "document-worker/metadata.json": "blob:stale-inline",
            },
            { getBlob },
        );
        processor._init();
        expect(acquire).not.toHaveBeenCalled();
        const internals = processor as unknown as DocumentWorkerInternals;
        await Promise.all([
            internals._fetchDocumentWorkerResource("metadata.json"),
            internals._fetchDocumentWorkerResource(
                "structured-document-text.js",
            ),
        ]);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(getBlob).toHaveBeenCalledWith("snapshot", "metadata.json");
        expect(nativeFetch).not.toHaveBeenCalled();
        processor.dispose();
        await vi.waitFor(() => expect(release).toHaveBeenCalledWith("lease"));
    });

    test("releases a lease that arrives after its Worker has been disposed", async () => {
        const host = createFakeParentHost();
        let resolveLease!: (lease: {
            leaseId: string;
            generationId: string;
            snapshotId: string;
        }) => void;
        host.acquireEnhancementSdtResources = () =>
            new Promise((resolve) => {
                resolveLease = resolve;
            });
        const release = (host.releaseEnhancementResources = vi.fn(
            async () => {},
        ));
        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS },
            host,
            { "document-worker/worker.js": "blob:worker" },
            new EnhancementResourceService(),
        );
        const request = (
            processor as unknown as DocumentWorkerInternals
        )._fetchDocumentWorkerResource("metadata.json");
        processor.dispose();
        resolveLease({
            leaseId: "late",
            generationId: "generation",
            snapshotId: "snapshot",
        });
        await expect(request).rejects.toThrow("session ended");
        expect(release).toHaveBeenCalledTimes(1);
    });

    test("uses the Document Worker namespace instead of Reader PDF.js assets", async () => {
        const nativeFetch = vi.fn(() =>
            Promise.resolve(
                new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }),
            ),
        );
        vi.stubGlobal("self", { originalFetch: nativeFetch });

        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS },
            createFakeParentHost(),
            {
                "document-worker/worker.js": "blob:document-worker",
                "document-worker/cmaps/Test.bcmap": "blob:document-cmap",
                "pdf/web/cmaps/Test.bcmap": "blob:reader-cmap",
            },
            new EnhancementResourceService(),
        );
        const internals = processor as unknown as DocumentWorkerInternals;

        const data =
            await internals._fetchDocumentWorkerResource("cmaps/Test.bcmap");

        expect(processor.config.workerURL).toBe("blob:document-worker");
        expect(nativeFetch).toHaveBeenCalledWith("blob:document-cmap");
        expect([...data]).toEqual([1, 2, 3]);
    });

    test("reports a missing core resource without falling back to Reader assets", async () => {
        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS },
            createFakeParentHost(),
            {
                "document-worker/worker.js": "blob:document-worker",
                "pdf/web/standard_fonts/FoxitSans.pfb": "blob:reader-font",
            },
            new EnhancementResourceService(),
        );
        const internals = processor as unknown as DocumentWorkerInternals;

        await expect(
            internals._fetchDocumentWorkerResource(
                "standard_fonts/FoxitSans.pfb",
            ),
        ).rejects.toThrow(
            "Document Worker resource not found: document-worker/standard_fonts/FoxitSans.pfb",
        );
    });
});

describe("DocumentWorkerService structured document text", () => {
    test("rejects a Worker startup failure without stranding the queue", async () => {
        vi.stubGlobal(
            "Worker",
            class {
                constructor() {
                    throw new Error("Worker creation failed");
                }
            },
        );
        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS },
            createFakeParentHost(),
            { "document-worker/worker.js": "blob:worker" },
            new EnhancementResourceService(),
        );
        const options = {
            contentType: "application/pdf",
            sourceHash: "0123456789abcdef0123456789abcdef",
        };
        await expect(
            processor.getStructuredDocumentText(new ArrayBuffer(8), options),
        ).rejects.toThrow("Worker creation failed");
        const harness = createWorkerHarness();
        const retried = processor.getStructuredDocumentText(
            new ArrayBuffer(8),
            options,
        );
        await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalled());
        const request = harness.postMessage.mock
            .calls[0]![0] as PostedWorkerMessage;
        harness.emitMessage({
            responseID: request.id,
            data: { buf: new ArrayBuffer(4) },
        });
        await expect(retried).resolves.toBeInstanceOf(ArrayBuffer);
        processor.dispose();
    });

    test("sends the Zotero 10 payload and forwards progress", async () => {
        const harness = createWorkerHarness();
        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS },
            createFakeParentHost(),
            { "document-worker/worker.js": "blob:document-worker" },
            new EnhancementResourceService(),
        );
        const input = new ArrayBuffer(8);
        const output = new ArrayBuffer(4);
        const onProgress = vi.fn();

        const promise = processor.getStructuredDocumentText(input, {
            contentType: "application/pdf",
            sourceHash: "0123456789abcdef0123456789abcdef",
            onProgress,
        });

        await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalled());
        const request = harness.postMessage.mock.calls[0]?.[0] as
            PostedWorkerMessage | undefined;
        expect(request).toMatchObject({
            action: "getStructuredDocumentText",
            data: {
                buf: input,
                contentType: "application/pdf",
                password: undefined,
                sourceHash: "0123456789abcdef0123456789abcdef",
                reportProgress: true,
            },
        });

        harness.emitMessage({
            progressID: request!.id,
            data: { progress: 37 },
        });
        expect(onProgress).toHaveBeenCalledWith(37);

        harness.emitMessage({
            responseID: request!.id,
            data: { buf: output },
        });
        await expect(promise).resolves.toBe(output);
    });

    test("retains the worker error name for password handling", async () => {
        const harness = createWorkerHarness();
        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS },
            createFakeParentHost(),
            { "document-worker/worker.js": "blob:document-worker" },
            new EnhancementResourceService(),
        );
        const promise = processor.getStructuredDocumentText(
            new ArrayBuffer(8),
            {
                contentType: "application/pdf",
                sourceHash: "0123456789abcdef0123456789abcdef",
            },
        );

        await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalled());
        const request = harness.postMessage.mock.calls[0]?.[0] as
            PostedWorkerMessage | undefined;
        harness.emitMessage({
            responseID: request!.id,
            error: {
                name: "PasswordException",
                message: "Password required",
            },
        });

        await expect(promise).rejects.toMatchObject({
            data: { workerErrorName: "PasswordException" },
        });
    });

    test("rejects a non-MD5 source identity before starting the worker", async () => {
        const harness = createWorkerHarness();
        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS },
            createFakeParentHost(),
            { "document-worker/worker.js": "blob:document-worker" },
            new EnhancementResourceService(),
        );

        await expect(
            processor.getStructuredDocumentText(new ArrayBuffer(8), {
                contentType: "application/pdf",
                sourceHash: "NOT-A-HASH",
            }),
        ).rejects.toThrow("lowercase MD5");
        expect(harness.postMessage).not.toHaveBeenCalled();
    });
});

describe("DocumentWorkerService rendered annotation callback", () => {
    test("marks a version-zero external annotation only after its PNG is saved", async () => {
        await seedItem({
            libraryID: 1,
            key: "EXTERNAL",
            itemType: "annotation",
            parentItem: "ATTACH01",
            version: 0,
            syncStatus: "ignore",
        } as never);
        const harness = createWorkerHarness();
        const host = createFakeParentHost();
        const processor = new DocumentWorkerService(
            { ...DEFAULT_SETTINGS, annotationImageFolder: "Images" },
            host,
            { "document-worker/worker.js": "blob:document-worker" },
            new EnhancementResourceService(),
        );
        processor._init();
        const buf = new ArrayBuffer(4);

        harness.emitMessage({
            id: 77,
            action: "SaveRenderedAnnotation",
            data: { libraryID: 1, annotationKey: "EXTERNAL", buf },
        });

        await vi.waitFor(() =>
            expect(host.binaryVault.get("Images/EXTERNAL.png")).toBe(buf),
        );
        const { db } = await import("../fakes/db");
        await vi.waitFor(async () => {
            const row = await db.items.get([1, "EXTERNAL"]);
            expect(row?.annotationImageVersion).toBe(1);
        });
        expect(harness.postMessage).toHaveBeenCalledWith(
            { responseID: 77, data: true, error: null },
            [],
        );
    });
});
