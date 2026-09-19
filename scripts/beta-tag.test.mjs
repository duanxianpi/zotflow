import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    bumpStableVersion,
    getNextBetaVersion,
} from "./beta-tag.mjs";

test("bumps stable versions like npm version", () => {
    assert.equal(bumpStableVersion("1.6.5", "patch"), "1.6.6");
    assert.equal(bumpStableVersion("1.6.5", "minor"), "1.7.0");
    assert.equal(bumpStableVersion("1.6.5", "major"), "2.0.0");
});

test("selects the next beta number for the requested stable target", () => {
    assert.equal(getNextBetaVersion("1.6.5", "patch", []), "1.6.6-beta.1");
    assert.equal(
        getNextBetaVersion("1.6.5", "patch", [
            "1.6.6-beta.1",
            "1.6.6-beta.4",
            "1.7.0-beta.9",
        ]),
        "1.6.6-beta.5",
    );
});

test("rejects prerelease package versions and unknown release types", () => {
    assert.throws(
        () => bumpStableVersion("1.6.6-beta.1", "patch"),
        /must be stable/u,
    );
    assert.throws(
        () => bumpStableVersion("1.6.5", "beta"),
        /major, minor, or patch/u,
    );
});

test("creates and pushes consecutive annotated beta tags without commits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zotflow-beta-tag-"));
    const remote = path.join(root, "origin.git");
    const checkout = path.join(root, "checkout");
    const script = fileURLToPath(new URL("./beta-tag.mjs", import.meta.url));
    const git = (args, cwd = root) =>
        execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

    git(["init", "--bare", remote]);
    git(["init", "--initial-branch=dev", checkout]);
    git(["config", "user.name", "Test User"], checkout);
    git(["config", "user.email", "test@example.com"], checkout);
    await writeFile(
        path.join(checkout, "package.json"),
        `${JSON.stringify({ name: "test", version: "1.6.5" }, null, 4)}\n`,
        "utf8",
    );
    git(["add", "package.json"], checkout);
    git(["commit", "-m", "initial"], checkout);
    git(["remote", "add", "origin", remote], checkout);
    git(["push", "--set-upstream", "origin", "dev"], checkout);
    const originalHead = git(["rev-parse", "HEAD"], checkout);

    const preview = execFileSync(
        process.execPath,
        [script, "patch", "--dry-run"],
        { cwd: checkout, encoding: "utf8" },
    ).trim();
    assert.equal(preview, "1.6.6-beta.1");

    const first = execFileSync(process.execPath, [script, "patch"], {
        cwd: checkout,
        encoding: "utf8",
    }).trim();
    const second = execFileSync(process.execPath, [script, "patch"], {
        cwd: checkout,
        encoding: "utf8",
    }).trim();
    assert.equal(first, "1.6.6-beta.1");
    assert.equal(second, "1.6.6-beta.2");
    assert.equal(git(["rev-parse", "HEAD"], checkout), originalHead);
    assert.equal(
        git(["tag", "--list", "1.6.6-beta.*"], checkout),
        "1.6.6-beta.1\n1.6.6-beta.2",
    );
    assert.equal(
        JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"))
            .version,
        "1.6.5",
    );
    await rm(root, { recursive: true, force: true });
});
