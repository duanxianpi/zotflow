/**
 * EditQueue — the worker-side queue of edits typed into source notes and
 * the note editor: debounced per note, written first when a source note
 * re-renders or a sync starts, and reporting notes found deleted.
 */
import { describe, test, expect, afterEach } from "vitest";
import { EditQueue } from "worker/services/edit-queue";
import { createFakeParentHost } from "../fakes/parent-host";

import type { AnnotationService } from "worker/services/annotation";
import type { ItemNoteService, NoteSaveResult } from "worker/services/item-note";

const LIB = 1;
const DELAY = 30;

interface Write {
    key: string;
    content: string;
}

function setup(options: { gone?: string[]; writeMs?: number } = {}) {
    const host = createFakeParentHost();
    const writes: Write[] = [];
    let active = 0;
    let overlapped = false;
    const itemNote = {
        updateNoteContent: async (_lib: number, key: string, content: string): Promise<NoteSaveResult> => {
            active++;
            if (active > 1) overlapped = true;
            await new Promise((r) => setTimeout(r, options.writeMs ?? 0));
            active--;
            if (options.gone?.includes(key)) return { status: "gone", parentKey: "PARENT01", parentExists: true };
            writes.push({ key, content });
            return { status: "saved" };
        },
    } as unknown as ItemNoteService;
    const annotation = {
        updateAnnotationComment: async (_lib: number, key: string, content: string) => {
            writes.push({ key, content });
        },
    } as unknown as AnnotationService;
    const queue = new EditQueue(host, itemNote, annotation, DELAY);
    return { host, writes, queue, overlapped: () => overlapped };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let queue: EditQueue | undefined;
afterEach(() => queue?.dispose());

describe("EditQueue", () => {
    test("writes the latest text once the user pauses", async () => {
        const s = setup();
        queue = s.queue;
        s.queue.submitNote(LIB, "NOTE0001", "a", "editor", "PARENT01", "PARENT01");
        s.queue.submitNote(LIB, "NOTE0001", "ab", "editor", "PARENT01", "PARENT01");
        s.queue.submitNote(LIB, "NOTE0001", "abc", "editor", "PARENT01", "PARENT01");
        expect(s.writes).toEqual([]);

        await sleep(DELAY * 3);

        expect(s.writes).toEqual([{ key: "NOTE0001", content: "abc" }]);
    });

    test("a source note's flush writes its edits now, and only its own", async () => {
        const s = setup();
        queue = s.queue;
        s.queue.submitNote(LIB, "NOTE0001", "mine", "editor", "PARENT01", "PARENT01");
        s.queue.submitAnnotationComment(LIB, "ANNO0001", "comment", "PARENT01");
        s.queue.submitNote(LIB, "NOTE0002", "other", "editor", "PARENT02", "PARENT02");

        await s.queue.flushFor(LIB, "PARENT01");

        expect(s.writes).toHaveLength(2);
        expect(s.writes).toEqual(
            expect.arrayContaining([
                { key: "NOTE0001", content: "mine" },
                { key: "ANNO0001", content: "comment" },
            ]),
        );
        await s.queue.flushAll();
        expect(s.writes.map((w) => w.key)).toContain("NOTE0002");
    });

    test("a flush waits for a write already under way", async () => {
        const s = setup({ writeMs: 40 });
        queue = s.queue;
        s.queue.submitNote(LIB, "NOTE0001", "text", "editor", "PARENT01", "PARENT01");
        await sleep(DELAY + 10); // the timer fired; the write is running

        await s.queue.flushFor(LIB, "PARENT01");

        expect(s.writes).toEqual([{ key: "NOTE0001", content: "text" }]);
    });

    test("two writes of one note never overlap; the later text lands last", async () => {
        const s = setup({ writeMs: 30 });
        queue = s.queue;
        s.queue.submitNote(LIB, "NOTE0001", "first", "editor", "PARENT01", "PARENT01");
        const first = s.queue.flushAll();
        s.queue.submitNote(LIB, "NOTE0001", "second", "editor", "PARENT01", "PARENT01");
        await Promise.all([first, s.queue.flushAll()]);

        expect(s.overlapped()).toBe(false);
        expect(s.writes.map((w) => w.content)).toEqual(["first", "second"]);
    });

    test("a note found deleted is reported with the text that could not be saved", async () => {
        const s = setup({ gone: ["NOTE0001"] });
        queue = s.queue;
        s.queue.submitNote(LIB, "NOTE0001", "kept text", "editor", "PARENT01", "PARENT01");

        await s.queue.flushAll();

        expect(s.host.events).toContainEqual({
            name: "noteGone",
            args: [{ libraryID: LIB, noteKey: "NOTE0001", parentKey: "PARENT01", parentExists: true, content: "kept text" }],
        });
    });

    test("dispose drops the timers", async () => {
        const s = setup();
        s.queue.submitNote(LIB, "NOTE0001", "text", "editor", "PARENT01", "PARENT01");
        s.queue.dispose();
        await sleep(DELAY * 2);
        expect(s.writes).toEqual([]);
    });
});
