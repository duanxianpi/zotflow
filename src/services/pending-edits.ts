import type { LogService } from "./log-service";

/** Writes an editor's waiting edits now; resolves once the worker has them. */
export type EditFlusher = () => Promise<void>;

/**
 * Edits the main thread holds back while the user types (each editor
 * debounces its writes), so they can be written on demand: before a sync
 * reads the database, a sync must not upload, or a re-render overwrite, a
 * state older than what is on screen.
 *
 * Editors register a flusher while they are open.
 */
export class PendingEdits {
    private flushers = new Set<EditFlusher>();

    constructor(private logService: LogService) {}

    /** Registers `flush`; returns the unregister function. */
    register(flush: EditFlusher): () => void {
        this.flushers.add(flush);
        return () => {
            this.flushers.delete(flush);
        };
    }

    /** Writes every waiting edit. Never rejects: a failed write is logged. */
    async flushAll(): Promise<void> {
        await Promise.all(
            [...this.flushers].map(async (flush) => {
                try {
                    await flush();
                } catch (e) {
                    this.logService.error(
                        "Failed to write a pending edit",
                        "PendingEdits",
                        e,
                    );
                }
            }),
        );
    }
}
