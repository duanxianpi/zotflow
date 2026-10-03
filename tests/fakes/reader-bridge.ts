import type { AnnotationProfileConfig } from "utils/annotation-profiles";
/**
 * Fakes for driving `IframeReaderBridge` without a browser.
 *
 * The bridge only ever reaches the outside world through three seams, and all
 * three are replaceable from a Node runner:
 *
 *  1. It creates its iframe via `container.ownerDocument.createElement`, so a
 *     fake container decides what an "iframe" is.
 *  2. penpal delivers exactly one inbound call — `shakehand`. Everything after
 *     that travels over direct object references the bridge installs on the
 *     child window (`__OBSIDIAN_BRIDGE__`), which need no transport at all.
 *  3. `getBlobUrls()`, `services` and `workerBridge` are module singletons.
 *
 * The `vi.mock` calls for (2) and (3) have to live in the test file — they are
 * hoisted above imports. This module owns everything else: the fake DOM, the
 * fake reader child, and the handshake choreography.
 *
 * See `tests/integration/reader-bridge.test.ts` for the wiring.
 */
import { expect, vi } from "vitest";

import type {
    AnnotationJSON,
    ChildAPI,
    CreateReaderOptions,
    ParentAPI,
} from "types/zotero-reader";
import type { ZotFlowSettings } from "settings/types";
// Type-only, so it is fully erased — this module never triggers a runtime load
// of the file under test, which would race the test file's `vi.mock` calls.
import type { IframeReaderBridge } from "ui/reader/bridge";

/* ------------------------------------------------------------------ */
/*  Shared mutable state                                              */
/* ------------------------------------------------------------------ */

/**
 * What the mocked singletons read. The test file creates this inside
 * `vi.hoisted` (so the mock factories can close over it) and resets it per
 * test; `resetReaderBridgeState` does the resetting.
 */
export interface ReaderBridgeState {
    /** The `methods` object the bridge handed penpal's `connect()`. */
    penpalMethods: null | { shakehand: () => Promise<void> };
    /** Number of penpal connections explicitly destroyed by the bridge. */
    penpalDestroys: number;
    settings: null | ZotFlowSettings;
    /** zotero-key -> note path, backing `indexService.getFileByKey`. */
    notesByKey: Map<string, string>;
    logs: Array<{ level: string; message: string }>;
    /** Everything written to `navigator.clipboard`, in order. */
    clipboard: string[];
    /** What `citationService.resolve` returns. */
    citationResult: null | { citation: string; footnoteDef?: string };
    /** What `workerBridge.annotation.getAnnotations` returns. */
    remoteAnnotations: unknown[];
    /**
     * How many times the bridge asked the worker for annotations. A reconnect
     * should cost exactly one fetch — a superseded `connect()` that keeps
     * running would double it.
     */
    annotationFetches: number;
}

export function resetReaderBridgeState(
    state: ReaderBridgeState,
    settings: ZotFlowSettings,
) {
    state.penpalMethods = null;
    state.penpalDestroys = 0;
    state.settings = settings;
    state.notesByKey.clear();
    state.logs.length = 0;
    state.clipboard.length = 0;
    state.citationResult = null;
    state.remoteAnnotations.length = 0;
    state.annotationFetches = 0;
}

/* ------------------------------------------------------------------ */
/*  Fake DOM                                                          */
/* ------------------------------------------------------------------ */

/**
 * The bits of the loaded document the `onload` handler touches: it stamps
 * theme classes on `documentElement`. Records rather than applies.
 */
export interface FakeIframeDocument {
    /** Class name -> present, as left by `classList.toggle(name, force)`. */
    classes: Map<string, boolean>;
    attributes: Map<string, string>;
    documentElement: {
        classList: { toggle: (name: string, force: boolean) => void };
        setAttribute: (name: string, value: string) => void;
    };
}

function createFakeIframeDocument(): FakeIframeDocument {
    const classes = new Map<string, boolean>();
    const attributes = new Map<string, string>();
    return {
        classes,
        attributes,
        documentElement: {
            classList: {
                toggle: (name: string, force: boolean) =>
                    void classes.set(name, force),
            },
            setAttribute: (name: string, value: string) =>
                void attributes.set(name, value),
        },
    };
}

export interface FakeIframe {
    id: string;
    src: string;
    srcdoc: string;
    /** The bridge installs `__OBSIDIAN_BRIDGE__` here. */
    contentWindow: Record<string, unknown> & {
        parent: { document: { body: object } };
    };
    contentDocument: FakeIframeDocument;
    sandbox: { add: (token: string) => void; added: string[] };
    cssStyles: Record<string, string>;
    setCssStyles: (styles: Record<string, string>) => void;
    /** Fire this to replay what a browser does when the iframe (re)loads. */
    onload: null | (() => void);
    /** How many times `onload` has fired on this element. */
    loadCount: number;
    remove: () => void;
    removed: boolean;
}

export function createFakeIframe(): FakeIframe {
    const added: string[] = [];
    const iframe: FakeIframe = {
        id: "",
        src: "",
        srcdoc: "",
        // `parent.document.body` is what the "follow Obsidian" theme path reads
        // the computed color-scheme off.
        contentWindow: { parent: { document: { body: {} } } },
        contentDocument: createFakeIframeDocument(),
        sandbox: { added, add: (token: string) => added.push(token) },
        cssStyles: {},
        setCssStyles(styles) {
            Object.assign(iframe.cssStyles, styles);
        },
        onload: null,
        loadCount: 0,
        remove() {
            iframe.removed = true;
        },
        removed: false,
    };
    return iframe;
}

/** Fire the element's load handler, as a browser would, and count it. */
export function fireLoad(iframe: FakeIframe) {
    iframe.loadCount++;
    iframe.onload?.();
}

/** Records what the reader was told to put on a drag. */
export function createFakeDataTransfer() {
    const data = new Map<string, string>();
    return {
        data,
        setData: (mime: string, value: string) => data.set(mime, value),
        getData: (mime: string) => data.get(mime) ?? "",
    };
}

/**
 * A container whose `createElement` hands out a fresh fake iframe each call,
 * and whose `replaceChildren` fires that iframe's initial `load` — the way a
 * browser starts loading only once the element is in the document.
 *
 * Firing synchronously on insert is a deliberate simplification: the bridge has
 * no ordering dependency between `load` and the penpal handshake (that is the
 * point of counting loads rather than inspecting state), so modelling the real
 * asynchronous gap would buy nothing and cost determinism. What matters is that
 * every iframe gets exactly one load for free, so an *extra* load — the
 * split/pop-out reparent — is what the bridge reacts to.
 */
export function createFakeContainer() {
    const iframes: FakeIframe[] = [];
    const container = {
        ownerDocument: {
            createElement: () => {
                const created = createFakeIframe();
                iframes.push(created);
                return created;
            },
        },
        replaceChildren: (el: FakeIframe) => fireLoad(el),
    };
    return { container, iframes };
}

/** A container element for the markdown-render path. */
export function createFakeRenderTarget() {
    const calls = { emptied: 0, classes: [] as string[] };
    return {
        calls,
        el: {
            empty: () => calls.emptied++,
            addClass: (c: string) => calls.classes.push(c),
        },
    };
}

/* ------------------------------------------------------------------ */
/*  Fake reader child                                                 */
/* ------------------------------------------------------------------ */

/** The reader side of the contract: every `ChildAPI` method, recorded. */
export function createFakeChild() {
    return {
        initReader: vi.fn((_opts: CreateReaderOptions) =>
            Promise.resolve(true),
        ),
        setAnnotationProfileConfig: vi.fn((_config: AnnotationProfileConfig) => Promise.resolve(true)),
        setColorScheme: vi.fn(() => Promise.resolve(true)),
        addAnnotation: vi.fn((_a: AnnotationJSON) => Promise.resolve(true)),
        refreshAnnotations: vi.fn((_a: AnnotationJSON[]) =>
            Promise.resolve(true),
        ),
        navigate: vi.fn((_n: unknown) => Promise.resolve(true)),
        destroy: vi.fn(() => Promise.resolve(true)),
    };
}

export type FakeChild = ReturnType<typeof createFakeChild>;

/** The bootstrap the bridge installs on the child window. */
type Bootstrap = () => {
    token: string;
    parent: ParentAPI;
    register: (childAPI: ChildAPI, token: string) => Promise<{ ok: boolean }>;
};

/* ------------------------------------------------------------------ */
/*  Test data                                                         */
/* ------------------------------------------------------------------ */

/** A cloud attachment whose parent item is a separate record. */
export const ATTACHMENT = {
    localID: 1,
    libraryID: 7,
    key: "ATTACHKEY",
    parentItem: "PARENTKEY",
    itemType: "attachment",
    version: 1,
    trashed: 0,
    syncStatus: "synced",
    data: {},
};

/** Smallest thing the reader will accept as an annotation. */
export function makeAnnotation(
    id: string,
    overrides: Partial<AnnotationJSON> = {},
): AnnotationJSON {
    return {
        id,
        type: "highlight",
        position: { pageIndex: 0, rects: [] },
        tags: [],
        dateAdded: "2026-01-01T00:00:00Z",
        dateModified: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

/** A `CreateReaderOptions` that carries no real document. */
export function makeReaderOptions(
    overrides: Partial<CreateReaderOptions> = {},
): CreateReaderOptions {
    return {
        data: { buf: null, url: "blob:doc" },
        type: "pdf",
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/*  Harness                                                           */
/* ------------------------------------------------------------------ */

/**
 * The `IframeReaderBridge` constructor, with the three test doubles widened to
 * `unknown` so a caller can pass a minimal stand-in for an `IDBZoteroItem`, a
 * `TFile` or a `LocalDataManager`.
 */
type BridgeConstructor = new (
    container: HTMLElement,
    isLocal: boolean,
    attachmentItem?: unknown,
    localAttachment?: unknown,
    localDataManager?: unknown,
) => IframeReaderBridge;

export interface ReaderBridgeHarnessOptions {
    isLocal?: boolean;
    /** Pass `null` for a bridge with no attachment item at all. */
    attachment?: unknown;
    localAttachment?: { path: string; name: string };
    localDataManager?: { getAllAnnotations: () => AnnotationJSON[] };
}

export interface ReaderBridgeHarness {
    bridge: IframeReaderBridge;
    /** The most recently created iframe — a reconnect makes a new one. */
    readonly iframe: FakeIframe;
    iframes: FakeIframe[];
    child: FakeChild;
    /** The parent half of the handshake; returns the installed bootstrap. */
    shakehand: () => Promise<ReturnType<Bootstrap>>;
    /** shakehand + register, without waiting for `connect()` to settle. */
    register: () => Promise<ParentAPI>;
    /** shakehand + register, then wait for `connect()`. */
    completeHandshake: () => Promise<ParentAPI>;
    /**
     * What Obsidian does when the panel holding the reader is split or popped
     * out: the element survives, the browser reloads it. Fires a second `load`
     * on the current iframe.
     */
    reparent: () => void;
    /** The in-flight `connect()` promise. */
    connecting: Promise<void>;
}

/**
 * Constructs a bridge against fake DOM and starts `connect()`. The returned
 * handshake helpers play the reader's part.
 *
 * `connect()` is deliberately left pending: it does not resolve until the child
 * registers, which is what `shakehand`/`register` are for.
 */
export function createReaderBridgeHarness(
    BridgeCtor: BridgeConstructor,
    state: ReaderBridgeState,
    options: ReaderBridgeHarnessOptions = {},
): ReaderBridgeHarness {
    const {
        isLocal = false,
        attachment = ATTACHMENT,
        localAttachment,
        localDataManager,
    } = options;

    const { container, iframes } = createFakeContainer();

    const bridge = new BridgeCtor(
        container as unknown as HTMLElement,
        isLocal,
        attachment ?? undefined,
        localAttachment,
        localDataManager,
    );
    const child = createFakeChild();

    const connecting = bridge.connect();

    const shakehand = async () => {
        await vi.waitFor(() => expect(state.penpalMethods).not.toBeNull());
        await state.penpalMethods!.shakehand();
        const bootstrap = iframes.at(-1)!.contentWindow[
            "__OBSIDIAN_BRIDGE__"
        ] as Bootstrap;
        expect(typeof bootstrap).toBe("function");
        return bootstrap();
    };

    const register = async () => {
        const { token, parent, register: doRegister } = await shakehand();
        // The fake child is structurally a `ChildAPI` — no cast needed, which
        // is the point: adding a method to the contract breaks this line.
        await doRegister(child, token);
        return parent;
    };

    const completeHandshake = async () => {
        const parent = await register();
        await connecting;
        return parent;
    };

    return {
        bridge,
        get iframe() {
            return iframes.at(-1)!;
        },
        iframes,
        child,
        shakehand,
        register,
        completeHandshake,
        reparent: () => fireLoad(iframes.at(-1)!),
        connecting,
    };
}
