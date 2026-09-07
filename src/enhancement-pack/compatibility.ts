import lock from "../../document-worker.lock.json";
import type { SdtCompatibility } from "enhancement-pack/types";

/**
 * Build-time import, not runtime vault I/O. Both sides must match the same SDT
 * toolchain and resource records; the Pack's release version alone is insufficient.
 * Archive digests stay in the build pipeline. Runtime compares resource metadata
 * directly, then verifies each requested resource's content once after decoding.
 */
export const sdtCompatibility: SdtCompatibility = {
    source: {
        documentWorkerCommit: lock.documentWorker.commit,
    },
    sdt: lock.enhancementPack.sdt,
    resourcePaths: lock.enhancementPack.resources.map(
        (resource) => resource.path,
    ),
    resources: lock.enhancementPack.resources,
};
