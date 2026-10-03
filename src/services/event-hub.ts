import { EventBus } from "services/event-bus";

import type { ITaskInfo } from "types/tasks";

/**
 * Main-thread data-change events: "this data changed, refresh what shows
 * it". Each field is one event type. The hub holds no state and depends on
 * no service; emitters and subscribers find it through the ServiceLocator.
 */
export class EventHub {
    /** Fires when an annotation is created/updated/deleted (from editor or reader). */
    public readonly annotationChanged = new EventBus<
        [libraryID: number, annotationKey: string, parentItemKey: string]
    >();

    /** Fires when a LOCAL attachment's annotation is edited from the source-note editable region. */
    public readonly localAnnotationChanged = new EventBus<
        [attachmentPath: string, annotationId: string]
    >();

    /** Fires when a child note is created or updated from the source-note editable region. */
    public readonly noteChangedByEditor = new EventBus<
        [libraryID: number, noteKey: string, parentItemKey: string]
    >();

    /** Fires when a child note is created or updated from the standalone NotePreviewView. */
    public readonly noteChangedByNoteView = new EventBus<
        [libraryID: number, noteKey: string, parentItemKey: string]
    >();

    /**
     * Fires when the tree data should be refreshed. With a change, only those
     * items' fields changed (names, tags, sync status) and the tree is
     * patched; without one (e.g. an item deleted) it is rebuilt.
     */
    public readonly treeChanged = new EventBus<[change?: TreeChange]>();

    /**
     * Fires when an edit reaches a note deleted in Zotero (and removed by a
     * sync): its text is offered to be saved as a new note.
     */
    public readonly noteGone = new EventBus<[note: NoteGoneEvent]>();

    /**
     * Fires once when a sync task reaches a terminal state (completed,
     * failed or cancelled). `task.input.libraryId`, when present, names the
     * only library the sync covered.
     */
    public readonly syncFinished = new EventBus<[task: ITaskInfo]>();
}

/** An edit that reached a note no longer in the database. */
export interface NoteGoneEvent {
    libraryID: number;
    noteKey: string;
    parentKey: string;
    parentExists: boolean;
    /** The text that could not be saved. */
    content: string;
}

/** Items whose fields changed without changing the tree's shape. */
export interface TreeChange {
    libraryID: number;
    keys: string[];
}

/** The argument tuple of an EventHub event. */
export type EventArgs<K extends keyof EventHub> =
    EventHub[K] extends EventBus<infer A> ? A : never;

/**
 * The EventHub events the worker raises through `ParentHost.emit`. The
 * rest originate on the main thread.
 */
export type WorkerEventName =
    | "annotationChanged"
    | "noteChangedByEditor"
    | "noteChangedByNoteView"
    | "treeChanged"
    | "noteGone";
