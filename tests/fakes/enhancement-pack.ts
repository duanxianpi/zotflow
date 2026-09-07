import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PackManifest, SdtCompatibility } from "enhancement-pack/types";

const hash = (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
export function packFixture(version = "2.0.0", content = "model fixture") {
    const input = [Buffer.from(content), Buffer.from("second resource")];
    const paths = ["model.onnx", "stats.bin"];
    let offset = 0;
    const encoded = input.map((bytes) => gzipSync(bytes).toString("base64"));
    const resources = input.map((bytes, i) => {
        const length = encoded[i]!.length;
        const entry = {
            component: "document-worker.sdt",
            path: paths[i]!,
            mediaType: "application/octet-stream",
            encoding: "gzip-base64" as const,
            offset,
            length,
            decodedSize: bytes.length,
            sha256: hash(bytes),
        };
        offset += length;
        return entry;
    });
    const expected: SdtCompatibility = {
        source: {
            documentWorkerCommit: "a".repeat(40),
        },
        sdt: { packVersion: 1, schemaMajorVersion: 1 },
        resourcePaths: paths,
        resources: resources.map((r) => ({
            path: r.path,
            size: r.decodedSize,
            sha256: r.sha256,
        })),
    };
    const manifest: PackManifest = {
        schemaVersion: 1,
        protocol: { major: 2, minor: 0 },
        pack: { id: "zotflow-enhancement-pack", version },
        components: [
            {
                id: "document-worker.sdt",
                source: expected.source,
                sdt: expected.sdt,
                resourcePaths: paths,
            },
        ],
        resources,
    };
    const build = (
        directory: unknown = manifest,
        payload = encoded.join(""),
    ): ArrayBuffer => {
        const json = Buffer.from(
            typeof directory === "string"
                ? directory
                : JSON.stringify(directory),
        );
        const m64 = json.toString("base64");
        const footer = `\nZFEP2|${payload.length.toString(16).padStart(16, "0")}|${m64.length.toString(16).padStart(16, "0")}|${hash(json)}|END*/\n`;
        return new Uint8Array(
            Buffer.from(
                `globalThis.PACK_ENTRY_EXECUTED = true; // 中文\n\n/*ZFEP2\n${payload}${m64}${footer}`,
            ),
        ).buffer;
    };
    return { expected, manifest, input, encoded, build, bytes: build() };
}
