// Shared helpers for the live sync tests (`npm run live:sync`).
//
// Each test drives the real plugin in the isolated test Obsidian
// (`npm run live:obsidian -- launch`) against the real Zotero test library
// (`fixtureLibrary` in .obsidian-test/config.json). The page is reached
// through one Playwright connection per test file (`session()`), shared with
// the UI tests in tests/live/app and closed when the file's tests end.
//
//   - `reset()` puts both sides in a known state: `live:fixtures apply` on the
//     server, then the local copy of the library is cleared and fully synced.
//   - `inObsidian(fn, ...args)` runs `fn(t, h, ...args)` in the main window,
//     where `t` is `window.__zotflowTest` (worker bridge + ParentHost, see
//     src/dev/test-hooks.ts) and `h` holds page helpers (IndexedDB access,
//     request log). Arguments and the result must be JSON.
//   - `remote.*` acts as another Zotero client, straight against the API.
//   - `pauseAt(match)` holds the worker's next matching request so a test can
//     act while it is in flight, then let it through, drop its answer after
//     the server applied it ("lost"), or fail it before it is sent.
//
// The API key is read from .obsidian-test/config.json or
// ZOTFLOW_TEST_API_KEY. It is never printed; the page side uses the key the
// plugin already holds.

import { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import spec from "../../../scripts/fixture-library.mjs";
import { Harness, loadConfig } from "../../../scripts/obsidian-harness.mjs";
import {
    ZoteroClient,
    applyPlan,
    buildDesired,
    fixtureKey,
    plan,
    planIsEmpty,
} from "../../../scripts/zotero-fixtures-lib.mjs";

export const config = loadConfig();
if (!config.apiKey) throw new Error("Set zoteroApiKey in .obsidian-test/config.json");
if (!config.fixtureLibrary?.startsWith("groups/")) {
    throw new Error('Live sync tests need a dedicated group: "fixtureLibrary": "groups/<id>"');
}

export const LIBRARY = config.fixtureLibrary;
export const LIBRARY_ID = Number(LIBRARY.split("/")[1]);
export const key = fixtureKey;

const client = new ZoteroClient({ apiKey: config.apiKey, library: LIBRARY });
const desired = buildDesired(spec);

/* ------------------------------------------------------------------ */
/*  Page side                                                         */
/* ------------------------------------------------------------------ */

let connecting;

/**
 * The Playwright connection to the test Obsidian: `{ browser, context, page }`.
 * Opened on first use and shared by everything in this process.
 */
export function session() {
    connecting ??= new Harness(config).playwright();
    return connecting;
}

// One connection per test file: drop it once the file's tests are done, so
// the process can exit. Obsidian keeps running.
after(async () => {
    if (connecting) await (await connecting).disconnect();
});

/**
 * Installs `window.__zfLive`, the page helpers every evaluation gets as `h`.
 * Runs in the page (Playwright serializes it), so it must not close over
 * anything here.
 */
function installPageHelpers() {
    if (window.__zfLive) return;
    const DB = "zotflow-dev";
    const open = () => new Promise((ok, fail) => {
        const r = indexedDB.open(DB);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
    });
    const done = (req) => new Promise((ok, fail) => {
        req.onsuccess = () => ok(req.result);
        req.onerror = () => fail(req.error);
    });
    async function withStore(name, mode, fn) {
        const db = await open();
        try {
            const tx = db.transaction(name, mode);
            const out = await fn(tx.objectStore(name));
            await new Promise((ok, fail) => {
                tx.oncomplete = ok;
                tx.onerror = () => fail(tx.error);
                tx.onabort = () => fail(tx.error);
            });
            return out;
        } finally {
            db.close();
        }
    }
    window.__zfLive = {
        row: (lib, key) => withStore("items", "readonly", (s) => done(s.get([lib, key]))),
        rows: (lib) => withStore("items", "readonly", async (s) =>
            (await done(s.getAll())).filter((r) => r.libraryID === lib)),
        put: (row) => withStore("items", "readwrite", (s) => done(s.put(row))),
        library: (lib) => withStore("libraries", "readonly", (s) => done(s.get(lib))),
        async clearLibrary(lib) {
            for (const name of ["items", "collections"]) {
                await withStore(name, "readwrite", async (s) => {
                    for (const r of await done(s.getAll())) {
                        if (r.libraryID === lib) await done(s.delete([r.libraryID, r.key]));
                    }
                });
            }
            await withStore("libraries", "readwrite", async (s) => {
                const row = await done(s.get(lib));
                if (row) await done(s.put({ ...row, itemVersion: 0, collectionVersion: 0 }));
            });
        },
        apiKey: () => window.app.plugins.plugins.zotflow.settings.zoteroapikey,
    };
}

/** Run `fn(t, h, ...args)` in Obsidian's main window and return its result. */
export async function inObsidian(fn, ...args) {
    const { page } = await session();
    await page.evaluate(installPageHelpers);
    // A string expression rather than a function: `fn` arrives as source and
    // is spliced in, which needs no eval in the page.
    return page.evaluate(`(async () => {
        const t = window.__zotflowTest;
        if (!t) throw new Error("Test hooks are off: run tests via npm run live:sync");
        return await (${fn.toString()})(t, window.__zfLive, ...${JSON.stringify(args)});
    })()`);
}

/** Make sure the instance runs with the test hooks on. */
export async function ensureHooks() {
    const { page } = await session();
    const on = await page.evaluate(
        () => window.app.loadLocalStorage("zotflow-test-hooks") === "1" && !!window.__zotflowTest,
    );
    if (on) return;
    await page.evaluate(async () => {
        window.app.saveLocalStorage("zotflow-test-hooks", "1");
        await window.app.plugins.disablePlugin("zotflow");
        await window.app.plugins.enablePlugin("zotflow");
    });
    await page
        .waitForFunction(() => !!window.__zotflowTest, null, { timeout: 30000 })
        .catch(() => {
            throw new Error("Test hooks did not come up after reloading the plugin");
        });
}

/* ------------------------------------------------------------------ */
/*  Local operations (through the plugin's real services)             */
/* ------------------------------------------------------------------ */

export const local = {
    /** One full sync run; resolves when it finished. */
    sync: () => inObsidian((t) => t.bridge.sync.startSync()),
    row: (k) => inObsidian((t, h, lib, k) => h.row(lib, k), LIBRARY_ID, k),
    rows: () => inObsidian((t, h, lib) => h.rows(lib), LIBRARY_ID),
    library: () => inObsidian((t, h, lib) => h.library(lib), LIBRARY_ID),
    setTags: (k, tags) =>
        inObsidian((t, h, lib, k, tags) => t.bridge.tag.setItemTags(lib, k, tags), LIBRARY_ID, k, tags),
    /** Note body from markdown. `editor` origin: no source-note re-render. */
    editNote: (k, markdown) =>
        inObsidian(
            (t, h, lib, k, md) => t.bridge.itemNote.updateNoteContent(lib, k, md, "editor"),
            LIBRARY_ID, k, markdown,
        ),
    createNote: (parentKey) =>
        inObsidian((t, h, lib, p) => t.bridge.itemNote.createChildNote(lib, p), LIBRARY_ID, parentKey),
    deleteNote: (k) =>
        inObsidian((t, h, lib, k) => t.bridge.itemNote.deleteNote(lib, k), LIBRARY_ID, k),
    editAnnotationComment: (k, markdown) =>
        inObsidian(
            (t, h, lib, k, md) => t.bridge.annotation.updateAnnotationComment(lib, k, md),
            LIBRARY_ID, k, markdown,
        ),
    /** Delete annotations the way the reader does. */
    deleteAnnotations: (attachmentKey, keys) =>
        inObsidian(async (t, h, lib, a, keys) => {
            const attachment = await t.bridge.dbHelper.getAttachmentItem(lib, a);
            await t.bridge.annotation.deleteAnnotations(attachment, keys);
        }, LIBRARY_ID, attachmentKey, keys),
    /** Create an annotation the way the reader does: a copy of `templateKey` with a new id. */
    createAnnotation: (attachmentKey, templateKey, newKey, comment) =>
        inObsidian(async (t, h, lib, a, tmpl, id, comment) => {
            const attachment = await t.bridge.dbHelper.getAttachmentItem(lib, a);
            const keyInfo = await t.bridge.annotation.getKeyInfo(h.apiKey());
            const all = await t.bridge.annotation.getAnnotations(attachment, h.apiKey());
            const template = all.find((x) => x.id === tmpl);
            if (!template) throw new Error(`No annotation ${tmpl} under ${a}`);
            const json = { ...template, id, comment, dateModified: new Date().toISOString() };
            await t.bridge.annotation.saveAnnotations(attachment, keyInfo, [...all, json]);
        }, LIBRARY_ID, attachmentKey, templateKey, newKey, comment),
    conflicts: () => inObsidian((t) => t.bridge.conflict.getItemConflicts()),
    resolve: (k, action) =>
        inObsidian((t, h, lib, k, action) => t.bridge.conflict.resolveItemConflict(lib, k, action), LIBRARY_ID, k, action),
    /** Write a row as-is: for states the services cannot produce on demand. */
    putRow: (row) => inObsidian((t, h, row) => h.put(row), row),
};

/* ------------------------------------------------------------------ */
/*  Request interception                                              */
/* ------------------------------------------------------------------ */

/**
 * Install a recorder (and optionally a pause) on ParentHost.request. Every
 * worker request is logged as `{ method, url, status | error }`. The first
 * request matching `pause` (`{ method?, url? }`, url is a regex source) is
 * held until `release(action)`.
 */
export function intercept(pause) {
    return inObsidian((t, h, pause) => {
        const host = t.parentHost;
        if (!host.__original) host.__original = host.request;
        const original = host.__original.bind(host);
        const state = (window.__zfNet = { log: [], pause, paused: null });
        host.request = async (req) => {
            const method = (req.method ?? "GET").toUpperCase();
            const entry = { method, url: req.url };
            state.log.push(entry);
            const p = state.pause;
            if (p && (!p.method || p.method === method) && (!p.url || new RegExp(p.url).test(req.url))) {
                state.pause = null;
                const action = await new Promise((release) => {
                    state.paused = { method, url: req.url, release };
                });
                state.paused = null;
                if (action === "not-sent") {
                    entry.error = "not-sent";
                    throw new Error("Network Error: injected (not sent)");
                }
                const res = await original(req);
                entry.status = res.status;
                if (action === "lost") {
                    entry.error = "answer lost";
                    throw new Error("Network Error: injected (answer lost)");
                }
                return res;
            }
            try {
                const res = await original(req);
                entry.status = res.status;
                const headers = Object.fromEntries(
                    Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
                );
                if (headers["last-modified-version"]) entry.version = Number(headers["last-modified-version"]);
                return res;
            } catch (e) {
                entry.error = String(e);
                throw e;
            }
        };
        return true;
    }, pause ?? null);
}

/** Restore ParentHost.request. */
export const stopIntercepting = () =>
    inObsidian((t) => {
        const host = t.parentHost;
        if (host.__original) host.request = host.__original;
        delete host.__original;
        return true;
    });

/** The requests seen since `intercept()`. */
export const requests = () => inObsidian(() => window.__zfNet?.log ?? []);

/** Writes (non-GET) seen since `intercept()`, as `METHOD path`. */
export async function writes() {
    return (await requests())
        .filter((r) => r.method !== "GET")
        .map((r) => `${r.method} ${new URL(r.url).pathname.replace(/^\/groups\/\d+/, "")}${r.status ? ` → ${r.status}` : ""}${r.error ? ` (${r.error})` : ""}`);
}

/** Wait until the paused request is being held; returns `{ method, url }`. */
export async function waitForPause(timeoutMs = 60000) {
    const { page } = await session();
    const held = await page
        .waitForFunction(
            () => window.__zfNet?.paused && { method: window.__zfNet.paused.method, url: window.__zfNet.paused.url },
            null,
            { timeout: timeoutMs, polling: 100 },
        )
        .catch(() => {
            throw new Error("No request reached the pause point");
        });
    return held.jsonValue();
}

/** Let the held request continue: "pass", "lost" or "not-sent". */
export const release = (action) =>
    inObsidian((t, h, action) => {
        window.__zfNet.paused.release(action);
        return true;
    }, action);

/**
 * Sync with the first request matching `match` paused; `during(paused)` runs
 * while it is held, then it continues with `action`.
 */
export async function syncWithPause(match, action, during = async () => {}) {
    await intercept(match);
    const run = local.sync();
    const paused = await waitForPause();
    await during(paused);
    await release(action);
    await run;
    return paused;
}

/* ------------------------------------------------------------------ */
/*  Remote operations (another client, straight to the API)           */
/* ------------------------------------------------------------------ */

const API = `https://api.zotero.org/${LIBRARY}`;

async function api(method, path, { headers = {}, body } = {}) {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${API}${path}`, {
            method,
            headers: {
                "Zotero-API-Key": config.apiKey,
                "Zotero-API-Version": "3",
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if ((res.status === 429 || res.status === 503) && attempt < 5) {
            await sleep(Number(res.headers.get("Retry-After") ?? 2 ** attempt) * 1000);
            continue;
        }
        const backoff = Number(res.headers.get("Backoff") ?? 0);
        if (backoff > 0) await sleep(backoff * 1000);
        return res;
    }
}

export const remote = {
    /** `{ key, version, data }`, or null if the server has no such item. */
    async get(k) {
        const res = await api("GET", `/items/${k}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GET ${k} → ${res.status}`);
        const j = await res.json();
        return { key: j.key, version: j.version, data: j.data };
    },
    async libraryVersion() {
        const res = await api("GET", "/items?limit=1&format=versions");
        return Number(res.headers.get("Last-Modified-Version"));
    },
    /** Change some fields of an item; returns the new library version. */
    async patch(k, fields) {
        const item = await remote.get(k);
        if (!item) throw new Error(`patch: ${k} not on server`);
        const res = await api("PATCH", `/items/${k}`, {
            headers: { "If-Unmodified-Since-Version": String(item.version) },
            body: fields,
        });
        if (res.status !== 204) throw new Error(`PATCH ${k} → ${res.status} ${await res.text()}`);
        return Number(res.headers.get("Last-Modified-Version"));
    },
    /** Delete an item (Zotero deletes its children with it). */
    async delete(k) {
        const item = await remote.get(k);
        if (!item) return;
        const res = await api("DELETE", `/items/${k}`, {
            headers: { "If-Unmodified-Since-Version": String(item.version) },
        });
        if (res.status !== 204) throw new Error(`DELETE ${k} → ${res.status} ${await res.text()}`);
    },
    /** Raw multi-write, for probing server behaviour; returns status and body. */
    async post(objects, headers = {}) {
        const res = await api("POST", "/items", { headers, body: objects });
        return { status: res.status, version: Number(res.headers.get("Last-Modified-Version")), body: await res.json().catch(() => null) };
    },
    async children(k) {
        const res = await api("GET", `/items/${k}/children?includeTrashed=1`);
        if (!res.ok) return [];
        return (await res.json()).map((c) => c.key);
    },
};

/* ------------------------------------------------------------------ */
/*  Reset                                                             */
/* ------------------------------------------------------------------ */

/** Server back to the fixture set; local library cleared and fully synced. */
export async function reset() {
    await ensureHooks();
    await stopIntercepting();
    const p = plan(desired, await client.snapshot());
    if (!planIsEmpty(p)) await applyPlan(client, p);
    const after = plan(desired, await client.snapshot());
    if (!planIsEmpty(after)) throw new Error("Fixture library did not reset cleanly");
    await inObsidian((t, h, lib) => h.clearLibrary(lib), LIBRARY_ID);
    await local.sync();
    const conflicts = await local.conflicts();
    if (conflicts.length > 0) throw new Error(`Reset left ${conflicts.length} conflicts`);
}

/* ------------------------------------------------------------------ */
/*  Facts for the report                                              */
/* ------------------------------------------------------------------ */

import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { LOCAL_DIR } from "../../../scripts/obsidian-harness.mjs";

const FACTS_DIR = join(LOCAL_DIR, "live-sync");
mkdirSync(FACTS_DIR, { recursive: true });

/** Record an observation of real server behaviour for the report. */
export function fact(file, name, value) {
    appendFileSync(
        join(FACTS_DIR, "facts.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), file: basename(file), name, value })}\n`,
    );
}
