import { Gunzip } from "fflate";
import {
    PACK_ID,
    PACK_LIMITS,
    SDT_COMPONENT,
    PackError,
    validPath,
    resourceMime,
} from "enhancement-pack/types";
import type {
    PackManifest,
    PackSnapshot,
    SdtCompatibility,
} from "enhancement-pack/types";

const HASH = /^[0-9a-f]{64}$/;
function requireValid(ok: unknown, message: string): asserts ok {
    if (!ok) throw new PackError("corrupt", message);
}
function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): value is number {
    return (
        Number.isSafeInteger(value) && typeof value === "number" && value >= 0
    );
}
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON.parse accepts duplicate keys; reject them before using the resulting data. */
export function strictJson(text: string): unknown {
    const value: unknown = JSON.parse(text);
    // JSON.parse checks syntax first. Scan only structural tokens and object keys;
    // decoding keys catches aliases such as "x" and "\u0078" as duplicates too.
    const stack: Array<Set<string> | null> = [];
    const tokens = /"(?:\\.|[^"\\])*"|[{}[\]]/g;
    let token: RegExpExecArray | null;
    while ((token = tokens.exec(text))) {
        const item = token[0];
        if (item === "{") stack.push(new Set());
        else if (item === "[") stack.push(null);
        else if (item === "}" || item === "]") stack.pop();
        else if (/^\s*:/.test(text.slice(tokens.lastIndex))) {
            const keys = stack[stack.length - 1];
            const key = JSON.parse(item) as string;
            requireValid(keys && !keys.has(key), "Duplicate JSON key");
            keys.add(key);
        }
        requireValid(stack.length <= 64, "JSON nesting limit exceeded");
    }
    return value;
}

export function decodeBase64(
    bytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const padding = text.indexOf("=");
    requireValid(
        text.length % 4 === 0 &&
            !/[^A-Za-z0-9+/=]/.test(text) &&
            (padding < 0 ||
                (padding >= text.length - 2 &&
                    /^={1,2}$/.test(text.slice(padding)))),
        "Invalid base64",
    );
    const binary = atob(text);
    // Reject alternate encodings (including nonzero padding bits) after alphabet checks.
    requireValid(btoa(binary) === text, "Non-canonical base64");
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Checks directory structure and budgets without decompressing any resource. */
function validateManifest(value: unknown, payloadSize: number): PackManifest {
    requireValid(record(value), "Invalid manifest");
    if (
        value.schemaVersion !== 1 ||
        !record(value.protocol) ||
        value.protocol.major !== 2
    ) {
        throw new PackError(
            "incompatible",
            "Unsupported Enhancement Pack protocol",
        );
    }
    requireValid(integer(value.protocol.minor), "Invalid protocol minor");
    requireValid(
        record(value.pack) &&
            value.pack.id === PACK_ID &&
            typeof value.pack.version === "string" &&
            /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
                value.pack.version,
            ),
        "Invalid Pack identity",
    );
    requireValid(
        Array.isArray(value.components) && Array.isArray(value.resources),
        "Missing component directory",
    );
    if (
        value.resources.length > PACK_LIMITS.resources ||
        value.components.length > PACK_LIMITS.resources
    ) {
        throw new PackError("resource-limit", "Too many resources");
    }
    const components = new Map<string, Set<string>>();
    for (const c of value.components) {
        requireValid(
            record(c) &&
                typeof c.id === "string" &&
                validPath(c.id) &&
                !components.has(c.id),
            "Invalid component identity",
        );
        requireValid(
            record(c.source) &&
                typeof c.source.documentWorkerCommit === "string" &&
                /^[0-9a-f]{40}$/.test(c.source.documentWorkerCommit),
            "Invalid source identity",
        );
        requireValid(
            record(c.sdt) &&
                integer(c.sdt.packVersion) &&
                integer(c.sdt.schemaMajorVersion),
            "Invalid SDT versions",
        );
        requireValid(
            Array.isArray(c.resourcePaths) &&
                c.resourcePaths.length > 0 &&
                c.resourcePaths.every(
                    (p: unknown) => typeof p === "string" && validPath(p),
                ),
            "Invalid resource paths",
        );
        const paths = new Set<string>(c.resourcePaths as string[]);
        requireValid(
            paths.size === c.resourcePaths.length,
            "Duplicate component path",
        );
        components.set(c.id, paths);
    }
    let end = 0;
    // Identity includes the component: equal filenames in separate components are distinct.
    // Intervals must appear in payload order and cover it exactly, without gaps or overlap.
    const seen = new Set<string>();
    const totals = new Map<string, number>();
    for (const r of value.resources) {
        requireValid(
            record(r) &&
                typeof r.component === "string" &&
                typeof r.path === "string" &&
                validPath(r.path),
            "Invalid resource path",
        );
        requireValid(
            components.get(r.component)?.has(r.path),
            "Unknown resource reference",
        );
        const identity = `${r.component}:${r.path}`;
        requireValid(!seen.has(identity), "Duplicate resource");
        seen.add(identity);
        requireValid(
            r.encoding === "gzip-base64" &&
                r.mediaType === resourceMime(r.path),
            "Unsupported resource encoding or MIME",
        );
        requireValid(
            integer(r.offset) &&
                integer(r.length) &&
                r.length > 0 &&
                integer(r.decodedSize) &&
                r.offset === end &&
                r.length <= payloadSize - end,
            "Invalid resource interval",
        );
        requireValid(
            typeof r.sha256 === "string" && HASH.test(r.sha256),
            "Invalid resource hash",
        );
        end += r.length;
        const total = (totals.get(r.component) ?? 0) + r.decodedSize;
        if (
            r.decodedSize > PACK_LIMITS.resource ||
            total > PACK_LIMITS.component
        ) {
            throw new PackError(
                "resource-limit",
                "Decoded resource budget exceeded",
            );
        }
        totals.set(r.component, total);
    }
    requireValid(end === payloadSize, "Payload has unindexed bytes");
    for (const [id, paths] of components) {
        for (const path of paths)
            requireValid(
                seen.has(`${id}:${path}`),
                "Missing component resource",
            );
    }
    return value as unknown as PackManifest;
}

/**
 * Read the data trailer as bytes; never import/evaluate the plugin's executable prefix.
 * Success validates metadata and compatibility, not every resource's compressed content.
 * Each resource is decoded and checked later, only if its consumer requests it.
 */
export async function parsePack(
    source: ArrayBuffer,
    version: string,
    expected: SdtCompatibility,
): Promise<PackSnapshot> {
    try {
        if (source.byteLength > PACK_LIMITS.file)
            throw new PackError("resource-limit", "Pack file is too large");
        requireValid(source.byteLength >= 121, "Missing v2 footer");
        const bytes = new Uint8Array(source);
        // Layout: executable + 9-byte OPEN + payload + base64 directory + 112-byte footer.
        // Locate backwards from EOF so JavaScript text and Unicode before OPEN are irrelevant.
        const footerStart = bytes.length - 112;
        const footer = new TextDecoder().decode(bytes.subarray(footerStart));
        const fields =
            /^\nZFEP2\|([0-9a-f]{16})\|([0-9a-f]{16})\|([0-9a-f]{64})\|END\*\/\n$/.exec(
                footer,
            );
        if (!fields)
            throw new PackError(
                "incompatible",
                "Missing or unsupported v2 resource footer",
            );
        // Hard bounds are far below 2^53, so reject large hex values before indexing.
        const p = Number.parseInt(fields[1]!, 16),
            m = Number.parseInt(fields[2]!, 16);
        requireValid(
            Number.isSafeInteger(p) &&
                p > 0 &&
                p <= PACK_LIMITS.file &&
                Number.isSafeInteger(m) &&
                m > 0 &&
                m <= PACK_LIMITS.manifest,
            "Invalid footer lengths",
        );
        const manifestStart = footerStart - m,
            payloadStart = manifestStart - p;
        requireValid(
            payloadStart >= 9 &&
                new TextDecoder().decode(
                    bytes.subarray(payloadStart - 9, payloadStart),
                ) === "\n/*ZFEP2\n",
            "Missing resource boundary",
        );
        const manifestBytes = decodeBase64(
            bytes.subarray(manifestStart, footerStart),
        );
        // This checks directory consistency, not publisher identity. Compatibility below
        // uses expectations bundled with ZotFlow, independently of this Pack's metadata.
        requireValid(
            (await sha256(manifestBytes)) === fields[3],
            "Manifest hash mismatch",
        );
        const manifest = validateManifest(
            strictJson(
                new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
            ),
            p,
        );
        requireValid(
            manifest.pack.version === version,
            "Installed versions disagree",
        );
        const component = manifest.components.find(
            (c) => c.id === SDT_COMPONENT,
        );
        if (
            !component ||
            component.source.documentWorkerCommit !==
                expected.source.documentWorkerCommit ||
            component.sdt.packVersion !== expected.sdt.packVersion ||
            component.sdt.schemaMajorVersion !==
                expected.sdt.schemaMajorVersion ||
            [...component.resourcePaths].sort().join("\n") !==
                [...expected.resourcePaths].sort().join("\n")
        ) {
            throw new PackError(
                "incompatible",
                "SDT resources do not match this ZotFlow build",
            );
        }
        const entries = manifest.resources.filter(
            (r) => r.component === SDT_COMPONENT,
        );
        const expectedResources = new Map(
            expected.resources.map((r) => [r.path, r]),
        );
        // Compare existing records directly; there is no extra resource-list hash pass.
        requireValid(
            entries.length === expectedResources.size &&
                entries.every((entry) => {
                    const pinned = expectedResources.get(entry.path);
                    return (
                        pinned?.size === entry.decodedSize &&
                        pinned.sha256 === entry.sha256
                    );
                }),
            "Resource metadata mismatch",
        );
        return {
            // Reuse the already-verified directory digest for in-memory generation sharing.
            generationId: `sha256:${fields[3]}`,
            resources: new Map(
                entries.map((entry) => [
                    entry.path,
                    {
                        entry,
                        // slice owns its bytes. subarray would retain the entire main.js
                        // buffer and prevent unselected components from being collected.
                        encoded: bytes.slice(
                            payloadStart + entry.offset,
                            payloadStart + entry.offset + entry.length,
                        ),
                    },
                ]),
            ),
        };
    } catch (error) {
        if (error instanceof PackError) throw error;
        throw new PackError("corrupt", "Invalid Enhancement Pack data");
    }
}

/** Bounded gzip input chunks cap temporary expansion; this runs in the existing ZotFlow Worker. */
export async function decodeResource(
    snapshot: PackSnapshot,
    path: string,
): Promise<ArrayBuffer> {
    const resource = snapshot.resources.get(path);
    if (!resource)
        throw new PackError(
            "corrupt",
            "Resource is outside the leased component",
        );
    try {
        const compressed = decodeBase64(resource.encoded);
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        let finished = false;
        const inflater = new Gunzip((chunk, final) => {
            // Stop during expansion, before retaining more than the declared raw size.
            // Checking only the final output length would be too late to limit allocation.
            size += chunk.length;
            if (size > resource.entry.decodedSize)
                throw new PackError(
                    "resource-limit",
                    "Gzip output exceeds declared size",
                );
            chunks.push(new Uint8Array(chunk));
            finished = final;
        });
        // One indexed resource corresponds to exactly one gzip stream.
        inflater.onmember = () => {
            throw new PackError(
                "corrupt",
                "Multiple gzip members are not supported",
            );
        };
        for (let position = 0; position < compressed.length; position += 1024) {
            inflater.push(
                compressed.subarray(position, position + 1024),
                position + 1024 >= compressed.length,
            );
        }
        requireValid(
            finished &&
                compressed.length >= 18 &&
                new DataView(compressed.buffer).getUint32(
                    compressed.length - 4,
                    true,
                ) === size,
            "Invalid gzip trailer",
        );
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }
        // One SHA-256 pass checks the raw content against the pinned resource record.
        // Do not add a second CRC32 traversal; gzip completion/length are checked above.
        requireValid(
            size === resource.entry.decodedSize &&
                (await sha256(output)) === resource.entry.sha256,
            "Resource hash or size mismatch",
        );
        return output.buffer;
    } catch (error) {
        if (error instanceof PackError) throw error;
        throw new PackError("corrupt", `Cannot decode SDT resource: ${path}`);
    }
}
