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

    /** Fires when the tree data should be refreshed (e.g. item deleted). */
    public readonly treeChanged = new EventBus<[]>();

    /**
     * Fires once when a sync task reaches a terminal state (completed,
     * failed or cancelled). `task.input.libraryId`, when present, names the
     * only library the sync covered.
     */
    public readonly syncFinished = new EventBus<[task: ITaskInfo]>();
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
    | "treeChanged";
