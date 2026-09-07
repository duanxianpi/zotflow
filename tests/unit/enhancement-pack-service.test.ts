import { describe, test, expect, vi, afterEach } from "vitest";
import { EnhancementPackService } from "services/enhancement-pack-service";
import { EnhancementResourceService } from "worker/services/enhancement-resources";
import { packFixture } from "../fakes/enhancement-pack";

function setup() {
    const fixture = packFixture();
    let bytes = fixture.bytes;
    const processor = new EnhancementResourceService();
    const load = vi.spyOn(processor, "load");
    const getBlob = vi.spyOn(processor, "getBlob");
    const drop = vi.spyOn(processor, "drop");
    const dispose = vi.spyOn(processor, "dispose");
    const adapter = {
        exists: vi.fn(async () => true),
        read: vi.fn(async () =>
            JSON.stringify({
                id: "zotflow-enhancement-pack",
                version: "2.0.0",
            }),
        ),
        readBinary: vi.fn(async () => bytes.slice(0)),
        stat: vi.fn(async () => ({ mtime: 1, size: bytes.byteLength })),
    };
    const factory = vi.fn(() => processor);
    const service = new EnhancementPackService(
        adapter,
        "custom-config",
        fixture.expected,
        factory,
    );
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    return {
        fixture,
        spies: { load, getBlob, drop, dispose },
        processor,
        adapter,
        factory,
        service,
        revoke,
        setBytes: (value: ArrayBuffer) => {
            bytes = value;
        },
    };
}
afterEach(() => vi.restoreAllMocks());
describe("EnhancementPackService", () => {
    test("startup and installation inspection do not read the bundle or start a processor", async () => {
        const h = setup();
        expect(h.factory).not.toHaveBeenCalled();
        await h.service.inspectInstallation();
        expect(h.adapter.readBinary).not.toHaveBeenCalled();
        expect(h.adapter.read).toHaveBeenCalledWith(
            "custom-config/plugins/zotflow-enhancement-pack/manifest.json",
        );
        h.service.dispose();
    });
    test("coalesces reads and decodes, retaining URLs until the last lease ends", async () => {
        const h = setup();
        const [a, b] = await Promise.all([
            h.service.acquireSdtResources(),
            h.service.acquireSdtResources(),
        ]);
        expect(h.adapter.readBinary).toHaveBeenCalledTimes(1);
        expect(h.spies.getBlob).not.toHaveBeenCalled();
        const [url, other] = await Promise.all([
            h.service.getResourceUrl(a.leaseId, "model.onnx"),
            h.service.getResourceUrl(b.leaseId, "model.onnx"),
        ]);
        expect(url).toBe(other);
        expect(h.spies.getBlob).toHaveBeenCalledTimes(1);
        h.service.release(a.leaseId);
        expect(h.revoke).not.toHaveBeenCalled();
        h.service.release(b.leaseId);
        expect(h.revoke).toHaveBeenCalledWith(url);
        expect(h.spies.drop).toHaveBeenCalledTimes(1);
        expect(h.spies.dispose).not.toHaveBeenCalled();
    });
    test("old sessions retain their snapshot when the installed file changes or is removed", async () => {
        const h = setup();
        const lease = await h.service.acquireSdtResources();
        h.setBytes(new ArrayBuffer(0));
        await expect(h.service.acquireSdtResources()).rejects.toThrow();
        const url = await h.service.getResourceUrl(lease.leaseId, "stats.bin");
        expect(await (await fetch(url)).text()).toBe("second resource");
        h.adapter.exists.mockResolvedValue(false);
        await expect(h.service.acquireSdtResources()).rejects.toThrow(
            "Install",
        );
        h.service.release(lease.leaseId);
    });
    test("failed reads can retry and changing files get only one retry", async () => {
        const h = setup();
        h.adapter.readBinary.mockRejectedValueOnce(new Error("unreadable"));
        await expect(h.service.acquireSdtResources()).rejects.toThrow();
        const lease = await h.service.acquireSdtResources();
        h.service.release(lease.leaseId);
        let mtime = 0;
        h.adapter.stat.mockImplementation(async () => ({
            mtime: ++mtime,
            size: h.fixture.bytes.byteLength,
        }));
        await expect(h.service.acquireSdtResources()).rejects.toMatchObject({
            code: "pack-changing",
        });
        h.service.dispose();
    });
    test("dispose during decode does not create a late Blob URL", async () => {
        const h = setup();
        const lease = await h.service.acquireSdtResources();
        let finish!: (blob: Blob) => void;
        vi.mocked(h.spies.getBlob).mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const create = vi.spyOn(URL, "createObjectURL");
        const result = h.service.getResourceUrl(lease.leaseId, "model.onnx");
        h.service.dispose();
        await expect(result).rejects.toThrow("disposed");
        finish(new Blob([new Uint8Array(1)]));
        await Promise.resolve();
        expect(create).not.toHaveBeenCalled();
    });
});
