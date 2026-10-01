// Shared plumbing for driving an isolated Obsidian over the Chrome DevTools
// Protocol: local config, plugin install, launch, and a minimal CDP client.
// Used by obsidian-test.mjs and obsidian-memory-watch.mjs.
//
// Everything machine-specific lives in the gitignored `.obsidian-test/`
// directory at the repo root:
//
//   .obsidian-test/config.json   paths and port (written by `setup`, editable)
//   .obsidian-test/vault/        default test vault
//   .obsidian-test/profile/      Obsidian --user-data-dir (settings, IndexedDB)
//
// Environment variables override the config file:
//   ZF_OBSIDIAN_PATH, ZF_TEST_VAULT, ZF_TEST_PROFILE, ZF_TEST_PORT,
//   ZOTFLOW_TEST_API_KEY, ZOTFLOW_TEST_LIBRARY

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    linkSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_DIR = join(REPO_ROOT, ".obsidian-test");
export const CONFIG_PATH = join(LOCAL_DIR, "config.json");
export const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];
export const DEFAULT_PORT = 9223;
// Obsidian opens the vaults marked open in obsidian.json; this id is ours.
const VAULT_ID = "2f0c7e1a9b3d4c55";

/** Obsidian's executable for a platform, or null when there is no standard location. */
export function defaultObsidianPath(
    platform = process.platform,
    env = process.env,
) {
    if (platform === "darwin") {
        return "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
    }
    if (platform === "win32" && env.LOCALAPPDATA) {
        return join(env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.exe");
    }
    // Linux installs vary (AppImage, Flatpak, .deb, Snap); require config.
    return null;
}

export function pluginId() {
    const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, "manifest.json"), "utf8"),
    );
    return manifest.id;
}

function readConfigFile() {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/** Effective configuration: env > config.json > defaults. */
export function loadConfig(env = process.env) {
    const file = readConfigFile();
    return {
        obsidianPath:
            env.ZF_OBSIDIAN_PATH ?? file.obsidianPath ?? defaultObsidianPath(),
        vaultPath: resolve(
            REPO_ROOT,
            env.ZF_TEST_VAULT ?? file.vaultPath ?? ".obsidian-test/vault",
        ),
        profileDir: resolve(
            REPO_ROOT,
            env.ZF_TEST_PROFILE ?? file.profileDir ?? ".obsidian-test/profile",
        ),
        port: Number(env.ZF_TEST_PORT ?? file.port ?? DEFAULT_PORT),
        apiKey: env.ZOTFLOW_TEST_API_KEY ?? file.zoteroApiKey ?? null,
        // "groups/<id>" (recommended) or "users/<id>"; used by `npm run live:fixtures`.
        fixtureLibrary: env.ZOTFLOW_TEST_LIBRARY ?? file.fixtureLibrary ?? null,
    };
}

export function saveConfig(patch) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    const next = { ...readConfigFile(), ...patch };
    writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 4)}\n`);
    return next;
}

export function pluginDir(config, id = pluginId()) {
    return join(config.vaultPath, ".obsidian", "plugins", id);
}

/**
 * Hard-link the build output into the vault's plugin folder. A write to the
 * repo file is a write to the vault file, so hot-reload sees every rebuild
 * (it does not follow symlinks). Anything that replaces a file instead of
 * rewriting it (git checkout, an editor's atomic save) silently breaks the
 * link, so this re-checks inodes and repairs; it runs on launch, reload and
 * dev. Where a hard link is impossible (vault on another volume) it copies.
 * Returns the names that were (re)linked or copied.
 */
export function installPluginFiles(config, link = linkSync) {
    const dir = pluginDir(config);
    mkdirSync(dir, { recursive: true });
    // Marks the folder for hot-reload.
    writeFileSync(join(dir, ".hotreload"), "");
    const written = [];
    for (const name of PLUGIN_FILES) {
        const source = join(REPO_ROOT, name);
        if (!existsSync(source)) continue;
        const target = join(dir, name);
        if (existsSync(target)) {
            const a = statSync(source);
            const b = statSync(target);
            if (a.dev === b.dev && a.ino === b.ino) continue;
        }
        rmSync(target, { force: true });
        try {
            link(source, target);
        } catch (e) {
            if (e?.code !== "EXDEV" && e?.code !== "EPERM") throw e;
            copyFileSync(source, target);
        }
        written.push(name);
    }
    return written;
}

// pjeby/hot-reload: reloads plugins whose main.js/styles.css change on disk.
// Pinned and checksummed; bump all three together.
export const HOT_RELOAD = {
    id: "hot-reload",
    version: "0.3.1",
    files: {
        "main.js":
            "41e1aa3841c08fe789160fae73f24b723d30e18f9ed5cda55c49110ce02d7601",
        "manifest.json":
            "62bab306528e1ba54382417f1cb6b78ae1e4e9a00e3169b812818949273d32f8",
    },
};

/** Download hot-reload into the vault unless the pinned version is present. */
export async function installHotReload(config, fetchImpl = fetch) {
    const dir = pluginDir(config, HOT_RELOAD.id);
    const verified = (name, bytes) =>
        createHash("sha256").update(bytes).digest("hex") ===
        HOT_RELOAD.files[name];
    const present = Object.keys(HOT_RELOAD.files).every((name) => {
        const path = join(dir, name);
        return existsSync(path) && verified(name, readFileSync(path));
    });
    if (present) return false;

    const downloads = {};
    for (const name of Object.keys(HOT_RELOAD.files)) {
        const url = `https://github.com/pjeby/hot-reload/releases/download/${HOT_RELOAD.version}/${name}`;
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!verified(name, bytes)) {
            throw new Error(`Checksum mismatch for hot-reload ${name}`);
        }
        downloads[name] = bytes;
    }
    mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of Object.entries(downloads)) {
        writeFileSync(join(dir, name), bytes);
    }
    return true;
}

/** Create the vault skeleton with the plugins enabled. Never touches existing notes. */
export function scaffoldVault(config) {
    const obsidianDir = join(config.vaultPath, ".obsidian");
    mkdirSync(obsidianDir, { recursive: true });
    writeFileSync(
        join(obsidianDir, "community-plugins.json"),
        `${JSON.stringify([pluginId(), HOT_RELOAD.id])}\n`,
    );
    const welcome = join(config.vaultPath, "Welcome.md");
    if (!existsSync(welcome)) {
        writeFileSync(
            welcome,
            "# ZotFlow test vault\n\nScratch vault for `npm run live:obsidian`. Safe to wipe.\n",
        );
    }
}

// ---------------------------------------------------------------------------
// CDP

export class Cdp {
    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((ok, fail) => {
            ws.addEventListener("open", ok, { once: true });
            ws.addEventListener("error", fail, { once: true });
        });
        return new Cdp(ws);
    }

    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = [];
        ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { ok, fail } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) fail(new Error(msg.error.message));
                else ok(msg.result);
            } else if (msg.method) {
                for (const fn of this.listeners) fn(msg);
            }
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
    }

    on(fn) {
        this.listeners.push(fn);
    }

    close() {
        this.ws.close();
    }
}

export class Harness {
    constructor(config = loadConfig()) {
        this.config = config;
        this.base = `http://127.0.0.1:${config.port}`;
    }

    async isUp() {
        try {
            await fetch(`${this.base}/json/version`);
            return true;
        } catch {
            return false;
        }
    }

    async targets() {
        const res = await fetch(`${this.base}/json/list`);
        return res.json();
    }

    /**
     * The main window, or the window whose title contains `title`. Popouts
     * (e.g. Settings in 1.13+) are about:blank pages sharing the main
     * window's `app`; only the main window loads index.html.
     */
    async page(title, timeoutMs = 30000) {
        const match = title
            ? (t) => t.type === "page" && t.title.includes(title)
            : (t) =>
                  t.type === "page" && t.url === "app://obsidian.md/index.html";
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.isUp()) {
                const page = (await this.targets()).find(match);
                if (page) return page;
            }
            await sleep(500);
        }
        throw new Error(
            title
                ? `No window titled like "${title}"`
                : `No Obsidian window on port ${this.config.port}; run "npm run live:obsidian -- launch"`,
        );
    }

    async withPage(fn, title) {
        const page = await this.page(title);
        const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        try {
            return await fn(cdp);
        } finally {
            cdp.close();
        }
    }

    /** Evaluate an expression in the main window; promises are awaited. */
    async evaluate(expression) {
        return this.withPage(async (cdp) => {
            const { result, exceptionDetails } = await cdp.send(
                "Runtime.evaluate",
                {
                    expression: `(async () => (${expression}))()`,
                    awaitPromise: true,
                    returnByValue: true,
                },
            );
            if (exceptionDetails) {
                throw new Error(
                    exceptionDetails.exception?.description ??
                        exceptionDetails.text,
                );
            }
            return result.value;
        });
    }

    /** Start Obsidian on the test vault unless it is already listening. */
    async launch() {
        const { obsidianPath, profileDir, vaultPath, port } = this.config;
        if (await this.isUp()) return { started: false };
        if (!obsidianPath || !existsSync(obsidianPath)) {
            throw new Error(
                `Obsidian not found at ${obsidianPath ?? "(unset)"}. Set "obsidianPath" in ${CONFIG_PATH} or ZF_OBSIDIAN_PATH.`,
            );
        }
        if (!existsSync(join(vaultPath, ".obsidian"))) {
            throw new Error(
                `No test vault at ${vaultPath}; run "npm run live:obsidian -- setup"`,
            );
        }
        installPluginFiles(this.config);
        mkdirSync(profileDir, { recursive: true });
        writeFileSync(
            join(profileDir, "obsidian.json"),
            JSON.stringify({
                vaults: {
                    [VAULT_ID]: { path: vaultPath, ts: Date.now(), open: true },
                },
            }),
        );
        const child = spawn(
            obsidianPath,
            [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`],
            { detached: true, stdio: "ignore" },
        );
        child.unref();
        await this.page(undefined, 60000);
        return { started: true, pid: child.pid };
    }

    async close() {
        if (!(await this.isUp())) return false;
        const res = await fetch(`${this.base}/json/version`);
        const { webSocketDebuggerUrl } = await res.json();
        const cdp = await Cdp.connect(webSocketDebuggerUrl);
        // The browser drops the socket while closing, so the reply never
        // arrives; fire and poll the port instead.
        void cdp.send("Browser.close");
        for (let i = 0; i < 40 && (await this.isUp()); i++) await sleep(250);
        cdp.close();
        if (await this.isUp()) throw new Error("Obsidian did not close");
        return true;
    }
}
