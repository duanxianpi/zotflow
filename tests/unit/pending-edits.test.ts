/**
 * The main-thread registry of edits editors hold back while the user types,
 * written on demand before a sync.
 */
import { describe, test, expect } from "vitest";
import { PendingEdits } from "services/pending-edits";
import { LogService } from "services/log-service";

describe("PendingEdits", () => {
    test("flushAll waits for every registered editor's write", async () => {
        const edits = new PendingEdits(new LogService());
        const written: string[] = [];
        edits.register(async () => {
            await new Promise((r) => setTimeout(r, 5));
            written.push("source note");
        });
        edits.register(async () => {
            written.push("note editor");
        });

        await edits.flushAll();

        expect(written.sort()).toEqual(["note editor", "source note"]);
    });

    test("an unregistered editor is not flushed", async () => {
        const edits = new PendingEdits(new LogService());
        let flushed = false;
        const unregister = edits.register(async () => {
            flushed = true;
        });
        unregister();

        await edits.flushAll();

        expect(flushed).toBe(false);
    });

    test("a failed write is logged and does not stop the others", async () => {
        const log = new LogService();
        const edits = new PendingEdits(log);
        let other = false;
        edits.register(() => Promise.reject(new Error("worker gone")));
        edits.register(async () => {
            other = true;
        });

        await expect(edits.flushAll()).resolves.toBeUndefined();

        expect(other).toBe(true);
        expect(log.logs.some((l) => l.level === "error" && /pending edit/.test(l.message))).toBe(true);
    });
});
