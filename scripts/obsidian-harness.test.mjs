import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
    defaultObsidianPath,
    HOT_RELOAD,
    installHotReload,
    installPluginFiles,
    loadConfig,
    LOCAL_DIR,
    pluginDir,
    REPO_ROOT,
    scaffoldVault,
} from "./obsidian-harness.mjs";

describe("defaultObsidianPath", () => {
    it("knows the macOS and Windows install locations", () => {
        assert.equal(
            defaultObsidianPath("darwin", {}),
            "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
        );
        assert.equal(
            defaultObsidianPath("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }),
            join("C:\\Users\\a\\AppData\\Local", "Programs", "Obsidian", "Obsidian.exe"),
        );
    });

    it("has no default on Linux", () => {
        assert.equal(defaultObsidianPath("linux", {}), null);
    });
});

describe("loadConfig", () => {
    it("lets the environment override paths, port and key", () => {
        const config = loadConfig({
            ZF_TEST_VAULT: "/tmp/v",
            ZF_TEST_PROFILE: "/tmp/p",
            ZF_TEST_PORT: "9999",
            ZF_OBSIDIAN_PATH: "/opt/obsidian",
            ZOTFLOW_TEST_API_KEY: "k",
        });
        assert.equal(config.vaultPath, "/tmp/v");
        assert.equal(config.profileDir, "/tmp/p");
        assert.equal(config.port, 9999);
        assert.equal(config.obsidianPath, "/opt/obsidian");
        assert.equal(config.apiKey, "k");
    });
});

describe("vault install", () => {
    let vault;
    afterEach(() => rmSync(vault, { recursive: true, force: true }));

    const makeConfig = () => {
        // Inside the repo, not os.tmpdir(): hard links need the same volume,
        // and /tmp is often tmpfs.
        mkdirSync(LOCAL_DIR, { recursive: true });
        vault = mkdtempSync(join(LOCAL_DIR, "unit-"));
        return { vaultPath: vault };
    };

    it("enables the plugin under its manifest id, plus hot-reload", () => {
        const config = makeConfig();
        scaffoldVault(config);
        const manifest = JSON.parse(
            readFileSync(join(REPO_ROOT, "manifest.json"), "utf8"),
        );
        const enabled = JSON.parse(
            readFileSync(
                join(vault, ".obsidian", "community-plugins.json"),
                "utf8",
            ),
        );
        assert.deepEqual(enabled, [manifest.id, HOT_RELOAD.id]);
        assert.ok(pluginDir(config).endsWith(join("plugins", manifest.id)));
    });

    it("hard-links the build output and marks it for hot-reload", () => {
        const config = makeConfig();
        const first = installPluginFiles(config);
        // main.js only exists after a build; the other two are tracked.
        assert.ok(first.includes("manifest.json"));
        assert.ok(first.includes("styles.css"));
        for (const name of first) {
            assert.equal(
                statSync(join(pluginDir(config), name)).ino,
                statSync(join(REPO_ROOT, name)).ino,
            );
        }
        assert.ok(existsSync(join(pluginDir(config), ".hotreload")));
        assert.deepEqual(installPluginFiles(config), []);
    });

    it("repairs a link that was replaced by a plain file", () => {
        const config = makeConfig();
        installPluginFiles(config);
        const target = join(pluginDir(config), "manifest.json");
        rmSync(target);
        writeFileSync(target, "{}");
        assert.deepEqual(installPluginFiles(config), ["manifest.json"]);
        assert.equal(
            statSync(target).ino,
            statSync(join(REPO_ROOT, "manifest.json")).ino,
        );
    });

    it("copies when hard links are impossible (EXDEV)", () => {
        const config = makeConfig();
        const crossDevice = () => {
            throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
        };
        installPluginFiles(config, crossDevice);
        const target = join(pluginDir(config), "styles.css");
        assert.notEqual(
            statSync(target).ino,
            statSync(join(REPO_ROOT, "styles.css")).ino,
        );
        assert.deepEqual(
            readFileSync(target),
            readFileSync(join(REPO_ROOT, "styles.css")),
        );
    });

    it("rethrows other link errors", () => {
        const config = makeConfig();
        const broken = () => {
            throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        };
        assert.throws(() => installPluginFiles(config, broken), /ENOSPC/);
    });

    const fakeFetch = (bodies) => async (url) => {
        const name = url.split("/").pop();
        return new Response(bodies[name] ?? "", { status: 200 });
    };

    it("refuses a hot-reload download whose checksum does not match", async () => {
        const config = makeConfig();
        await assert.rejects(
            installHotReload(
                config,
                fakeFetch({ "main.js": "evil", "manifest.json": "{}" }),
            ),
            /Checksum mismatch/,
        );
        assert.ok(!existsSync(pluginDir(config, HOT_RELOAD.id)));
    });

    it("leaves nothing behind when a hot-reload download fails", async () => {
        const config = makeConfig();
        const failing = async () => new Response("", { status: 500 });
        await assert.rejects(installHotReload(config, failing), /500/);
        assert.ok(!existsSync(pluginDir(config, HOT_RELOAD.id)));
    });
});
