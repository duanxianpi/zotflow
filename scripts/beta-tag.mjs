import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const RELEASE_TYPES = new Set(["major", "minor", "patch"]);

export function bumpStableVersion(version, releaseType) {
    const match = STABLE_VERSION_PATTERN.exec(version);
    if (!match) {
        throw new Error(
            `Current package version must be stable x.y.z, received ${version}`,
        );
    }
    if (!RELEASE_TYPES.has(releaseType)) {
        throw new Error(`Release type must be major, minor, or patch`);
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (releaseType === "major") return `${major + 1}.0.0`;
    if (releaseType === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

export function getNextBetaVersion(currentVersion, releaseType, tags) {
    const target = bumpStableVersion(currentVersion, releaseType);
    const pattern = new RegExp(
        `^${target.replaceAll(".", "\\.")}-beta\\.(\\d+)$`,
        "u",
    );
    let maximum = 0;
    for (const tag of tags) {
        const match = pattern.exec(tag);
        if (match) maximum = Math.max(maximum, Number(match[1]));
    }
    return `${target}-beta.${maximum + 1}`;
}

function runGit(args, options = {}) {
    const output = execFileSync("git", args, {
        encoding: "utf8",
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    });
    return typeof output === "string" ? output.trim() : "";
}

function gitSucceeds(args) {
    return spawnSync("git", args, { stdio: "ignore" }).status === 0;
}

function assertCleanWorktree() {
    const diffOptions = [
        "--quiet",
        "--ignore-space-at-eol",
        "--ignore-submodules=dirty",
    ];
    if (
        !gitSucceeds(["diff", ...diffOptions]) ||
        !gitSucceeds(["diff", "--cached", ...diffOptions]) ||
        runGit(["ls-files", "--others", "--exclude-standard"]) !== ""
    ) {
        throw new Error("The worktree must be clean before creating a beta tag");
    }
}

function parseArguments(args) {
    const dryRun = args.includes("--dry-run");
    const positional = args.filter((argument) => argument !== "--dry-run");
    if (positional.length !== 1 || !RELEASE_TYPES.has(positional[0])) {
        throw new Error(
            "Usage: beta-tag.mjs <patch|minor|major> [--dry-run]",
        );
    }
    return { dryRun, releaseType: positional[0] };
}

function main() {
    const { dryRun, releaseType } = parseArguments(process.argv.slice(2));
    const branch = runGit(["branch", "--show-current"]);
    if (branch !== "dev") {
        throw new Error(`Beta tags must be created from dev, not ${branch}`);
    }

    assertCleanWorktree();
    runGit(
        ["fetch", "origin", "dev:refs/remotes/origin/dev", "--tags"],
        { inherit: true },
    );
    const head = runGit(["rev-parse", "HEAD"]);
    const remoteHead = runGit(["rev-parse", "origin/dev"]);
    if (head !== remoteHead) {
        throw new Error("Local dev must exactly match origin/dev");
    }

    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const target = bumpStableVersion(packageJson.version, releaseType);
    const tags = runGit(["tag", "--list", `${target}-beta.*`])
        .split("\n")
        .filter(Boolean);
    const version = getNextBetaVersion(
        packageJson.version,
        releaseType,
        tags,
    );

    if (!dryRun) {
        runGit(["tag", "--annotate", version, "--message", version]);
        try {
            runGit(["push", "origin", `refs/tags/${version}`], {
                inherit: true,
            });
        } catch (error) {
            throw new Error(
                `Created local tag ${version}, but push failed. Retry with git push origin ${version}.`,
                { cause: error },
            );
        }
    }

    process.stdout.write(`${version}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
}
