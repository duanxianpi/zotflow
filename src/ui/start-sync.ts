import { workerBridge } from "bridge";
import { services } from "services/services";

/**
 * Starts a sync (of every library, or of `libraryId`) once the edits that
 * open editors still hold back are written: the sync must not upload an
 * older state than the one on screen. Every sync started from the UI goes
 * through here.
 */
export async function startSync(libraryId?: number): Promise<string> {
    await services.pendingEdits.flushAll();
    return workerBridge.createSyncTask(libraryId);
}
