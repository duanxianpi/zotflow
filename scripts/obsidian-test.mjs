// Drive an isolated Obsidian instance over the Chrome DevTools Protocol.
//
// The instance uses its own --user-data-dir, so its settings, IndexedDB and
// plugin state never touch your everyday Obsidian profile. It opens a test
// vault whose plugin folder hard-links this repo's build output.
//
// First run:
//   npm run build:plugin
//   npm run live:obsidian -- setup
//   npm run live:obsidian -- launch
//   ZOTFLOW_TEST_API_KEY=... npm run live:obsidian -- login
//
// Commands:
//   setup [--vault <dir>] [--obsidian <exe>] [--profile <dir>] [--port <n>]
//                              create the vault, hard-link the plugin in, install
//                              pjeby/hot-reload, write .obsidian-test/config.json
//   dev                        esbuild watch; keeps the vault's links intact so
//                              hot-reload reloads the plugin on every rebuild
//   status                     effective config (env > config.json > defaults)
//   launch                     start (or reuse) the instance, enable the plugin
//   login                      enter ZOTFLOW_TEST_API_KEY in settings and verify it
//   reload                     disable + re-enable the plugin (after a rebuild)
//   eval '<js>'                evaluate in the main window (promises are awaited)
//   screenshot [out] [window]  PNG of the main window, or of the window whose
//                              title contains [window] (e.g. "Settings")
//   logs [seconds]             stream console output (default 5s)
//   targets                    list debuggable targets (windows, workers, iframes)
//   quit                       close the instance
//   reset                      quit and delete the profile (settings + IndexedDB)
//
// See scripts/obsidian-harness.mjs for config and environment variables.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clearTimeout as cancel, setTimeout as schedule } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";

import {
    CONFIG_PATH,
    HOT_RELOAD,
    Harness,
    LOCAL_DIR,
    PLUGIN_FILES,
    REPO_ROOT,
    installHotReload,
    installPluginFiles,
    loadConfig,
    pluginDir,
    pluginId,
    saveConfig,
    scaffoldVault,
} from "./obsidian-harness.mjs";

const SETUP_FLAGS = {
    "--vault": "vaultPath",
    "--obsidian": "obsidianPath",
    "--profile": "profileDir",
    "--port": "port",
};

async function setup(args) {
    const patch = {};
    for (let i = 0; i < args.length; i += 2) {
        const key = SETUP_FLAGS[args[i]];
        if (!key || args[i + 1] === undefined) {
            throw new Error(`Unknown or incomplete option: ${args[i]}`);
        }
        patch[key] =
            key === "port" ? Number(args[i + 1]) : resolve(args[i + 1]);
    }
    saveConfig(patch);
    // Persist file values and defaults only; env overrides stay runtime-only.
    const config = { ...loadConfig({}), apiKey: loadConfig().apiKey };

    scaffoldVault(config);
    installPluginFiles(config);
    const downloaded = await installHotReload(config);
    saveConfig({
        obsidianPath: config.obsidianPath,
        vaultPath: config.vaultPath,
        profileDir: config.profileDir,
        port: config.port,
    });

    const warnings = [];
    if (!existsSync(join(REPO_ROOT, "main.js"))) {
        warnings.push('main.js is missing; run "npm run build:plugin"');
    }
    if (!config.obsidianPath || !existsSync(config.obsidianPath)) {
        warnings.push(
            `Obsidian executable not found at ${config.obsidianPath ?? "(unset)"}; pass --obsidian <path>`,
        );
    }
    if (!config.apiKey) {
        warnings.push(
            'No Zotero API key: set ZOTFLOW_TEST_API_KEY (or "zoteroApiKey" in the config) before "login"',
        );
    }

    console.log(`Config:  ${CONFIG_PATH}`);
    console.log(`Vault:   ${config.vaultPath}`);
    console.log(`Plugin:  ${pluginDir(config)}`);
    console.log(
        `Hot reload ${HOT_RELOAD.version}: ${downloaded ? "installed" : "already present"}`,
    );
    console.log(`Profile: ${config.profileDir}`);
    console.log(`Port:    ${config.port}`);
    for (const w of warnings) console.log(`warning: ${w}`);
}

async function launch(h) {
    const result = await h.launch();
    console.log(
        result.started
            ? `Launched Obsidian (pid ${result.pid}) on port ${h.config.port}`
            : `Already running on port ${h.config.port}`,
    );
    const id = JSON.stringify(pluginId());
    const all = JSON.stringify([pluginId(), HOT_RELOAD.id]);
    const state = await h.evaluate(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 120 && !window.app?.workspace?.layoutReady; i++)
            await wait(250);
        // First open of a vault with plugins in a fresh profile asks whether
        // to trust its author. Answer it the way a user would; the choice is
        // stored in the profile's localStorage, so later launches skip it.
        for (let i = 0; i < 8; i++) {
            const trust = [...document.querySelectorAll(".modal-container button")]
                .find(b => b.textContent === "Trust author and enable plugins");
            if (trust) { trust.click(); await wait(1000); break; }
            await wait(250);
        }
        if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
        for (const p of ${all})
            if (!app.plugins.plugins[p]) await app.plugins.enablePluginAndSave(p);
        return {
            vault: app.vault.getName(),
            pluginLoaded: !!app.plugins.plugins[${id}],
            version: app.plugins.manifests[${id}]?.version,
            hotReload: !!app.plugins.plugins[${JSON.stringify(HOT_RELOAD.id)}],
            apiKeySet: !!app.plugins.plugins[${id}]?.settings?.zoteroapikey,
        };
    })()`);
    console.log(JSON.stringify(state, null, 2));
    if (!state.pluginLoaded) process.exitCode = 1;
}

// Goes through the settings UI rather than writing settings directly, so the
// key lands in SecretStorage by the same path a user's does.
async function login(h) {
    const key = h.config.apiKey;
    if (!key) {
        throw new Error(
            'Set ZOTFLOW_TEST_API_KEY (or "zoteroApiKey" in .obsidian-test/config.json)',
        );
    }
    const id = JSON.stringify(pluginId());
    const result = await h.evaluate(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        app.setting.open();
        app.setting.openTabById(${id});
        await wait(500);
        const root = app.setting.tabContentContainer;
        try {
            const sync = [...root.querySelectorAll(".setting-item-name")]
                .find(e => e.textContent.trim() === "Sync");
            if (!sync) throw new Error("Sync section not found in settings");
            sync.click();
            await wait(500);
            const input = root.querySelector('input[placeholder="Enter API Key"]');
            if (!input) throw new Error("API key field not found");
            const win = input.ownerDocument.defaultView;
            input.value = ${JSON.stringify(key)};
            input.dispatchEvent(new win.Event("input", { bubbles: true }));
            const verify = [...root.querySelectorAll("button")]
                .find(b => b.textContent === "Verify Key" || b.textContent === "Verified");
            verify.click();
            for (let i = 0; i < 80 && !root.querySelector(".zotflow-settings-lib-table"); i++)
                await wait(250);
            const status = [...root.querySelectorAll(".setting-item")]
                .find(s => s.querySelector(".setting-item-name")?.textContent === "API Key")
                ?.querySelector(".setting-item-description")?.textContent;
            const libraries = [...root.querySelectorAll(".zotflow-settings-lib-table tbody tr")]
                .map(tr => [...tr.cells].map(td => {
                    const select = td.querySelector("select");
                    return select
                        ? select.selectedOptions[0]?.textContent
                        : td.innerText.trim().replace(/\\s+/g, " ");
                }).join(" | "));
            return {
                verified: !!app.plugins.plugins[${id}].settings.zoteroapikey,
                status,
                libraries,
            };
        } finally {
            app.setting.close();
        }
    })()`);
    console.log(JSON.stringify(result, null, 2));
    if (!result.verified) process.exitCode = 1;
}

async function reload(h) {
    installPluginFiles(h.config);
    const id = JSON.stringify(pluginId());
    const ok = await h.evaluate(`(async () => {
        await app.plugins.disablePlugin(${id});
        await app.plugins.loadManifests();
        await app.plugins.enablePlugin(${id});
        return !!app.plugins.plugins[${id}];
    })()`);
    console.log(ok ? "Reloaded" : "Reload failed: plugin not loaded");
    if (!ok) process.exitCode = 1;
}

async function screenshot(h, out, title) {
    const file = resolve(
        out ?? join(LOCAL_DIR, "screenshots", `${Date.now()}.png`),
    );
    const data = await h.withPage(async (cdp) => {
        const { data } = await cdp.send("Page.captureScreenshot", {
            format: "png",
        });
        return data;
    }, title);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(file);
}

async function logs(h, seconds) {
    await h.withPage(async (cdp) => {
        cdp.on((msg) => {
            if (msg.method === "Runtime.consoleAPICalled") {
                const text = msg.params.args
                    .map((a) => a.value ?? a.description ?? a.type)
                    .join(" ");
                console.log(`[${msg.params.type}] ${text}`);
            } else if (msg.method === "Runtime.exceptionThrown") {
                const d = msg.params.exceptionDetails;
                console.log(
                    `[exception] ${d.exception?.description ?? d.text}`,
                );
            }
        });
        // Runtime.enable replays messages logged before we attached.
        await cdp.send("Runtime.enable");
        await sleep(seconds * 1000);
    });
}

// esbuild in watch mode. The hard links make each rebuild visible to
// hot-reload directly; the watcher only repairs links that something replaced
// (or refreshes copies, where linking was impossible).
function dev(h) {
    const build = spawn(process.execPath, ["esbuild.config.mjs"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
    });
    let timer;
    const sync = () => {
        cancel(timer);
        timer = schedule(() => {
            const written = installPluginFiles(h.config);
            if (written.length > 0) {
                console.log(`[live:obsidian] relinked ${written.join(", ")}`);
            }
        }, 200);
    };
    // Watch the directory, not the files: esbuild may replace them.
    const watcher = watch(REPO_ROOT, (_event, name) => {
        if (PLUGIN_FILES.includes(String(name))) sync();
    });
    sync();
    console.log(`[live:obsidian] syncing build output to ${pluginDir(h.config)}`);
    return new Promise((done) => {
        const stop = () => {
            watcher.close();
            build.kill();
        };
        process.once("SIGINT", stop);
        build.once("exit", () => {
            watcher.close();
            done();
        });
    });
}

async function reset(h) {
    await h.close();
    rmSync(h.config.profileDir, { recursive: true, force: true });
    console.log(`Deleted profile ${h.config.profileDir}`);
}

function status(h) {
    console.log(
        JSON.stringify(
            {
                ...h.config,
                apiKey: h.config.apiKey ? "(set)" : null,
                pluginInstalled: existsSync(
                    join(pluginDir(h.config), "main.js"),
                ),
                hotReloadInstalled: existsSync(
                    join(pluginDir(h.config, HOT_RELOAD.id), "main.js"),
                ),
            },
            null,
            2,
        ),
    );
}

const [command, ...args] = process.argv.slice(2);
const commands = {
    setup: () => setup(args),
    dev,
    status,
    launch,
    login,
    reload,
    eval: async (h) =>
        console.log(JSON.stringify(await h.evaluate(args.join(" ")), null, 2)),
    screenshot: (h) => screenshot(h, args[0], args[1]),
    logs: (h) => logs(h, Number(args[0] ?? 5)),
    targets: async (h) =>
        console.log(
            (await h.targets())
                .map((t) => `${t.type}\t${t.title}\t${t.url}`)
                .join("\n"),
        ),
    quit: async (h) =>
        console.log((await h.close()) ? "Closed" : "Not running"),
    reset,
};

if (!commands[command]) {
    console.log(`Commands: ${Object.keys(commands).join(", ")}`);
    process.exit(command ? 1 : 0);
}
try {
    await commands[command](new Harness(loadConfig()));
} catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
}
