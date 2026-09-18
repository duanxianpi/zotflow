import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const BETA_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/u;

export function getReleaseChannel(version) {
    if (STABLE_VERSION_PATTERN.test(version)) return "stable";
    if (BETA_VERSION_PATTERN.test(version)) return "beta";
    throw new Error(
        `Invalid release version: ${version}. Expected x.y.z or x.y.z-beta.N`,
    );
}

function parseOptions(args) {
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (
            !["--version", "--channel", "--root"].includes(name) ||
            value === undefined ||
            options.has(name.slice(2))
        ) {
            throw new Error(`Invalid argument: ${name ?? ""}`);
        }
        options.set(name.slice(2), value);
    }
    return options;
}

function detectIndent(contents) {
    return contents.match(/\n([\t ]+)"/u)?.[1] ?? "    ";
}

function serializeJson(value, original) {
    const newline = original.endsWith("\n") ? "\n" : "";
    return `${JSON.stringify(value, null, detectIndent(original))}${newline}`;
}

async function readJson(filePath) {
    const contents = await readFile(filePath, "utf8");
    return { contents, value: JSON.parse(contents) };
}

function resolveFiles(root) {
    return {
        packageJson: path.join(root, "package.json"),
        packageLock: path.join(root, "package-lock.json"),
        manifest: path.join(root, "manifest.json"),
        versions: path.join(root, "versions.json"),
    };
}

function assertChannel(version, expectedChannel) {
    const actualChannel = getReleaseChannel(version);
    if (expectedChannel && actualChannel !== expectedChannel) {
        throw new Error(
            `Release ${version} is ${actualChannel}, not ${expectedChannel}`,
        );
    }
    return actualChannel;
}

export async function prepareReleaseVersion({
    root = process.cwd(),
    version,
    channel,
}) {
    const actualChannel = assertChannel(version, channel);
    const files = resolveFiles(root);
    const [packageJson, packageLock, manifest, versions] = await Promise.all([
        readJson(files.packageJson),
        readJson(files.packageLock),
        readJson(files.manifest),
        readJson(files.versions),
    ]);

    if (!packageLock.value.packages?.[""]) {
        throw new Error("package-lock.json does not contain the root package");
    }
    if (typeof manifest.value.minAppVersion !== "string") {
        throw new Error("manifest.json does not contain minAppVersion");
    }

    packageJson.value.version = version;
    packageLock.value.version = version;
    packageLock.value.packages[""].version = version;
    manifest.value.version = version;
    versions.value[version] = manifest.value.minAppVersion;

    await Promise.all([
        writeFile(
            files.packageJson,
            serializeJson(packageJson.value, packageJson.contents),
            "utf8",
        ),
        writeFile(
            files.packageLock,
            serializeJson(packageLock.value, packageLock.contents),
            "utf8",
        ),
        writeFile(
            files.manifest,
            serializeJson(manifest.value, manifest.contents),
            "utf8",
        ),
        writeFile(
            files.versions,
            serializeJson(versions.value, versions.contents),
            "utf8",
        ),
    ]);

    return { channel: actualChannel, version };
}

export async function verifyReleaseVersion({
    root = process.cwd(),
    version,
    channel,
}) {
    const actualChannel = assertChannel(version, channel);
    const files = resolveFiles(root);
    const [packageJson, packageLock, manifest, versions] = await Promise.all([
        readJson(files.packageJson),
        readJson(files.packageLock),
        readJson(files.manifest),
        readJson(files.versions),
    ]);
    const values = [
        ["package.json", packageJson.value.version],
        ["package-lock.json", packageLock.value.version],
        [
            "package-lock root package",
            packageLock.value.packages?.[""]?.version,
        ],
        ["manifest.json", manifest.value.version],
    ];
    for (const [label, actual] of values) {
        if (actual !== version) {
            throw new Error(
                `${label} version is ${actual ?? "missing"}, not ${version}`,
            );
        }
    }
    if (versions.value[version] !== manifest.value.minAppVersion) {
        throw new Error(
            `versions.json does not map ${version} to ${manifest.value.minAppVersion}`,
        );
    }
    return { channel: actualChannel, version };
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!["prepare", "verify"].includes(command)) {
        throw new Error(
            "Usage: release-version.mjs <prepare|verify> --version <version> --channel <stable|beta> [--root <path>]",
        );
    }
    const options = parseOptions(args);
    const version = options.get("version");
    const channel = options.get("channel");
    if (!version || !channel || !["stable", "beta"].includes(channel)) {
        throw new Error("--version and --channel <stable|beta> are required");
    }
    const operation =
        command === "prepare" ? prepareReleaseVersion : verifyReleaseVersion;
    const result = await operation({
        root: path.resolve(options.get("root") ?? process.cwd()),
        version,
        channel,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
    await main();
}
