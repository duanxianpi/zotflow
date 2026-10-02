/**
 * In-memory Zotero Web API, faked at the HTTP layer.
 *
 * `worker.ts` installs its proxied fetch onto `globalThis.fetch`, and
 * `zotero-api-client` calls that global — so replacing `globalThis.fetch` puts
 * a fake server underneath `SyncService` without touching a line of sync code.
 *
 * Faking here rather than at the service boundary keeps the parts that
 * actually break under test: `Last-Modified-Version` bookkeeping, 412
 * optimistic-locking conflicts, `format=versions` deltas, tombstones, and the
 * request chunking (`PULL_BULK_SIZE`, `UPDATE_BULK_SIZE`).
 *
 * Modelled endpoints:
 *   GET    /keys/current
 *   GET    /users/{id}/groups
 *   GET    /{users|groups}/{id}/items?format=versions&since=N
 *   GET    /{users|groups}/{id}/items?itemKey=A,B,C
 *   GET    /{users|groups}/{id}/collections?format=versions&since=N
 *   GET    /{users|groups}/{id}/collections?collectionKey=A,B,C
 *   GET    /{users|groups}/{id}/deleted?since=N
 *   POST   /{users|groups}/{id}/items
 *   DELETE /{users|groups}/{id}/items/{key}
 *
 * Anything else throws, so an unmodelled call surfaces as a loud failure
 * instead of a silent 404 the code under test may swallow.
 */

const API_HOST = "api.zotero.org";

export interface FakeZoteroItem {
    key: string;
    version: number;
    library: { type: string; id: number; name: string };
    data: Record<string, unknown>;
    csljson?: Record<string, unknown>;
    /** Sent on every response, as the real API does; not stored. */
    meta?: Record<string, unknown>;
}

export interface FakeZoteroCollection {
    key: string;
    version: number;
    library: { type: string; id: number; name: string };
    data: Record<string, unknown>;
}

export interface RecordedRequest {
    method: string;
    url: string;
    path: string;
    query: URLSearchParams;
    headers: Headers;
    body: unknown;
}

/** Forced failure, consumed by the next matching request. */
export interface FailureSpec {
    /** HTTP status to answer with. Ignored when `networkError` is set. */
    status?: number;
    /** Only fail requests whose path contains this substring. */
    pathIncludes?: string;
    /**
     * Only fail requests using this method. Needed to target a write: reads
     * and writes share the /items path, and reads happen first.
     */
    method?: string;
    /**
     * Reject the request instead of answering it, as a dropped connection
     * would. The API client then throws an error with no `.response`, which
     * is a different branch from any HTTP status.
     */
    networkError?: boolean;
    /** Response body. Defaults to a short text message. */
    body?: unknown;
    /** Extra response headers, e.g. `{ "Last-Modified-Version": "9" }`. */
    headers?: Record<string, string>;
}

export interface FakeLibraryHandle {
    readonly id: number;
    readonly type: "user" | "group";
    /** Current library version — bumps on every write. */
    readonly version: number;
    readonly items: Map<string, FakeZoteroItem>;
    readonly collections: Map<string, FakeZoteroCollection>;

    /** Add an item as if written by another client. Bumps the library version. */
    addItem(
        item: { key: string; data?: Record<string, unknown>; csljson?: Record<string, unknown> },
    ): FakeZoteroItem;
    /** Patch an existing item's data. Bumps the library version. */
    updateItem(key: string, data: Record<string, unknown>): FakeZoteroItem;
    /** Delete an item and leave a tombstone. Bumps the library version. */
    deleteItem(key: string): void;

    addCollection(collection: {
        key: string;
        data?: Record<string, unknown>;
    }): FakeZoteroCollection;
    updateCollection(key: string, data: Record<string, unknown>): FakeZoteroCollection;
    deleteCollection(key: string): void;

    /* -- write-outcome controls ---------------------------------------
     * A Zotero write does not answer yes/no per item: the response splits
     * the payload into `successful`, `unchanged` and `failed`, and sync
     * takes a different branch for each. These let a test put a specific
     * key into a specific bucket without hand-rolling a whole response. */

    /** Report `key` under `failed` on the next write that includes it. */
    rejectWrite(key: string, failure: { code: number; message: string }): void;
    /** Report `key` under `unchanged` on the next write that includes it. */
    treatAsUnchanged(key: string): void;
    /**
     * Store a submitted `from` key under `to` instead, echoing the new key
     * back. Models the server declining a client-provided key on create.
     */
    remapKey(from: string, to: string): void;
}

export interface FakeZoteroServerOptions {
    /** Expected `Zotero-API-Key` header. Mismatches get a 403. */
    apiKey?: string;
    /** User id for `/keys/current`. Defaults to 1. */
    userID?: number;
    /** Group ids reported as joined by the key. Defaults to none. */
    joinedGroups?: number[];
    /** Username reported by `/keys/current`. */
    username?: string;
}

export interface FakeZoteroServer {
    /** Get (creating on first use) the state for a library. */
    library(id: number, type?: "user" | "group"): FakeLibraryHandle;
    /** Replace `globalThis.fetch`. Call `restore()` when done. */
    install(): void;
    /** Put the original `globalThis.fetch` back. */
    restore(): void;
    /** Every request the client made, in order. */
    readonly requests: RecordedRequest[];
    /** Requests whose path contains `needle`. */
    requestsFor(needle: string): RecordedRequest[];
    /** Queue a forced failure for the next matching request. */
    failNext(spec: FailureSpec): void;
    /** Clear recorded requests (leaves library state alone). */
    clearRequests(): void;
    /** A deep copy of every library's state, for `loadState`. */
    saveState(): unknown;
    /**
     * Put library state back to a `saveState` copy. Refills the existing
     * collections in place, so `library()` handles stay valid.
     */
    loadState(saved: unknown): void;
}

interface LibraryState {
    id: number;
    type: "user" | "group";
    version: number;
    items: Map<string, FakeZoteroItem>;
    collections: Map<string, FakeZoteroCollection>;
    /** key → library version at the time of deletion. */
    deletedItems: Map<string, number>;
    deletedCollections: Map<string, number>;
    /** Pending write outcomes, each consumed by the first write that hits it. */
    rejects: Map<string, { code: number; message: string }>;
    unchanged: Set<string>;
    keyRemaps: Map<string, string>;
}

function json(body: unknown, version: number, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Last-Modified-Version": String(version),
        },
    });
}

export function createFakeZoteroServer(
    options: FakeZoteroServerOptions = {},
): FakeZoteroServer {
    const apiKey = options.apiKey;
    const userID = options.userID ?? 1;
    const joinedGroups = options.joinedGroups ?? [];

    const libraries = new Map<number, LibraryState>();
    const requests: RecordedRequest[] = [];
    const failures: FailureSpec[] = [];
    let originalFetch: typeof globalThis.fetch | null = null;

    function state(id: number, type: "user" | "group" = "user"): LibraryState {
        let lib = libraries.get(id);
        if (!lib) {
            lib = {
                id,
                type,
                version: 0,
                items: new Map(),
                collections: new Map(),
                deletedItems: new Map(),
                deletedCollections: new Map(),
                rejects: new Map(),
                unchanged: new Set(),
                keyRemaps: new Map(),
            };
            libraries.set(id, lib);
        }
        return lib;
    }

    function libraryStub(lib: LibraryState) {
        return { type: lib.type, id: lib.id, name: `Library ${lib.id}` };
    }

    /* ---------------------------------------------------------------- */
    /*  Test-facing library handle                                      */
    /* ---------------------------------------------------------------- */

    function handle(id: number, type: "user" | "group" = "user"): FakeLibraryHandle {
        const lib = state(id, type);
        return {
            id: lib.id,
            type: lib.type,
            get version() {
                return lib.version;
            },
            items: lib.items,
            collections: lib.collections,

            addItem({ key, data = {}, csljson }) {
                const version = ++lib.version;
                const item: FakeZoteroItem = {
                    key,
                    version,
                    library: libraryStub(lib),
                    data: { key, version, itemType: "journalArticle", ...data },
                    ...(csljson ? { csljson } : {}),
                };
                lib.items.set(key, item);
                lib.deletedItems.delete(key);
                return item;
            },
            updateItem(key, data) {
                const existing = lib.items.get(key);
                if (!existing) throw new Error(`fake server: no item ${key}`);
                const version = ++lib.version;
                const item: FakeZoteroItem = {
                    ...existing,
                    version,
                    data: { ...existing.data, ...data, key, version },
                };
                lib.items.set(key, item);
                return item;
            },
            deleteItem(key) {
                lib.items.delete(key);
                lib.deletedItems.set(key, ++lib.version);
            },

            addCollection({ key, data = {} }) {
                const version = ++lib.version;
                const collection: FakeZoteroCollection = {
                    key,
                    version,
                    library: libraryStub(lib),
                    data: { key, version, name: `Collection ${key}`, parentCollection: false, ...data },
                };
                lib.collections.set(key, collection);
                lib.deletedCollections.delete(key);
                return collection;
            },
            updateCollection(key, data) {
                const existing = lib.collections.get(key);
                if (!existing) throw new Error(`fake server: no collection ${key}`);
                const version = ++lib.version;
                const collection: FakeZoteroCollection = {
                    ...existing,
                    version,
                    data: { ...existing.data, ...data, key, version },
                };
                lib.collections.set(key, collection);
                return collection;
            },
            deleteCollection(key) {
                lib.collections.delete(key);
                lib.deletedCollections.set(key, ++lib.version);
            },

            rejectWrite(key, failure) {
                lib.rejects.set(key, failure);
            },
            treatAsUnchanged(key) {
                lib.unchanged.add(key);
            },
            remapKey(from, to) {
                lib.keyRemaps.set(from, to);
            },
        };
    }

    /* ---------------------------------------------------------------- */
    /*  Routing                                                         */
    /* ---------------------------------------------------------------- */

    function route(req: RecordedRequest): Response {
        const { method, path, query, headers } = req;

        if (apiKey !== undefined && headers.get("Zotero-API-Key") !== apiKey) {
            return json({ message: "Invalid key" }, 0, 403);
        }

        if (path === "/keys/current") {
            return json(
                {
                    key: headers.get("Zotero-API-Key") ?? "",
                    userID,
                    username: options.username ?? "test-user",
                    access: {
                        user: { library: true, files: true, notes: true, write: true },
                        groups: { all: { library: true, write: true } },
                    },
                },
                0,
            );
        }

        const libMatch = /^\/(users|groups)\/(\d+)(\/.*)?$/.exec(path);
        if (!libMatch) {
            throw new Error(`fake zotero server: unmodelled path ${method} ${path}`);
        }

        const type = libMatch[1] === "users" ? "user" : "group";
        const libraryID = Number(libMatch[2]);
        const rest = libMatch[3] ?? "";
        const lib = state(libraryID, type);

        if (rest === "/groups") {
            return json(
                joinedGroups.map((id) => ({
                    id,
                    version: 1,
                    data: { id, name: `Group ${id}`, type: "Private" },
                })),
                lib.version,
            );
        }

        if (rest === "/deleted") {
            const since = Number(query.get("since") ?? 0);
            return json(
                {
                    collections: [...lib.deletedCollections]
                        .filter(([, v]) => v > since)
                        .map(([k]) => k),
                    items: [...lib.deletedItems]
                        .filter(([, v]) => v > since)
                        .map(([k]) => k),
                    searches: [],
                    tags: [],
                    settings: [],
                },
                lib.version,
            );
        }

        if (rest === "/items" || rest === "/collections") {
            const isItems = rest === "/items";
            const store = isItems ? lib.items : lib.collections;

            if (method === "GET") {
                if (query.get("format") === "versions") {
                    const since = Number(query.get("since") ?? 0);
                    const map: Record<string, number> = {};
                    for (const [key, entry] of store) {
                        if (entry.version > since) map[key] = entry.version;
                    }
                    return json(map, lib.version);
                }

                const keyParam = query.get(isItems ? "itemKey" : "collectionKey");
                const wanted = keyParam
                    ? keyParam.split(",").filter(Boolean)
                    : [...store.keys()];
                const include = (query.get("include") ?? "data").split(",");
                const payload = wanted
                    .map((key) => store.get(key))
                    .filter((entry): entry is FakeZoteroItem => Boolean(entry))
                    .map((entry) => {
                        // The real API always sends `meta`; the reader reads
                        // `meta.createdByUser` off every annotation.
                        const out: Record<string, unknown> = {
                            key: entry.key,
                            version: entry.version,
                            library: entry.library,
                            meta: {},
                        };
                        if (include.includes("data")) out.data = entry.data;
                        if (include.includes("csljson") && "csljson" in entry) {
                            out.csljson = entry.csljson;
                        }
                        return out;
                    });
                return json(payload, lib.version);
            }

            if (method === "POST" && isItems) {
                const unmodified = headers.get("If-Unmodified-Since-Version");
                if (unmodified !== null && Number(unmodified) < lib.version) {
                    return json({ message: "Precondition failed" }, lib.version, 412);
                }

                const payload = (req.body ?? []) as Record<string, any>[];
                const successful: Record<string, FakeZoteroItem> = {};
                const success: Record<string, string> = {};
                const unchanged: Record<string, string> = {};
                const failed: Record<
                    string,
                    { code: number; message: string }
                > = {};

                payload.forEach((raw, index) => {
                    const submitted = String(raw.key ?? raw.data?.key ?? "");
                    const slot = String(index);

                    const reject = lib.rejects.get(submitted);
                    if (reject) {
                        lib.rejects.delete(submitted);
                        failed[slot] = reject;
                        return;
                    }

                    // Every object sent consumes a library version, unchanged
                    // ones included — as the real API does (verified live).
                    if (lib.unchanged.has(submitted)) {
                        lib.unchanged.delete(submitted);
                        ++lib.version;
                        unchanged[slot] = submitted;
                        return;
                    }

                    // An update (it carries a version) to an item the server
                    // does not have is a 404, as on the real API; only a
                    // create (no version) may bring a deleted key back.
                    const isUpdate =
                        raw.version !== undefined ||
                        raw.data?.version !== undefined;
                    if (isUpdate && !lib.items.has(submitted)) {
                        failed[slot] = { code: 404, message: "Item not found" };
                        return;
                    }

                    // A child needs its parent on the server, including one
                    // created earlier in this same request.
                    const parent = String(raw.data?.parentItem ?? "");
                    if (parent && !lib.items.has(parent)) {
                        failed[slot] = {
                            code: 400,
                            message: `Parent item ${parent} not found`,
                        };
                        return;
                    }

                    // The server owns the key: it may store the item under a
                    // different one than the client proposed.
                    const key = lib.keyRemaps.get(submitted) ?? submitted;
                    lib.keyRemaps.delete(submitted);

                    const newVersion = ++lib.version;
                    const stored: FakeZoteroItem = {
                        key,
                        version: newVersion,
                        library: libraryStub(lib),
                        data: { ...(raw.data ?? {}), key, version: newVersion },
                    };
                    lib.items.set(key, stored);
                    lib.deletedItems.delete(key);
                    successful[slot] = { ...stored, meta: {} };
                    success[slot] = key;
                });

                return json(
                    { successful, success, unchanged, failed },
                    lib.version,
                );
            }
        }

        const itemKeyMatch = /^\/items\/([A-Za-z0-9]+)$/.exec(rest);
        if (itemKeyMatch && method === "DELETE") {
            const key = itemKeyMatch[1]!;
            const existing = lib.items.get(key);
            if (!existing) {
                return json({ message: "Not found" }, lib.version, 404);
            }
            const unmodified = headers.get("If-Unmodified-Since-Version");
            if (unmodified !== null && Number(unmodified) < existing.version) {
                return json({ message: "Precondition failed" }, lib.version, 412);
            }
            lib.items.delete(key);
            lib.deletedItems.set(key, ++lib.version);
            return new Response(null, {
                status: 204,
                headers: { "Last-Modified-Version": String(lib.version) },
            });
        }

        if (itemKeyMatch && method === "GET") {
            const entry = lib.items.get(itemKeyMatch[1]!);
            if (!entry) return json({ message: "Not found" }, lib.version, 404);
            return json(entry, lib.version);
        }

        throw new Error(
            `fake zotero server: unmodelled route ${method} ${path}${
                query.size ? `?${query}` : ""
            }`,
        );
    }

    /* ---------------------------------------------------------------- */
    /*  fetch shim                                                      */
    /* ---------------------------------------------------------------- */

    const fakeFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const rawUrl =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
        const url = new URL(rawUrl);

        if (url.host !== API_HOST) {
            throw new Error(
                `fake zotero server: unexpected host ${url.host} (only ${API_HOST} is served)`,
            );
        }

        let body: unknown = undefined;
        if (typeof init?.body === "string") {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }

        const record: RecordedRequest = {
            method: (init?.method ?? "GET").toUpperCase(),
            url: rawUrl,
            path: url.pathname,
            query: url.searchParams,
            headers: new Headers(init?.headers),
            body,
        };
        requests.push(record);

        const failureIndex = failures.findIndex(
            (f) =>
                (!f.pathIncludes || record.path.includes(f.pathIncludes)) &&
                (!f.method || f.method.toUpperCase() === record.method),
        );
        if (failureIndex !== -1) {
            const failure = failures.splice(failureIndex, 1)[0]!;
            if (failure.networkError) {
                throw new TypeError(`fetch failed: ${record.path}`);
            }
            const status = failure.status ?? 500;
            return new Response(
                typeof failure.body === "string" || failure.body === undefined
                    ? ((failure.body as string) ?? `Forced ${status}`)
                    : JSON.stringify(failure.body),
                { status, headers: failure.headers },
            );
        }

        return route(record);
    };

    return {
        library: handle,
        saveState() {
            return structuredClone([...libraries.values()]);
        },
        loadState(saved) {
            for (const copy of saved as LibraryState[]) {
                const lib = state(copy.id, copy.type);
                lib.version = copy.version;
                const refill = <K, V>(into: Map<K, V>, from: Map<K, V>) => {
                    into.clear();
                    for (const [k, v] of from) into.set(k, structuredClone(v));
                };
                refill(lib.items, copy.items);
                refill(lib.collections, copy.collections);
                refill(lib.deletedItems, copy.deletedItems);
                refill(lib.deletedCollections, copy.deletedCollections);
                refill(lib.rejects, copy.rejects);
                refill(lib.keyRemaps, copy.keyRemaps);
                lib.unchanged.clear();
                for (const k of copy.unchanged) lib.unchanged.add(k);
            }
        },
        install() {
            if (originalFetch) throw new Error("fake zotero server already installed");
            originalFetch = globalThis.fetch;
            globalThis.fetch = fakeFetch;
        },
        restore() {
            if (originalFetch) globalThis.fetch = originalFetch;
            originalFetch = null;
        },
        requests,
        requestsFor: (needle) => requests.filter((r) => r.path.includes(needle)),
        failNext: (spec) => {
            failures.push(spec);
        },
        clearRequests: () => {
            requests.length = 0;
        },
    };
}
