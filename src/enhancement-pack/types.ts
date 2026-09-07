export const PACK_ID = "zotflow-enhancement-pack";
export const SDT_COMPONENT = "document-worker.sdt";
// Consumer-side ceilings: an installed Pack cannot raise its own allocation budget.
export const PACK_LIMITS = {
    file: 256 * 1024 * 1024,
    manifest: 1024 * 1024,
    resources: 1024,
    resource: 64 * 1024 * 1024,
    component: 128 * 1024 * 1024,
};

/** One entry in the embedded directory; content is verified only when decoded. */
export interface PackResource {
    component: string;
    path: string;
    mediaType: string;
    encoding: "gzip-base64";
    offset: number; // Byte offset from the payload start, not from main.js start.
    length: number; // Encoded base64 byte length; decodedSize is the raw byte length.
    decodedSize: number;
    sha256: string;
}

/** ZotFlow's pinned expectations, independent of the installed Pack's claims. */
export interface SdtCompatibility {
    source: {
        documentWorkerCommit: string;
    };
    sdt: { packVersion: number; schemaMajorVersion: number };
    resourcePaths: string[];
    resources: Array<{ path: string; size: number; sha256: string }>;
}

// Resource records live once in PackManifest.resources, outside component metadata.
export interface PackComponent extends Omit<SdtCompatibility, "resources"> {
    id: string;
}
export interface PackManifest {
    schemaVersion: 1;
    protocol: { major: 2; minor: number };
    pack: { id: typeof PACK_ID; version: string };
    components: PackComponent[];
    resources: PackResource[];
}

/** Worker-owned copies of one component's compressed data, isolated from disk updates. */
export interface PackSnapshot {
    generationId: string;
    resources: Map<
        string,
        { entry: PackResource; encoded: Uint8Array<ArrayBuffer> }
    >;
}

/** Serializable consumer handle; one lease stays bound to one generation until release. */
export interface PackLease {
    leaseId: string;
    generationId: string;
    // Allows the local DocumentWorkerService to read the same retained snapshot directly.
    snapshotId: string;
}

export type PackErrorCode =
    | "not-installed"
    | "unreadable"
    | "pack-changing"
    | "incompatible"
    | "corrupt"
    | "resource-limit"
    | "disposed";

export class PackError extends Error {
    constructor(
        readonly code: PackErrorCode,
        message: string,
    ) {
        super(message);
        // Comlink preserves Error.name/message, but not custom properties such as code.
        this.name = `EnhancementPackError:${code}`;
    }

    static from(error: unknown): PackError | undefined {
        if (error instanceof PackError) return error;
        if (!(error instanceof Error)) return undefined;
        const codes: PackErrorCode[] = [
            "not-installed",
            "unreadable",
            "pack-changing",
            "incompatible",
            "corrupt",
            "resource-limit",
            "disposed",
        ];
        const code = codes.find(
            (value) => error.name === `EnhancementPackError:${value}`,
        );
        return code ? new PackError(code, error.message) : undefined;
    }
}

/** Logical resource names only: callers must not interpret these as URLs or vault paths. */
export function validPath(path: string): boolean {
    return (
        /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) &&
        path.split("/").every((part) => part !== "." && part !== "..")
    );
}

export function resourceMime(path: string): string {
    if (path.endsWith(".js")) return "text/javascript";
    if (path.endsWith(".json")) return "application/json";
    if (path.endsWith(".wasm")) return "application/wasm";
    return "application/octet-stream";
}
