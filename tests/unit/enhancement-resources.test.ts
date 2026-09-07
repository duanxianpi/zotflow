import { describe, expect, test, vi } from "vitest";
import * as Comlink from "comlink";
import { EnhancementResourceService } from "worker/services/enhancement-resources";
import { EnhancementPackService } from "services/enhancement-pack-service";
import { PackError } from "enhancement-pack/types";
import type { PackLease } from "enhancement-pack/types";
import { packFixture } from "../fakes/enhancement-pack";

describe("resources in the shared ZotFlow Worker", () => {
    test("shares decoded Blobs, protects cached data from transfer and drops the final load", async () => {
        const f = packFixture();
        const service = new EnhancementResourceService();
        const a = await service.load(f.bytes, "2.0.0", f.expected);
        const b = await service.load(f.bytes, "2.0.0", f.expected);
        expect(a.snapshotId).toBe(b.snapshotId);
        const digest = vi.spyOn(crypto.subtle, "digest");
        try {
            const [one, two] = await Promise.all([
                service.getBlob(a.snapshotId, "model.onnx"),
                service.getBlob(b.snapshotId, "model.onnx"),
            ]);
            expect(one).toBe(two);
            expect(digest).toHaveBeenCalledTimes(1);
            const bytes = await one.arrayBuffer();
            structuredClone(bytes, { transfer: [bytes] });
            expect(bytes.byteLength).toBe(0);
            await service.drop(a.snapshotId);
            expect(
                await (
                    await service.getBlob(b.snapshotId, "model.onnx")
                ).text(),
            ).toBe("model fixture");
            await service.drop(b.snapshotId);
            await expect(
                service.getBlob(b.snapshotId, "model.onnx"),
            ).rejects.toMatchObject({ code: "disposed" });
        } finally {
            digest.mockRestore();
            service.dispose();
        }
    });

    test("does not reuse a failed snapshot after reinstalling the same declared generation", async () => {
        const f = packFixture();
        const service = new EnhancementResourceService();
        const bad = await service.load(
            f.build(f.manifest, "!" + f.encoded.join("").slice(1)),
            "2.0.0",
            f.expected,
        );
        await expect(
            service.getBlob(bad.snapshotId, "model.onnx"),
        ).rejects.toThrow();
        const good = await service.load(f.bytes, "2.0.0", f.expected);
        expect(good.generationId).toBe(bad.generationId);
        expect(good.snapshotId).not.toBe(bad.snapshotId);
        expect(
            await (await service.getBlob(good.snapshotId, "model.onnx")).text(),
        ).toBe("model fixture");
        service.dispose();
    });

    test("Comlink permits Worker → ParentHost → same Worker acquisition and preserves errors", async () => {
        const f = packFixture();
        const resources = new EnhancementResourceService();
        let acquire!: () => Promise<PackLease>;
        const api = {
            resources: Comlink.proxy(resources),
            init(callback: () => Promise<PackLease>) {
                acquire = callback;
            },
            async consume() {
                const lease = await acquire();
                return {
                    lease,
                    text: await (
                        await resources.getBlob(lease.snapshotId, "model.onnx")
                    ).text(),
                };
            },
        };
        const channel = new MessageChannel();
        Comlink.expose(api, channel.port1);
        const remote = Comlink.wrap<typeof api>(channel.port2);
        const processor = await Promise.resolve(remote.resources);
        let transferred!: ArrayBuffer;
        const main = new EnhancementPackService(
            {
                exists: async () => true,
                read: async () =>
                    JSON.stringify({
                        id: "zotflow-enhancement-pack",
                        version: "2.0.0",
                    }),
                readBinary: async () => (transferred = f.bytes.slice(0)),
                stat: async () => ({ mtime: 1, size: f.bytes.byteLength }),
            },
            "custom-config",
            f.expected,
            () => processor,
        );
        try {
            await remote.init(Comlink.proxy(() => main.acquireSdtResources()));
            const result = await remote.consume();
            expect(result.text).toBe("model fixture");
            expect(transferred.byteLength).toBe(0);
            const url = await main.getResourceUrl(
                result.lease.leaseId,
                "model.onnx",
            );
            expect(await (await fetch(url)).text()).toBe("model fixture");
            main.release(result.lease.leaseId);
            await expect(
                processor
                    .getBlob(result.lease.snapshotId, "model.onnx")
                    .catch((error) => {
                        throw PackError.from(error) ?? error;
                    }),
            ).rejects.toMatchObject({ code: "disposed" });
            await expect(
                processor
                    .load(new ArrayBuffer(0), "2.0.0", f.expected)
                    .catch((error) => {
                        throw PackError.from(error) ?? error;
                    }),
            ).rejects.toMatchObject({ code: "corrupt" });
        } finally {
            main.dispose();
            resources.dispose();
            if (acquire)
                (
                    acquire as unknown as Comlink.Remote<
                        () => Promise<PackLease>
                    >
                )[Comlink.releaseProxy]();
            processor[Comlink.releaseProxy]();
            remote[Comlink.releaseProxy]();
            channel.port1.close();
            channel.port2.close();
        }
    });
});
