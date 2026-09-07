import { parsePack, decodeResource } from "enhancement-pack/container";
import { PackError, resourceMime } from "enhancement-pack/types";
import type { PackSnapshot, SdtCompatibility } from "enhancement-pack/types";

interface Resources {
    snapshot: PackSnapshot;
    blobs: Map<string, Promise<Blob>>;
    loads: number;
    failed?: Error;
}

/** Runs inside the existing ZotFlow Worker; construction loads no Pack resources. */
export class EnhancementResourceService {
    private snapshots = new Map<string, Resources>();
    private disposed = false;

    async load(
        bytes: ArrayBuffer,
        version: string,
        expected: SdtCompatibility,
    ) {
        this.assertActive();
        const snapshot = await parsePack(bytes, version, expected);
        this.assertActive();
        for (const [snapshotId, resources] of this.snapshots) {
            if (
                resources.snapshot.generationId === snapshot.generationId &&
                !resources.failed
            ) {
                resources.loads++;
                return { snapshotId, generationId: snapshot.generationId };
            }
        }
        const snapshotId = crypto.randomUUID();
        // Failed generations are never reused, even if disk still declares the same hash.
        this.snapshots.set(snapshotId, {
            snapshot,
            blobs: new Map(),
            loads: 1,
        });
        return { snapshotId, generationId: snapshot.generationId };
    }

    async getBlob(snapshotId: string, path: string): Promise<Blob> {
        this.assertActive();
        const resources = this.snapshots.get(snapshotId);
        if (!resources)
            throw new PackError("disposed", "Resource snapshot was released");
        if (resources.failed) throw resources.failed;
        let pending = resources.blobs.get(path);
        if (!pending) {
            // One decode per resource, shared by Reader URLs and local Document Worker calls.
            // Blob is immutable and structured-cloneable; transferring a caller's bytes later
            // cannot detach this cache. No resource URL is created inside the Worker.
            pending = decodeResource(resources.snapshot, path)
                .then((bytes) => {
                    if (this.snapshots.get(snapshotId) !== resources)
                        throw new PackError(
                            "disposed",
                            "Resource snapshot was released during decoding",
                        );
                    if (resources.failed) throw resources.failed;
                    return new Blob([bytes], { type: resourceMime(path) });
                })
                .catch((error: unknown) => {
                    resources.failed =
                        error instanceof Error
                            ? error
                            : new PackError(
                                  "corrupt",
                                  "Resource decoding failed",
                              );
                    resources.blobs.clear();
                    throw resources.failed;
                });
            resources.blobs.set(path, pending);
        }
        return pending;
    }

    async drop(snapshotId: string): Promise<void> {
        // Each successful load owns one reference; the main service drops duplicate loads
        // after merging their leases and drops the retained load when its last lease ends.
        const resources = this.snapshots.get(snapshotId);
        if (resources && --resources.loads === 0)
            this.snapshots.delete(snapshotId);
    }

    dispose(): void {
        this.disposed = true;
        this.snapshots.clear();
    }

    private assertActive(): void {
        if (this.disposed)
            throw new PackError("disposed", "Resource service was disposed");
    }
}
