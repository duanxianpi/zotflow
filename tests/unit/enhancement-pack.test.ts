import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
    parsePack,
    decodeResource,
    strictJson,
} from "enhancement-pack/container";
import { sdtCompatibility } from "enhancement-pack/compatibility";
import { packFixture } from "../fakes/enhancement-pack";

describe("offline Pack container", () => {
    test("hashes only the directory on load and rejects altered content at decode", async () => {
        const f = packFixture();
        const digest = vi.spyOn(crypto.subtle, "digest");
        try {
            const snapshot = await parsePack(f.bytes, "2.0.0", f.expected);
            expect(digest).toHaveBeenCalledTimes(1);
            await decodeResource(snapshot, "stats.bin");
            expect(digest).toHaveBeenCalledTimes(2);
            // Valid gzip with the same decoded size, but wrong resource content.
            snapshot.resources.get("model.onnx")!.encoded =
                new TextEncoder().encode(
                    gzipSync(Buffer.alloc(f.input[0]!.length, 65)).toString(
                        "base64",
                    ),
                );
            await expect(
                decodeResource(snapshot, "model.onnx"),
            ).rejects.toThrow("Resource hash");
            expect(digest).toHaveBeenCalledTimes(3);
        } finally {
            digest.mockRestore();
        }
    });
    test("reads data without running a UTF-8 plugin entry and copies a complete compressed closure", async () => {
        const f = packFixture();
        const snapshot = await parsePack(f.bytes, "2.0.0", f.expected);
        expect(snapshot.resources.size).toBe(2);
        expect(snapshot.resources.get("model.onnx")!.encoded.buffer).not.toBe(
            f.bytes,
        );
        new Uint8Array(f.bytes).fill(0);
        expect(
            new Uint8Array(await decodeResource(snapshot, "model.onnx")),
        ).toEqual(new Uint8Array(f.input[0]!));
        expect("PACK_ENTRY_EXECUTED" in globalThis).toBe(false);
    });
    test.each([
        "append",
        "truncate",
        "crlf",
        "overflow",
        "overlap",
        "missing",
        "hash",
        "size",
        "directory-hash",
        "duplicate",
        "path",
        "major",
        "version",
        "commit",
    ])("rejects %s", async (kind) => {
        const f = packFixture();
        let bytes = f.bytes;
        if (kind === "append")
            bytes = new Uint8Array([...new Uint8Array(bytes), 10]).buffer;
        if (kind === "truncate") bytes = bytes.slice(0, -1);
        if (kind === "crlf")
            bytes = new TextEncoder().encode(
                new TextDecoder().decode(bytes).replace(/\n/g, "\r\n"),
            ).buffer;
        if (kind === "overflow")
            bytes = new TextEncoder().encode(
                new TextDecoder()
                    .decode(bytes)
                    .replace(/ZFEP2\|[0-9a-f]{16}/, "ZFEP2|ffffffffffffffff"),
            ).buffer;
        if (kind === "overlap") {
            f.manifest.resources[1]!.offset = 0;
            bytes = f.build();
        }
        if (kind === "missing") {
            f.manifest.components[0]!.resourcePaths.push("missing.bin");
            bytes = f.build();
        }
        if (kind === "hash") {
            f.manifest.resources[0]!.sha256 = "0".repeat(64);
            bytes = f.build();
        }
        if (kind === "size") {
            f.manifest.resources[0]!.decodedSize++;
            bytes = f.build();
        }
        if (kind === "directory-hash") {
            const altered = new Uint8Array(bytes.slice(0));
            // The last digest character precedes |END*/ and LF.
            const position = altered.length - 8;
            altered[position] = altered[position] === 48 ? 49 : 48;
            bytes = altered.buffer;
        }
        if (kind === "duplicate")
            bytes = f.build(
                JSON.stringify(f.manifest).replace(
                    '"schemaVersion":1',
                    '"schemaVersion":1,"schemaVersion":1',
                ),
            );
        if (kind === "path") {
            f.manifest.resources[0]!.path = "../model.onnx";
            bytes = f.build();
        }
        if (kind === "major")
            bytes = f.build({
                ...f.manifest,
                protocol: { major: 3, minor: 0 },
            });
        if (kind === "version")
            bytes = f.build({
                ...f.manifest,
                pack: { ...f.manifest.pack, version: "3.0.0" },
            });
        if (kind === "commit")
            f.expected = {
                ...f.expected,
                source: {
                    ...f.expected.source,
                    documentWorkerCommit: "c".repeat(40),
                },
            };
        await expect(parsePack(bytes, "2.0.0", f.expected)).rejects.toThrow();
    });
    test("validates gzip bytes only when that resource is requested", async () => {
        const f = packFixture();
        const payload = "!" + f.encoded.join("").slice(1);
        const snapshot = await parsePack(
            f.build(f.manifest, payload),
            "2.0.0",
            f.expected,
        );
        await expect(
            decodeResource(snapshot, "stats.bin"),
        ).resolves.toBeInstanceOf(ArrayBuffer);
        await expect(decodeResource(snapshot, "model.onnx")).rejects.toThrow(
            "base64",
        );
    });
    test("rejects decompression beyond the manifest budget and trailing gzip members", async () => {
        const f = packFixture();
        const snapshot = await parsePack(f.bytes, "2.0.0", f.expected);
        const resource = snapshot.resources.get("model.onnx")!;
        resource.entry.decodedSize = 1;
        await expect(decodeResource(snapshot, "model.onnx")).rejects.toThrow(
            "exceeds",
        );
        resource.entry.decodedSize = f.input[0]!.length;
        resource.encoded = new TextEncoder().encode(
            Buffer.concat([gzipSync(f.input[0]!), gzipSync("")]).toString(
                "base64",
            ),
        );
        await expect(decodeResource(snapshot, "model.onnx")).rejects.toThrow();
    });
    test("duplicate escaped keys are rejected; arrays and quoted punctuation are safe", () => {
        expect(() => strictJson('{"x":1,"\\u0078":2}')).toThrow("Duplicate");
        expect(strictJson('{"x":[{"y":"}:"},{"y":2}]}')).toEqual({
            x: [{ y: "}:" }, { y: 2 }],
        });
    });
    test.runIf(Boolean(process.env.ZF_PACK_BUNDLE))(
        "reads the actual Pack release with ZotFlow's independent consumer",
        async () => {
            const bytes = new Uint8Array(
                readFileSync(process.env.ZF_PACK_BUNDLE!),
            ).buffer;
            const snapshot = await parsePack(bytes, "2.0.0", sdtCompatibility);
            for (const path of sdtCompatibility.resourcePaths)
                await expect(
                    decodeResource(snapshot, path),
                ).resolves.toBeInstanceOf(ArrayBuffer);
        },
        // Full ONNX/WASM resources contend with the entire suite for CPU.
        15_000,
    );
});
