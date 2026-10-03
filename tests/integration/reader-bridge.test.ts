import { EventBus } from "services/event-bus";
import { normalizeAnnotationSettings } from "utils/annotation-profiles";
/**
 * `IframeReaderBridge` driven by a fake reader child.
 *
 * There is no iframe and no postMessage here. Only the module boundary is
 * faked — penpal (which delivers exactly one inbound call, `shakehand`), the
 * fake DOM the bridge builds its iframe from, and the three main-thread
 * singletons. Everything the bridge itself does is real: the token handshake,
 * the state machine, both deferred queues, and every `ParentAPI` method the
 * reader calls back into.
 *
 * `tests/fakes/reader-bridge.ts` explains the seams and owns the choreography.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "settings/types";
import { IframeReaderBridge } from "ui/reader/bridge";
import { ZOTFLOW_CITATION_MIME } from "ui/editor/citation-helper";
// Imported by path, not as "obsidian": the alias makes them the same module at
// runtime, but only this specifier carries the stub's recording surface.
import { MarkdownRenderer } from "../stubs/obsidian";
import {
    ATTACHMENT,
    createFakeDataTransfer,
    createFakeRenderTarget,
    createReaderBridgeHarness,
    makeAnnotation,
    makeReaderOptions,
    resetReaderBridgeState,
} from "../fakes/reader-bridge";

import type {
    ReaderBridgeHarnessOptions,
    ReaderBridgeState,
} from "../fakes/reader-bridge";

/* ------------------------------------------------------------------ */
/*  Module boundary fakes                                             */
/* ------------------------------------------------------------------ */

// Hoisted above the imports, so it cannot reference them — a plain literal
// matching `ReaderBridgeState`.
const state = vi.hoisted(() => ({
    penpalMethods: null as null | { shakehand: () => Promise<void> },
    penpalDestroys: 0,
    settings: null as never,
    notesByKey: new Map<string, string>(),
    logs: [] as Array<{ level: string; message: string }>,
    clipboard: [] as string[],
    citationResult: null as null | {
        citation: string;
        footnoteDef?: string;
    },
    remoteAnnotations: [] as unknown[],
    annotationFetches: 0,
})) as unknown as ReaderBridgeState;

vi.mock("penpal", () => ({
    WindowMessenger: class {
        constructor(_opts: unknown) {}
    },
    connect: (opts: { methods: { shakehand: () => Promise<void> } }) => {
        state.penpalMethods = opts.methods;
        return {
            promise: Promise.resolve({}),
            destroy: () => {
                state.penpalDestroys++;
                state.penpalMethods = null;
            },
        };
    },
}));

// Would pull in `virtual:reader-resources`, an esbuild-only module.
vi.mock("bundle-assets/inline-assets", () => ({
    getBlobUrls: () => ({ "reader.html": "blob:reader-html" }),
    revokeBlobUrls: () => {},
}));

vi.mock("bridge", () => ({
    workerBridge: {
        annotation: {
            getAnnotations: () => {
                state.annotationFetches++;
                return Promise.resolve(state.remoteAnnotations);
            },
        },
    },
}));

// Pulls in @codemirror/view, monkey-around and Obsidian's private editor
// prototype. Nothing the bridge's own logic depends on.
vi.mock("ui/editor/markdown-editor", () => ({
    createEmbeddableMarkdownEditor: (
        _app: unknown,
        _container: unknown,
        options: Record<string, unknown>,
    ) => ({ options, onunload: vi.fn() }),
    EmbeddableMarkdownEditor: class {},
}));

vi.mock("services/services", () => ({
    services: {
        eventHub: { get settingsChanged() { return settingsChanged; } },
        get app() {
            return { metadataCache: { resolvedLinks: {} } };
        },
        get settings() {
            return state.settings;
        },
        indexService: {
            getFileByKey: (key: string) => {
                const path = state.notesByKey.get(key);
                return path ? { path } : null;
            },
        },
        logService: {
            log: (level: string, message: string) =>
                state.logs.push({ level, message }),
            debug: (m: string) => state.logs.push({ level: "debug", message: m }),
            info: (m: string) => state.logs.push({ level: "info", message: m }),
            warn: (m: string) => state.logs.push({ level: "warn", message: m }),
            error: (m: string) => state.logs.push({ level: "error", message: m }),
        },
        notificationService: { notify: () => {} },
        citationService: {
            resolve: () => Promise.resolve(state.citationResult),
        },
    },
}));

/* ------------------------------------------------------------------ */

let settingsChanged = new EventBus<[]>();

const harness = (options?: ReaderBridgeHarnessOptions) =>
    createReaderBridgeHarness(IframeReaderBridge, state, options);

beforeEach(() => {
    settingsChanged = new EventBus<[]>();
    resetReaderBridgeState(state, { ...DEFAULT_SETTINGS });
    MarkdownRenderer.reset();

    // Read by the "follow Obsidian" theme path off the parent's body.
    vi.stubGlobal("getComputedStyle", () => ({ colorScheme: "dark" }));

    vi.stubGlobal("navigator", {
        ...globalThis.navigator,
        clipboard: {
            writeText: (text: string) => {
                state.clipboard.push(text);
                return Promise.resolve();
            },
        },
    });
});

/** The citation copy path is fire-and-forget; let its async body settle. */
const clipboardSettles = () =>
    vi.waitFor(() => expect(state.clipboard).toHaveLength(1));

/**
 * Same, for the cases that assert *nothing* happened — there is no state
 * change to poll for, so yield the macrotask the async body needs to finish.
 */
const fireAndForgetSettles = () => new Promise((r) => setTimeout(r, 0));

/* ================================================================== */

describe("handshake", () => {
    it("installs the bootstrap on the child window and reaches bridge-ready", async () => {
        const h = harness();
        expect(h.bridge.state).toBe("connecting");

        const { token } = await h.shakehand();
        expect(token).toBeTruthy();
        // Still connecting — the child has not registered yet.
        expect(h.bridge.state).toBe("connecting");

        await h.completeHandshake();
        expect(h.bridge.state).toBe("bridge-ready");
    });

    it("configures the iframe before the child ever sees it", async () => {
        const h = harness();
        await h.completeHandshake();

        expect(h.iframe.id).toBe("zotero-reader-iframe");
        expect(h.iframe.src).toBe("blob:reader-html");
        expect(h.iframe.sandbox.added).toEqual([
            "allow-scripts",
            "allow-same-origin",
            "allow-forms",
        ]);
    });

    it("rejects a register call carrying the wrong token", async () => {
        const h = harness();
        const { register } = await h.shakehand();

        await expect(
            register(h.child as never, "not-the-token"),
        ).rejects.toThrow("Bridge token mismatch");
        expect(h.bridge.state).toBe("connecting");
    });

    it("mints a distinct token per handshake", async () => {
        const h = harness();
        const first = await h.shakehand();
        const second = await h.shakehand();
        expect(second.token).not.toBe(first.token);

        // The superseded token no longer registers.
        await expect(
            second.register(h.child as never, first.token),
        ).rejects.toThrow("Bridge token mismatch");
    });
});

describe("deferred queues", () => {
    it("initialises the reader exactly once in the production order", async () => {
        // Both views `await bridge.connect()` first, then call `initReader`
        // with the downloaded buffer.
        const h = harness();
        await h.completeHandshake();
        expect(h.child.initReader).not.toHaveBeenCalled();

        await h.bridge.initReader(makeReaderOptions());
        expect(h.child.initReader).toHaveBeenCalledTimes(1);
        expect(h.bridge.state).toBe("reader-ready");
    });

    it("initialises once even when initReader is requested during connect", async () => {
        const h = harness();

        // Requested while still connecting — must not throw, must not call out.
        await h.bridge.initReader(makeReaderOptions());
        expect(h.child.initReader).not.toHaveBeenCalled();

        await h.completeHandshake();
        expect(h.bridge.state).toBe("reader-ready");

        // `initReader` records `_readerOpts` eagerly, before queueing, so the
        // tail of `connect()` sees a populated replay cache and would re-init a
        // document the bridge-ready queue has already loaded. The tail's
        // `reader-ready` check is what keeps this at one.
        expect(h.child.initReader).toHaveBeenCalledTimes(1);
    });

    it("defers a reader-level call issued at bridge-ready", async () => {
        // The two queues only differ here: the bridge is connected, so
        // `runAfterBridgeReady` would fire, but the reader has no document yet.
        // Without this case, widening the `runAfterReaderReady` guard to accept
        // bridge-ready passes the whole suite.
        const h = harness();
        await h.completeHandshake();
        expect(h.bridge.state).toBe("bridge-ready");

        const annotation = makeAnnotation("anno-1");
        await h.bridge.addAnnotation(annotation);
        expect(h.child.addAnnotation).not.toHaveBeenCalled();

        await h.bridge.initReader(makeReaderOptions());
        expect(h.child.addAnnotation).toHaveBeenCalledWith(annotation);
    });

    it("holds a reader-level call issued while connecting", async () => {
        const h = harness();
        const annotation = makeAnnotation("anno-2");

        await h.bridge.addAnnotation(annotation);
        await h.completeHandshake();
        expect(h.child.addAnnotation).not.toHaveBeenCalled();

        await h.bridge.initReader(makeReaderOptions());
        expect(h.child.addAnnotation).toHaveBeenCalledWith(annotation);
    });

    it("drains the reader queue in request order", async () => {
        const h = harness();
        const order: string[] = [];
        h.child.addAnnotation.mockImplementation(() => {
            order.push("add");
            return Promise.resolve(true);
        });
        h.child.navigate.mockImplementation(() => {
            order.push("navigate");
            return Promise.resolve(true);
        });

        await h.bridge.addAnnotation(makeAnnotation("anno-3"));
        await h.bridge.navigate({ pageIndex: 4 });
        await h.completeHandshake();
        await h.bridge.initReader(makeReaderOptions());

        expect(order).toEqual(["add", "navigate"]);
    });

    it("passes bridge-level calls through at bridge-ready", async () => {
        const h = harness();
        await h.bridge.setColorScheme("dark");
        await h.completeHandshake();
        expect(h.child.setColorScheme).toHaveBeenCalledWith("dark");
    });

    it("rejects reader calls made after dispose", async () => {
        const h = harness();
        await h.completeHandshake();
        await h.bridge.dispose();

        await expect(h.bridge.navigate({ pageIndex: 2 })).rejects.toThrow(
            /Bridge not ready \(state=disposed\)/,
        );
    });
});

describe("event dispatch", () => {
    it("routes an event only to listeners of its own type", async () => {
        const h = harness();
        const parent = await h.completeHandshake();

        const saved: unknown[] = [];
        const deleted: unknown[] = [];
        h.bridge.onEventType("annotationsSaved", (e) => saved.push(e));
        h.bridge.onEventType("annotationsDeleted", (e) => deleted.push(e));

        parent.handleEvent({ type: "annotationsSaved", annotations: [] });
        expect(saved).toHaveLength(1);
        expect(deleted).toHaveLength(0);
    });

    it("delivers to every listener on the same type", async () => {
        const h = harness();
        const parent = await h.completeHandshake();

        const seen: string[] = [];
        h.bridge.onEventType("sidebarToggled", () => seen.push("a"));
        h.bridge.onEventType("sidebarToggled", () => seen.push("b"));

        parent.handleEvent({ type: "sidebarToggled", open: true });
        expect(seen).toEqual(["a", "b"]);
    });

    it("stops delivering after the returned unsubscribe runs", async () => {
        const h = harness();
        const parent = await h.completeHandshake();

        const seen: unknown[] = [];
        const off = h.bridge.onEventType("sidebarToggled", (e) => seen.push(e));
        parent.handleEvent({ type: "sidebarToggled", open: true });
        off();
        parent.handleEvent({ type: "sidebarToggled", open: false });

        expect(seen).toEqual([{ type: "sidebarToggled", open: true }]);
    });

    it("drops an event nobody is listening for", async () => {
        const h = harness();
        const parent = await h.completeHandshake();
        expect(() =>
            parent.handleEvent({ type: "toggleContextPane" }),
        ).not.toThrow();
    });
});

describe("getLinkToSelection", () => {
    it("builds an obsidian:// link for a cloud attachment with a source note", async () => {
        state.notesByKey.set("PARENTKEY", "Sources/Paper.md");
        const h = harness();
        const parent = await h.completeHandshake();

        const link = parent.getLinkToSelection("quoted text", {
            pageLabel: "12",
        });

        expect(link).toContain("[quoted text](obsidian://zotflow");
        expect(link).toContain("type=open-attachment");
        expect(link).toContain("libraryID=7");
        // The attachment key, not the parent key — the link has to reopen the file.
        expect(link).toContain("key=ATTACHKEY");
        expect(link).toContain(
            `navigation=${encodeURIComponent(JSON.stringify({ pageLabel: "12" }))}`,
        );
    });

    it("returns an empty string when no source note is indexed", async () => {
        const h = harness();
        const parent = await h.completeHandshake();
        expect(parent.getLinkToSelection("text", {})).toBe("");
    });

    it("returns an empty string when there is no attachment at all", async () => {
        const h = harness({ attachment: null });
        const parent = await h.completeHandshake();
        expect(parent.getLinkToSelection("text", {})).toBe("");
    });

    it("looks the note up by the attachment key when it has no parent item", async () => {
        // A standalone attachment carries `parentItem: ""` and is its own parent.
        state.notesByKey.set("ATTACHKEY", "Sources/Standalone.md");
        const h = harness({
            attachment: { ...ATTACHMENT, parentItem: "" },
        });
        const parent = await h.completeHandshake();

        expect(parent.getLinkToSelection("text", {})).toContain(
            "[text](obsidian://zotflow",
        );
    });
});

describe("handleSetDataTransferAnnotations", () => {
    it("writes joined plain text and nothing else when fromText is set", async () => {
        state.notesByKey.set("PARENTKEY", "Sources/Paper.md");
        const h = harness();
        const parent = await h.completeHandshake();
        const dt = createFakeDataTransfer();

        parent.handleSetDataTransferAnnotations(
            dt as unknown as DataTransfer,
            [
                makeAnnotation("a", { text: "first" }),
                makeAnnotation("b", { text: "second" }),
            ],
            true,
        );

        expect(dt.data.get("text/plain")).toBe("first\nsecond");
        expect(dt.data.has(ZOTFLOW_CITATION_MIME)).toBe(false);
    });

    it("restores libraryID and parentItem the reader stripped", async () => {
        const h = harness();
        const parent = await h.completeHandshake();
        const dt = createFakeDataTransfer();

        parent.handleSetDataTransferAnnotations(dt as unknown as DataTransfer, [
            makeAnnotation("a", { text: "first" }),
        ]);

        const payload = JSON.parse(dt.data.get(ZOTFLOW_CITATION_MIME)!);
        expect(payload).toMatchObject({
            type: "zotflow-citation",
            libraryID: 7,
            // The citation resolves against the *parent* item, not the file.
            key: "PARENTKEY",
        });
        expect(payload.annotations[0]).toMatchObject({
            libraryID: 7,
            parentItem: "ATTACHKEY",
        });
    });

    it("sets no citation MIME for a local file", async () => {
        const h = harness({ isLocal: true, attachment: null });
        const parent = await h.completeHandshake();
        const dt = createFakeDataTransfer();

        parent.handleSetDataTransferAnnotations(dt as unknown as DataTransfer, [
            makeAnnotation("a", { text: "first" }),
        ]);

        expect(dt.data.has(ZOTFLOW_CITATION_MIME)).toBe(false);
    });

    it("falls back to a single space when there is no source note", async () => {
        const h = harness();
        const parent = await h.completeHandshake();
        const dt = createFakeDataTransfer();

        parent.handleSetDataTransferAnnotations(dt as unknown as DataTransfer, [
            makeAnnotation("a", { text: "first" }),
        ]);

        // Not empty: an empty text/plain would make Obsidian reject the drop.
        expect(dt.data.get("text/plain")).toBe(" ");
    });

    it("emits block embeds for every annotation when a source note exists", async () => {
        state.notesByKey.set("PARENTKEY", "Sources/Paper.md");
        const h = harness();
        const parent = await h.completeHandshake();
        const dt = createFakeDataTransfer();

        parent.handleSetDataTransferAnnotations(dt as unknown as DataTransfer, [
            makeAnnotation("a", { text: "first" }),
            makeAnnotation("b", { text: "second" }),
        ]);

        expect(dt.data.get("text/plain")).toBe(
            "![[Sources/Paper.md#^a]]\n\n![[Sources/Paper.md#^b]]",
        );
    });
});

describe("copyAnnotationCitation", () => {
    it("copies annotation text, skipping the empty ones", async () => {
        const h = harness();
        const parent = await h.completeHandshake();

        parent.copyAnnotationCitation(
            [
                makeAnnotation("a", { text: "first" }),
                makeAnnotation("b", { text: null }),
                makeAnnotation("c", { text: "third" }),
            ],
            "text",
        );

        await clipboardSettles();
        expect(state.clipboard[0]).toBe("first\nthird");
    });

    it("copies block embeds in embed mode", async () => {
        state.notesByKey.set("PARENTKEY", "Sources/Paper.md");
        const h = harness();
        const parent = await h.completeHandshake();

        parent.copyAnnotationCitation(
            [makeAnnotation("a"), makeAnnotation("b")],
            "embed",
        );

        await clipboardSettles();
        expect(state.clipboard[0]).toBe(
            "![[Sources/Paper.md#^a]]\n![[Sources/Paper.md#^b]]",
        );
    });

    it("copies nothing in embed mode without a source note", async () => {
        const h = harness();
        const parent = await h.completeHandshake();

        parent.copyAnnotationCitation([makeAnnotation("a")], "embed");
        await fireAndForgetSettles();

        expect(state.clipboard).toHaveLength(0);
    });

    it("appends the footnote definition when the citation carries one", async () => {
        state.citationResult = {
            citation: "[^zf1]",
            footnoteDef: "[^zf1]: Author 2020, p. 4",
        };
        const h = harness();
        const parent = await h.completeHandshake();

        parent.copyAnnotationCitation([makeAnnotation("a")], "footnote");

        await clipboardSettles();
        expect(state.clipboard[0]).toBe("[^zf1]\n[^zf1]: Author 2020, p. 4");
    });

    it("copies the bare citation when there is no footnote definition", async () => {
        state.citationResult = { citation: "(Author, 2020)" };
        const h = harness();
        const parent = await h.completeHandshake();

        parent.copyAnnotationCitation([makeAnnotation("a")], "inline");

        await clipboardSettles();
        expect(state.clipboard[0]).toBe("(Author, 2020)");
    });

    it("writes nothing when the citation cannot be resolved", async () => {
        state.citationResult = null;
        const h = harness();
        const parent = await h.completeHandshake();

        parent.copyAnnotationCitation([makeAnnotation("a")], "inline");
        await fireAndForgetSettles();

        expect(state.clipboard).toHaveLength(0);
    });

    it("writes nothing for a citation format on a local file", async () => {
        state.citationResult = { citation: "(Author, 2020)" };
        const h = harness({ isLocal: true, attachment: null });
        const parent = await h.completeHandshake();

        parent.copyAnnotationCitation([makeAnnotation("a")], "default");
        await fireAndForgetSettles();

        expect(state.clipboard).toHaveLength(0);
    });

    it("logs instead of throwing when the clipboard rejects", async () => {
        vi.stubGlobal("navigator", {
            ...globalThis.navigator,
            clipboard: {
                writeText: () => Promise.reject(new Error("denied")),
            },
        });
        const h = harness();
        const parent = await h.completeHandshake();

        expect(() =>
            parent.copyAnnotationCitation([makeAnnotation("a", { text: "x" })], "text"),
        ).not.toThrow();

        await vi.waitFor(() =>
            expect(
                state.logs.some(
                    (l) =>
                        l.level === "error" &&
                        l.message.includes("Failed to copy annotation citation"),
                ),
            ).toBe(true),
        );
    });
});

describe("markdown rendering for the reader", () => {
    it("hands the reader's text to Obsidian and returns an unload handle", async () => {
        const h = harness();
        const parent = await h.completeHandshake();
        const target = createFakeRenderTarget();

        const handle = parent.renderMarkdownToContainer(
            target.el as unknown as HTMLElement,
            "**bold**",
        );

        expect(MarkdownRenderer.calls.at(-1)?.markdown).toBe("**bold**");
        expect(target.calls.emptied).toBe(1);
        expect(target.calls.classes).toContain("content");
        expect(typeof handle.unload).toBe("function");
    });

    it("unloads every renderer it handed out when disposed", async () => {
        const h = harness();
        const parent = await h.completeHandshake();

        const first = createFakeRenderTarget();
        const second = createFakeRenderTarget();
        const handleA = parent.renderMarkdownToContainer(
            first.el as unknown as HTMLElement,
            "a",
        );
        parent.renderMarkdownToContainer(second.el as unknown as HTMLElement, "b");

        await h.bridge.dispose();

        // Already unloaded by dispose; the handle must not double-unload.
        expect(() => handleA.unload()).not.toThrow();
    });
});

/**
 * Obsidian reparents the DOM when a panel is split or popped out. The iframe
 * *element* survives, but the browser discards its browsing context and
 * reloads — so the reader inside comes back blank and the old child API is
 * dead. `iframe.onload` firing a second time is the only signal, and the
 * handler at `bridge.ts:406` turns it into a `reconnect()`.
 */
describe("unexpected iframe reload", () => {
    /** Drive a reparent through to a fully re-established reader. */
    const reparentAndRecover = async (h: ReturnType<typeof harness>) => {
        h.reparent();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));
        await h.register();
        await vi.waitFor(() => expect(h.bridge.state).toBe("reader-ready"));
    };

    it("stamps the theme classes the reader's CSS keys off", async () => {
        state.settings!.readerColorScheme = "dark";
        const h = harness();
        await h.completeHandshake();

        // The initial load already ran when the iframe was inserted.
        expect(h.iframe.contentDocument.classes.get("obsidian-theme-dark")).toBe(
            true,
        );
        expect(
            h.iframe.contentDocument.classes.get("obsidian-theme-light"),
        ).toBe(false);
        // Only the "obsidian-theme" scheme opts into theme inheritance.
        expect(
            h.iframe.contentDocument.attributes.has("data-obsidian-theme"),
        ).toBe(false);
    });

    it("follows the parent's computed scheme when set to obsidian-theme", async () => {
        state.settings!.readerColorScheme = "obsidian-theme";
        const h = harness();
        await h.completeHandshake();

        // getComputedStyle is stubbed to report dark.
        expect(h.iframe.contentDocument.classes.get("obsidian-theme-dark")).toBe(
            true,
        );
        expect(
            h.iframe.contentDocument.attributes.get("data-obsidian-theme"),
        ).toBe("");
    });

    it("treats the initial load as expected and does not reconnect", async () => {
        const h = harness();
        expect(h.iframe.loadCount).toBe(1);
        await fireAndForgetSettles();

        expect(h.iframes).toHaveLength(1);
        await h.completeHandshake();
        expect(h.bridge.state).toBe("bridge-ready");
        expect(
            state.logs.some((l) =>
                l.message.includes("Iframe reloaded unexpectedly"),
            ),
        ).toBe(false);
    });

    it("reconnects and restores the document when a live reader reloads", async () => {
        const h = harness();
        await h.completeHandshake();
        await h.bridge.initReader(makeReaderOptions({ annotations: [] }));
        expect(h.iframes).toHaveLength(1);

        await reparentAndRecover(h);

        expect(
            state.logs.some(
                (l) =>
                    l.level === "warn" &&
                    l.message.includes("Iframe reloaded unexpectedly"),
            ),
        ).toBe(true);
        expect(h.child.initReader).toHaveBeenCalledTimes(2);
        expect(h.child.initReader.mock.calls[1]![0].data).toEqual({
            buf: null,
            url: "blob:doc",
        });
    });

    it("recovers a reload that lands before the first initReader", async () => {
        // The window between `connect()` resolving and the attachment download
        // finishing. There is no document to replay yet, so the bridge must come
        // back to bridge-ready and let the pending `initReader` land on the NEW
        // child — the old one belongs to a Window that no longer exists.
        const h = harness();
        await h.completeHandshake();
        expect(h.bridge.state).toBe("bridge-ready");

        h.reparent();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));
        await h.register();
        expect(h.bridge.state).toBe("bridge-ready");
        expect(h.child.initReader).not.toHaveBeenCalled();

        // The download finishes and the view initialises, against the new child.
        await h.bridge.initReader(makeReaderOptions());
        expect(h.child.initReader).toHaveBeenCalledTimes(1);
        expect(h.bridge.state).toBe("reader-ready");
    });

    it("recovers a reload that lands mid-handshake", async () => {
        // Split the panel before the child has even registered. Previously
        // unrecoverable: the guard never fired, and penpal's messenger is pinned
        // to the pre-reload Window, so the original connect could only time out.
        const h = harness();
        h.reparent();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));

        await h.register();
        // The superseded first `connect()` unwinds instead of hanging.
        await expect(h.connecting).resolves.toBeUndefined();
        expect(h.bridge.state).toBe("bridge-ready");
    });

    it("replays the view state as of the last update, not as of open", async () => {
        const h = harness();
        await h.completeHandshake();
        await h.bridge.initReader(
            makeReaderOptions({
                annotations: [],
                primaryViewState: { pageIndex: 0, scrollTop: 0 },
            }),
        );

        // What the views now do on every `viewStateChanged` event.
        h.bridge.updateReaderOpts({
            primaryViewState: { pageIndex: 7, scrollTop: 420 },
        });

        await reparentAndRecover(h);

        expect(h.child.initReader.mock.calls[1]![0].primaryViewState).toEqual({
            pageIndex: 7,
            scrollTop: 420,
        });
    });

    it("ignores a view-state update before there is anything to replay", async () => {
        const h = harness();
        await h.completeHandshake();

        // No `initReader` yet — nothing to merge into, and the view reads the
        // live state from ViewStateService in this window anyway.
        h.bridge.updateReaderOpts({ primaryViewState: { pageIndex: 3 } });

        await h.bridge.initReader(makeReaderOptions({ annotations: [] }));
        expect(
            h.child.initReader.mock.calls[0]![0].primaryViewState,
        ).toBeUndefined();
    });

    it("does not fabricate a replay cache out of a view-state update", async () => {
        // If `updateReaderOpts` created `_readerOpts` when none existed, the
        // reconnect tail would treat it as a document to replay and initialise
        // the reader with no file at all.
        const h = harness();
        await h.completeHandshake();
        h.bridge.updateReaderOpts({ primaryViewState: { pageIndex: 3 } });

        h.reparent();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));
        await h.register();
        await fireAndForgetSettles();

        expect(h.child.initReader).not.toHaveBeenCalled();
        expect(h.bridge.state).toBe("bridge-ready");
    });

    it("does not let a superseded connect init the replacement child", async () => {
        // `initReader` during connect populates the replay cache, then the panel
        // is split before the child registers. The original `connect()` is
        // parked; when `dispose()` releases it, it must unwind rather than run
        // its tail against the new child — the reconnect's own tail owns that.
        const h = harness();
        await h.bridge.initReader(makeReaderOptions({ annotations: [] }));

        h.reparent();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));
        await h.register();
        await expect(h.connecting).resolves.toBeUndefined();
        await vi.waitFor(() => expect(h.bridge.state).toBe("reader-ready"));

        // Exactly one init: the reconnect's. The queued one was dropped with the
        // dead child, and the superseded connect contributed nothing.
        expect(h.child.initReader).toHaveBeenCalledTimes(1);
        // And exactly one worker round-trip. Letting the superseded connect run
        // its tail would refetch the annotations for a document it will not own;
        // the duplicate init is separately absorbed by the reader-ready guard,
        // so this fetch count is what actually binds the generation check.
        expect(state.annotationFetches).toBe(1);
    });

    it("collapses two reloads in quick succession into one reconnect", async () => {
        // Split, then immediately drag out. Two `connect()`s would orphan the
        // first on a detached iframe.
        const h = harness();
        await h.completeHandshake();
        await h.bridge.initReader(makeReaderOptions({ annotations: [] }));

        h.reparent();
        h.reparent();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));
        await fireAndForgetSettles();

        // One new iframe, not two.
        expect(h.iframes).toHaveLength(2);
    });
});

describe("lifecycle", () => {
    it("destroys the child and penpal before removing the iframe", async () => {
        const h = harness();
        await h.completeHandshake();
        h.child.destroy.mockImplementation(async () => {
            expect(h.iframe.removed).toBe(false);
            expect(state.penpalDestroys).toBe(0);
            return true;
        });

        await h.bridge.dispose();

        expect(h.child.destroy).toHaveBeenCalledTimes(1);
        expect(state.penpalDestroys).toBe(1);
        expect(h.iframe.removed).toBe(true);
        expect(h.bridge.state).toBe("disposed");
    });

    it("is idempotent", async () => {
        const h = harness();
        await h.completeHandshake();
        await h.bridge.dispose();
        await expect(h.bridge.dispose()).resolves.toBeUndefined();
        expect(h.child.destroy).toHaveBeenCalledTimes(1);
        expect(state.penpalDestroys).toBe(1);
        expect(h.bridge.state).toBe("disposed");
    });

    it("drops the cached document buffer on final dispose", async () => {
        const h = harness();
        await h.completeHandshake();
        await h.bridge.initReader(
            makeReaderOptions({
                data: { buf: new Uint8Array([1, 2, 3]), url: null },
            }),
        );

        await h.bridge.dispose();

        const internals = h.bridge as unknown as {
            _readerOpts?: unknown;
        };
        expect(internals._readerOpts).toBeUndefined();
    });

    it("still removes the iframe when child cleanup fails", async () => {
        const h = harness();
        await h.completeHandshake();
        h.child.destroy.mockRejectedValue(new Error("child failed"));

        await expect(h.bridge.dispose()).resolves.toBeUndefined();

        expect(state.penpalDestroys).toBe(1);
        expect(h.iframe.removed).toBe(true);
        expect(h.bridge.state).toBe("disposed");
        expect(
            state.logs.some((entry) =>
                entry.message.includes("cleanup did not complete"),
            ),
        ).toBe(true);
    });

    it("releases a connection that is still waiting for child registration", async () => {
        const h = harness();

        await h.bridge.dispose();

        await expect(h.connecting).resolves.toBeUndefined();
        expect(state.penpalDestroys).toBe(1);
        expect(h.iframe.removed).toBe(true);
    });

    it("re-initialises with freshly fetched annotations on reconnect", async () => {
        const h = harness();
        await h.completeHandshake();
        await h.bridge.initReader(makeReaderOptions({ annotations: [] }));
        expect(h.child.initReader).toHaveBeenCalledTimes(1);

        // What the worker will hand back the second time round.
        state.remoteAnnotations.push({ id: "synced-1" });

        const reconnecting = h.bridge.reconnect();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));
        await h.register();
        await reconnecting;

        expect(h.iframes).toHaveLength(2);
        expect(h.child.initReader).toHaveBeenCalledTimes(2);
        expect(h.child.initReader.mock.calls[1]![0].annotations).toEqual([
            { id: "synced-1" },
        ]);
        expect(h.bridge.state).toBe("reader-ready");
    });

    it("reads the local cache instead of the worker on a local reconnect", async () => {
        const localAnnotations = [makeAnnotation("local-1")];
        const h = harness({
            isLocal: true,
            attachment: null,
            localAttachment: { path: "Papers/p.pdf", name: "p.pdf" },
            localDataManager: { getAllAnnotations: () => localAnnotations },
        });
        await h.completeHandshake();
        await h.bridge.initReader(makeReaderOptions({ annotations: [] }));

        const reconnecting = h.bridge.reconnect();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));
        await h.register();
        await reconnecting;

        expect(h.child.initReader.mock.calls[1]![0].annotations).toEqual(
            localAnnotations,
        );
    });

    it("keeps event listeners across a reconnect but drops them on dispose", async () => {
        const h = harness();
        await h.completeHandshake();

        const seen: unknown[] = [];
        h.bridge.onEventType("sidebarToggled", (e) => seen.push(e));

        const reconnecting = h.bridge.reconnect();
        await vi.waitFor(() => expect(h.iframes).toHaveLength(2));
        const parentAfter = await h.register();
        await reconnecting;

        // The reconnect-only disconnect keeps the subscriptions.
        parentAfter.handleEvent({ type: "sidebarToggled", open: true });
        expect(seen).toHaveLength(1);

        await h.bridge.dispose();
        parentAfter.handleEvent({ type: "sidebarToggled", open: false });
        expect(seen).toHaveLength(1);
    });
});

describe("annotation profiles", () => {
    const research = { id: "research", name: "Research", palette: [{ id: "a", color: "#ffd400", label: "Methodology" }] };

    it("keeps simultaneous reader selections independent and restores selection on reconnect", async () => {
        Object.assign(state.settings!, normalizeAnnotationSettings({ annotationProfiles: [research] }));
        const a = harness();
        const parentA = await a.completeHandshake();
        const b = harness({ isLocal: true, localAttachment: { path: "a.pdf", name: "a.pdf" }, localDataManager: { getAllAnnotations: () => [] } });
        await b.completeHandshake();
        await a.bridge.initReader(makeReaderOptions());
        await b.bridge.initReader(makeReaderOptions());
        parentA.handleEvent({ type: "annotationProfileChanged", profileId: "research" });
        expect(b.child.initReader.mock.lastCall![0].annotationProfileConfig!.activeProfileId).toBe("zotero-default");
        expect(state.settings!.defaultAnnotationProfileId).toBe("zotero-default");
        const reconnect = a.bridge.reconnect();
        await vi.waitFor(() => expect(a.iframes).toHaveLength(2));
        await a.register();
        await reconnect;
        expect(a.child.initReader.mock.lastCall![0].annotationProfileConfig!.activeProfileId).toBe("research");
        await a.bridge.dispose();
        await b.bridge.dispose();
    });

    it("updates palettes, falls back after deletion, and unsubscribes on dispose", async () => {
        Object.assign(state.settings!, normalizeAnnotationSettings({ annotationProfiles: [research], defaultAnnotationProfileId: "research" }));
        const h = harness();
        await h.completeHandshake();
        await h.bridge.initReader(makeReaderOptions());
        state.settings!.annotationProfiles[1]!.palette[0]!.label = "Evidence";
        settingsChanged.emit();
        await Promise.resolve();
        expect(h.child.setAnnotationProfileConfig.mock.lastCall![0].profiles[1]!.palette[0]!.label).toBe("Evidence");
        Object.assign(state.settings!, normalizeAnnotationSettings({ ...state.settings, annotationProfiles: [] }));
        settingsChanged.emit();
        await Promise.resolve();
        expect(h.child.setAnnotationProfileConfig.mock.lastCall![0].activeProfileId).toBe("zotero-default");
        expect(h.child.refreshAnnotations).not.toHaveBeenCalled();
        await h.bridge.dispose();
        const count = h.child.setAnnotationProfileConfig.mock.calls.length;
        settingsChanged.emit();
        expect(h.child.setAnnotationProfileConfig).toHaveBeenCalledTimes(count);
    });
});
