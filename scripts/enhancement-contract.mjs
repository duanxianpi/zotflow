import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/**
 * Build-time helper for updating ZotFlow's lock from a selected upstream archive.
 * These hashes establish the new resource baseline; they do not independently
 * authenticate the download. Pack builds and runtime decoding later verify against it.
 */
export function deriveEnhancementContract(archive, config) {
    const files = unzipSync(archive);
    const resources = Object.keys(files)
        .filter(
            (p) =>
                !p.endsWith("/") &&
                config.include.some((i) =>
                    i.endsWith("/") ? p.startsWith(i) : p === i,
                ),
        )
        // Stable order keeps lock diffs reproducible across repeated updates.
        .sort()
        .map((path) => {
            const bytes = files[path];
            return { path, size: bytes.length, sha256: hash(bytes) };
        });
    // Each exact path or directory prefix must select something; upstream layout
    // changes should fail the update instead of silently dropping required resources.
    for (const include of config.include) {
        if (
            !resources.some((r) =>
                include.endsWith("/")
                    ? r.path.startsWith(include)
                    : r.path === include,
            )
        )
            throw new Error(`Missing resource: ${include}`);
    }
    // SDT output compatibility comes from upstream metadata, not the Pack release version.
    const metadata = JSON.parse(
        new TextDecoder().decode(files["metadata.json"]),
    );
    if (
        !Number.isSafeInteger(metadata.SDT_PACK_VERSION) ||
        !/^\d+\.\d+\.\d+$/.test(metadata.SDT_SCHEMA_VERSION)
    )
        throw new Error("Invalid SDT metadata");
    return {
        ...config,
        sdt: {
            packVersion: metadata.SDT_PACK_VERSION,
            schemaMajorVersion: Number(
                metadata.SDT_SCHEMA_VERSION.split(".")[0],
            ),
        },
        resources,
    };
}
