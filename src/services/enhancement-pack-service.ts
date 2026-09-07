import * as Comlink from "comlink";
import type { EnhancementResourceService } from "worker/services/enhancement-resources";
import { PACK_ID, PACK_LIMITS, PackError } from "enhancement-pack/types";
import type { PackLease, SdtCompatibility } from "enhancement-pack/types";
type Processor = Pick<EnhancementResourceService, "load" | "getBlob" | "drop">;
type LoadedPack = Awaited<ReturnType<Processor["load"]>>;

/** Minimal vault adapter surface; avoids desktop-only filesystem APIs in this service. */
export interface PackAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    readBinary(path: string): Promise<ArrayBuffer>;
    stat(path: string): Promise<{ mtime: number; size: number } | null>;
}
// A generation groups leases and URLs around one retained Worker snapshot.
// Old and new generations may coexist during a Pack update, but never mix resources.
interface Generation extends LoadedPack {
    refs: number;
    urls: Map<string, string>;
    pending: Map<string, Promise<string>>;
    failed?: Error;
}

/** Main-thread owner of URLs and leases; no I/O or Worker creation at startup. */
export class EnhancementPackService {
    private processor?: Processor;
    private stop = new AbortController();
    private loading?: Promise<Generation>;
    private generations = new Set<Generation>();
    private leases = new Map<string, Generation>();
    private disposed = false;
    // Keeps a newly loaded generation alive until all waiting callers receive their leases.
    private pendingAcquires = 0;
    private directory: string;

    constructor(
        private adapter: PackAdapter,
        configDir: string,
        private expected: SdtCompatibility,
        private getProcessor: () => Processor,
        private logCleanupError: (error: unknown) => void = () => {},
    ) {
        this.directory = `${configDir}/plugins/${PACK_ID}`;
    }

    /** Cheap installation check; it neither reads main.js nor verifies resource contents. */
    async inspectInstallation(): Promise<{
        installed: boolean;
        version?: string;
    }> {
        this.assertActive();
        if (!(await this.adapter.exists(`${this.directory}/manifest.json`)))
            return { installed: false };
        return { installed: true, version: await this.readVersion() };
    }
    private assertActive(): void {
        if (this.disposed)
            throw new PackError(
                "disposed",
                "Enhancement Pack service was disposed",
            );
    }
    private async readVersion(): Promise<string> {
        const value: unknown = JSON.parse(
            await this.adapter.read(`${this.directory}/manifest.json`),
        );
        if (
            typeof value !== "object" ||
            value === null ||
            !("id" in value) ||
            value.id !== PACK_ID ||
            !("version" in value) ||
            typeof value.version !== "string"
        )
            throw new PackError("corrupt", "Invalid installed Pack manifest");
        return value.version;
    }
    private async load(): Promise<Generation> {
        const path = `${this.directory}/main.js`;
        try {
            if (
                !(await this.adapter.exists(path)) ||
                !(await this.adapter.exists(`${this.directory}/manifest.json`))
            ) {
                throw new PackError(
                    "not-installed",
                    "Install ZotFlow Enhancement Pack; it can remain disabled",
                );
            }
            // Detect an update spanning this read and retry once. stat is only a change
            // hint: every new acquire still reads and validates the installed directory.
            for (let attempt = 0; attempt < 2; attempt++) {
                const version = await this.readVersion();
                const before = await this.adapter.stat(path).catch(() => null);
                if (before && before.size > PACK_LIMITS.file)
                    throw new PackError(
                        "resource-limit",
                        "Pack file is too large",
                    );
                const bytes = await this.adapter.readBinary(path);
                const after = await this.adapter.stat(path).catch(() => null);
                const afterVersion = await this.readVersion();
                this.assertActive();
                if (
                    version !== afterVersion ||
                    (before &&
                        after &&
                        (before.mtime !== after.mtime ||
                            before.size !== after.size))
                )
                    continue;
                this.processor ??= this.getProcessor();
                const result = await this.waitFor(
                    this.processor
                        .load(
                            Comlink.transfer(bytes, [bytes]),
                            version,
                            this.expected,
                        )
                        .then((result) => {
                            if (this.disposed) this.drop(result.snapshotId);
                            return result;
                        }),
                );
                this.assertActive();
                const existing = [...this.generations].find(
                    (g) => g.snapshotId === result.snapshotId && !g.failed,
                );
                if (existing) {
                    // Keep live URLs and release the extra load reference to this snapshot.
                    this.drop(result.snapshotId);
                    return existing;
                }
                const generation: Generation = {
                    ...result,
                    refs: 0,
                    urls: new Map(),
                    pending: new Map(),
                };
                this.generations.add(generation);
                return generation;
            }
            throw new PackError(
                "pack-changing",
                "Enhancement Pack changed while being read",
            );
        } catch (error) {
            const packError = PackError.from(error);
            if (packError) throw packError;
            throw new PackError(
                "unreadable",
                "Cannot read installed Enhancement Pack",
            );
        }
    }
    /** One lease per consumer lifetime, normally the nested Document Worker's lifetime. */
    async acquireSdtResources(): Promise<PackLease> {
        this.assertActive();
        this.pendingAcquires++;
        try {
            // Share only the in-flight read. Clearing it also allows retries after failure.
            this.loading ??= this.load().finally(() => {
                this.loading = undefined;
            });
            const generation = await this.waitFor(this.loading);
            this.assertActive();
            const leaseId = crypto.randomUUID();
            generation.refs++;
            this.leases.set(leaseId, generation);
            return {
                leaseId,
                generationId: generation.generationId,
                snapshotId: generation.snapshotId,
            };
        } finally {
            this.pendingAcquires--;
            this.collectUnused();
        }
    }

    async getResourceUrl(leaseId: string, path: string): Promise<string> {
        this.assertActive();
        const generation = this.leases.get(leaseId);
        if (!generation || !this.expected.resourcePaths.includes(path))
            throw new PackError("corrupt", "Invalid resource lease or path");
        if (generation.failed) throw generation.failed;
        const cached = generation.urls.get(path);
        if (cached) return cached;
        let pending = generation.pending.get(path);
        if (!pending) {
            // Requests for this path share one decode and one URL within the generation.
            pending = this.waitFor(
                this.processor!.getBlob(generation.snapshotId, path),
            )
                .then((blob) => {
                    // The consumer or plugin may have gone away while decoding. Check
                    // before creating a URL so late results cannot leak a resource.
                    this.assertActive();
                    if (generation.failed) throw generation.failed;
                    if (generation.refs === 0)
                        throw new PackError(
                            "disposed",
                            "Resource lease was released during decoding",
                        );
                    const url = URL.createObjectURL(blob);
                    generation.urls.set(path, url);
                    return url;
                })
                .catch((error: unknown) => {
                    // Do not continue a partially loaded component after a resource fails.
                    // Recovery requires a fresh acquire, preserving existing lease identity.
                    generation.failed =
                        PackError.from(error) ??
                        (error instanceof Error
                            ? error
                            : new PackError(
                                  "corrupt",
                                  "Resource decoding failed",
                              ));
                    throw generation.failed;
                })
                .finally(() => {
                    generation.pending.delete(path);
                });
            generation.pending.set(path, pending);
        }
        const url = await pending;
        // Other leases can keep shared work alive after this particular caller releases.
        if (!this.leases.has(leaseId))
            throw new PackError("disposed", "Resource lease was released");
        return url;
    }
    /** Idempotent; consumers must stop using resource URLs before releasing their lease. */
    release(leaseId: string): void {
        const generation = this.leases.get(leaseId);
        if (!generation) return;
        this.leases.delete(leaseId);
        generation.refs--;
        this.collectUnused();
    }
    private collectUnused(): void {
        // A load may have finished without its waiting acquire continuations running yet.
        // Reclaiming a zero-ref generation here would invalidate their forthcoming leases.
        if (this.pendingAcquires) return;
        for (const generation of this.generations) {
            if (generation.refs !== 0) continue;
            for (const url of generation.urls.values())
                URL.revokeObjectURL(url);
            generation.urls.clear();
            this.drop(generation.snapshotId);
            this.generations.delete(generation);
        }
    }
    // Comlink handles RPC matching. This abort only settles local callers when the shared
    // Worker terminates; it neither cancels other services nor implements a second transport.
    private waitFor<T>(operation: Promise<T>): Promise<T> {
        const signal = this.stop.signal;
        return new Promise<T>((resolve, reject) => {
            const abort = () =>
                reject(
                    new PackError(
                        "disposed",
                        "Enhancement Pack service was disposed",
                    ),
                );
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
            void operation
                .then(resolve, reject)
                .finally(() => signal.removeEventListener("abort", abort));
        });
    }
    private drop(snapshotId: string): void {
        if (this.processor)
            void this.processor.drop(snapshotId).catch(this.logCleanupError);
    }
    /** Plugin teardown: stop processing first, then revoke every resource URL we own. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.stop.abort();
        for (const generation of this.generations) {
            for (const url of generation.urls.values())
                URL.revokeObjectURL(url);
        }
        for (const generation of this.generations)
            this.drop(generation.snapshotId);
        this.generations.clear();
        this.leases.clear();
    }
}
