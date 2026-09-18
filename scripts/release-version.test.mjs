import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    getReleaseChannel,
    prepareReleaseVersion,
    verifyReleaseVersion,
} from "./release-version.mjs";

async function createFixture() {
    const root = await mkdtemp(
        path.join(os.tmpdir(), "zotflow-release-version-"),
    );
    const files = {
        "package.json": {
            name: "obsidian-zotflow",
            version: "1.6.5",
        },
        "package-lock.json": {
            name: "obsidian-zotflow",
            version: "1.6.5",
            lockfileVersion: 3,
            packages: { "": { name: "obsidian-zotflow", version: "1.6.5" } },
        },
        "manifest.json": {
            id: "zotflow",
            version: "1.6.5",
            minAppVersion: "1.13.4",
        },
        "versions.json": { "1.6.5": "1.13.4" },
    };
    await Promise.all(
        Object.entries(files).map(([name, value]) =>
            writeFile(
                path.join(root, name),
                `${JSON.stringify(value, null, 4)}\n`,
                "utf8",
            ),
        ),
    );
    return root;
}

test("classifies stable and beta versions", () => {
    assert.equal(getReleaseChannel("1.6.6"), "stable");
    assert.equal(getReleaseChannel("1.6.6-beta.2"), "beta");
    assert.throws(
        () => getReleaseChannel("v1.6.6"),
        /Invalid release version/u,
    );
    assert.throws(
        () => getReleaseChannel("1.6.6-rc.1"),
        /Invalid release version/u,
    );
});

test("prepares and verifies a beta version without changing minAppVersion", async () => {
    const root = await createFixture();
    try {
        await prepareReleaseVersion({
            root,
            version: "1.6.6-beta.1",
            channel: "beta",
        });
        await verifyReleaseVersion({
            root,
            version: "1.6.6-beta.1",
            channel: "beta",
        });
        const manifest = JSON.parse(
            await readFile(path.join(root, "manifest.json"), "utf8"),
        );
        const versions = JSON.parse(
            await readFile(path.join(root, "versions.json"), "utf8"),
        );
        assert.equal(manifest.version, "1.6.6-beta.1");
        assert.equal(manifest.minAppVersion, "1.13.4");
        assert.equal(versions["1.6.6-beta.1"], "1.13.4");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("rejects a channel mismatch and inconsistent files", async () => {
    const root = await createFixture();
    try {
        await assert.rejects(
            prepareReleaseVersion({ root, version: "1.6.6", channel: "beta" }),
            /not beta/u,
        );
        await assert.rejects(
            verifyReleaseVersion({
                root,
                version: "1.6.6-beta.1",
                channel: "beta",
            }),
            /package\.json version/u,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
