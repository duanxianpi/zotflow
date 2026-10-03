import { workerClearTimeout, workerSetTimeout } from "worker/timers";

import type { IParentProxy } from "bridge/types";
import type { WorkerTimeout } from "worker/timers";
import type { AnnotationService } from "./annotation";
import type { ItemNoteService } from "./item-note";

/** Pause after the last change before an edit is written. */
export const EDIT_QUEUE_DELAY = 2000;

/** Where an edit came from (see `ItemNoteService.updateNoteContent`). */
export type NoteEditOrigin = "editor" | "note-view";

type QueuedEdit =
    | {
          kind: "note";
          libraryID: number;
          key: string;
          content: string;
          origin: NoteEditOrigin;
          /** The note's parent, should the note be gone by the write. */
          parentKeyHint: string;
          /** The top-level item whose source note shows this edit. */
          sourceKey: string;
      }
    | {
          kind: "annotation";
          libraryID: number;
          key: string;
          /** The comment as markdown. */
          content: string;
          sourceKey: string;
      };

/**
 * The edits typed into a source note's regions and into the note editor,
 * held while the user types and written once they pause: one entry per
 * note or annotation, the latest text replacing what is waiting.
 *
 * Kept in the worker, next to what reads them back, so that what would
 * write over or read past them first writes them:
 * - a source note's re-render writes the edits shown in it (`flushFor`),
 *   or it would render the database as it was before them;
 * - a sync writes every edit (`flushAll`) before it uploads.
 *
 * A note found deleted by the write raises `noteGone` with the text, which
 * the main thread offers to save as a new note.
 */
export class EditQueue {
    private pending = new Map<string, { edit: QueuedEdit; timer: WorkerTimeout }>();
    /** Writes under way, so a flush also waits for those. */
    private running = new Map<string, { edit: QueuedEdit; write: Promise<void> }>();

    constructor(
        private parentHost: IParentProxy,
        private itemNote: ItemNoteService,
        private annotation: AnnotationService,
        private delayMs = EDIT_QUEUE_DELAY,
    ) {}

    /** Queues the latest text of a note. */
    submitNote(
        libraryID: number,
        noteKey: string,
        content: string,
        origin: NoteEditOrigin,
        parentKeyHint: string,
        sourceKey: string,
    ): void {
        this.queue({ kind: "note", libraryID, key: noteKey, content, origin, parentKeyHint, sourceKey });
    }

    /** Queues the latest comment (markdown) of an annotation. */
    submitAnnotationComment(libraryID: number, annotationKey: string, markdown: string, sourceKey: string): void {
        this.queue({ kind: "annotation", libraryID, key: annotationKey, content: markdown, sourceKey });
    }

    /** Writes now what is waiting for the source note of `sourceKey`. */
    async flushFor(libraryID: number, sourceKey: string): Promise<void> {
        await this.flush((e) => e.libraryID === libraryID && e.sourceKey === sourceKey);
    }

    /** Writes now everything waiting. */
    async flushAll(): Promise<void> {
        await this.flush(() => true);
    }

    dispose(): void {
        for (const { timer } of this.pending.values()) workerClearTimeout(timer);
        this.pending.clear();
    }

    private queue(edit: QueuedEdit) {
        const id = idOf(edit);
        const waiting = this.pending.get(id);
        if (waiting) workerClearTimeout(waiting.timer);
        const timer = workerSetTimeout(() => void this.write(id), this.delayMs);
        this.pending.set(id, { edit, timer });
    }

    private async flush(match: (edit: QueuedEdit) => boolean): Promise<void> {
        for (const [id, { edit }] of [...this.pending]) {
            if (match(edit)) void this.write(id);
        }
        // Started just now, or earlier: wait for every matching write.
        await Promise.all([...this.running.values()].filter((r) => match(r.edit)).map((r) => r.write));
    }

    /**
     * Writes the waiting edit `id`, after any earlier write of it (two
     * writes of one note never overlap, so the later text lands last).
     * Never rejects: failures are logged.
     */
    private write(id: string): Promise<void> {
        const entry = this.pending.get(id);
        if (!entry) return this.running.get(id)?.write ?? Promise.resolve();
        workerClearTimeout(entry.timer);
        this.pending.delete(id);

        const previous = this.running.get(id)?.write ?? Promise.resolve();
        const write = previous.then(() => this.apply(entry.edit));
        this.running.set(id, { edit: entry.edit, write });
        void write.finally(() => {
            if (this.running.get(id)?.write === write) this.running.delete(id);
        });
        return write;
    }

    private async apply(edit: QueuedEdit): Promise<void> {
        try {
            if (edit.kind === "annotation") {
                await this.annotation.updateAnnotationComment(edit.libraryID, edit.key, edit.content);
                return;
            }
            const result = await this.itemNote.updateNoteContent(
                edit.libraryID,
                edit.key,
                edit.content,
                edit.origin,
                edit.parentKeyHint,
            );
            if (result.status === "gone") {
                this.parentHost.emit("noteGone", {
                    libraryID: edit.libraryID,
                    noteKey: edit.key,
                    parentKey: result.parentKey,
                    parentExists: result.parentExists,
                    content: edit.content,
                });
            }
        } catch (e) {
            this.parentHost.log("error", `Failed to save the edit of ${edit.key}`, "EditQueue", e);
        }
    }
}

function idOf(edit: QueuedEdit): string {
    return `${edit.kind}:${edit.libraryID}:${edit.key}`;
}
