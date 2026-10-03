import {
    StateField,
    StateEffect,
    type Extension,
    type EditorState,
    type Text,
} from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { TFile } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { LocalDataManager } from "ui/reader/local-data-manager";
import { registerNoteTextSource } from "ui/modals/note-gone-modal";
import {
    parseEditableRegions,
    type EditableRegion,
} from "./editable-region-parser";

/* ================================================================ */
/*  Parser (extracted to editable-region-parser.ts — pure, testable) */
/* ================================================================ */

export { parseEditableRegions, type EditableRegion };

/* ================================================================ */
/*  StateField                                                      */
/* ================================================================ */

export const editableRegionsField = StateField.define<EditableRegion[]>({
    create(state) {
        return parseEditableRegions(state.doc);
    },

    update(regions, tr) {
        if (!tr.docChanged) return regions;

        // Programmatic set (vault.modify) may add/remove regions → full reparse
        if (tr.isUserEvent("set")) return parseEditableRegions(tr.newDoc);

        // Fast path: shift all positions via mapPos
        const mapped: EditableRegion[] = [];
        let needsReparse = false;

        for (const r of regions) {
            try {
                const newRegion: EditableRegion = {
                    type: r.type,
                    key: r.key,
                    from: tr.changes.mapPos(r.from, -1),
                    to: tr.changes.mapPos(r.to, 1),
                    begFrom: tr.changes.mapPos(r.begFrom, 1),
                    begTo: tr.changes.mapPos(r.begTo, -1),
                    endFrom: tr.changes.mapPos(r.endFrom, 1),
                    endTo: tr.changes.mapPos(r.endTo, -1),
                    metaFrom:
                        r.metaFrom != null
                            ? tr.changes.mapPos(r.metaFrom, 1)
                            : undefined,
                    metaTo:
                        r.metaTo != null
                            ? tr.changes.mapPos(r.metaTo, -1)
                            : undefined,
                };

                // Validate: editable range must remain positive
                if (
                    newRegion.from > newRegion.to ||
                    newRegion.begFrom > newRegion.begTo ||
                    newRegion.endFrom > newRegion.endTo ||
                    (newRegion.metaFrom != null &&
                        newRegion.metaTo != null &&
                        newRegion.metaFrom > newRegion.metaTo)
                ) {
                    needsReparse = true;
                    break;
                }

                mapped.push(newRegion);
            } catch {
                needsReparse = true;
                break;
            }
        }

        if (needsReparse) {
            return parseEditableRegions(tr.newDoc);
        }

        return mapped;
    },
});

/** Read the editable regions from an EditorState. */
export function getEditableRegions(state: EditorState): EditableRegion[] {
    return state.field(editableRegionsField, false) ?? [];
}

/* ================================================================ */
/*  Frontmatter Helper                                              */
/* ================================================================ */

function getLibraryId(doc: Text): number | null {
    if (doc.sliceString(0, 3) !== "---") return null;

    const head = doc.sliceString(0, 10000);
    const fmMatch = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(
        head,
    );
    if (!fmMatch) return null;

    const match = /^library-id:\s*(\d+)/m.exec(fmMatch[0]);

    return match?.[1] ? Number(match[1]) : null;
}

/**
 * The source note's item (`zotero-key` in frontmatter): the parent of the
 * child notes shown in it.
 */
function getZoteroKey(doc: Text): string | null {
    if (doc.sliceString(0, 3) !== "---") return null;

    const head = doc.sliceString(0, 10000);
    const fmMatch = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(
        head,
    );
    if (!fmMatch) return null;

    const match = /^zotero-key:\s*["']?([A-Za-z0-9]+)["']?\s*$/m.exec(
        fmMatch[0],
    );
    return match?.[1] ?? null;
}

/** Extract the local attachment path from `zotflow-local-attachment: "[[path]]"`. */
export function getLocalAttachmentPath(doc: Text): string | null {
    if (doc.sliceString(0, 3) !== "---") return null;

    const head = doc.sliceString(0, 10000);
    const fmMatch = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(
        head,
    );
    if (!fmMatch) return null;

    const match =
        /^zotflow-local-attachment:\s*["']?\[\[(.+?)\]\]["']?\s*$/m.exec(
            fmMatch[0],
        );

    return match?.[1] ?? null;
}

/** Where region edits should be saved: a Zotero library or a local sidecar. */
type SyncTarget =
    | { kind: "zotero"; libraryId: number }
    | { kind: "local"; attachmentPath: string };

/* ================================================================ */
/*  ViewPlugin — sync edits to Worker                               */
/* ================================================================ */

/** Pause before an annotation comment of a local file is written to its sidecar. */
const LOCAL_DEBOUNCE_DELAY = 2000;

/** The text of NOTE region `key` as sent to the worker (meta comment included), or null. */
export function noteRegionText(state: EditorState, key: string): string | null {
    const region = (state.field(editableRegionsField, false) ?? []).find(
        (r) => r.type === "NOTE" && r.key === key,
    );
    if (!region) return null;
    return state.doc.sliceString(region.metaFrom ?? region.from, region.to);
}

/** A local annotation comment waiting out the debounce. */
interface PendingWrite {
    timer: number;
    /** Writes the comment; resolves once it is in the sidecar. */
    run: () => Promise<void>;
}

/**
 * Sends region edits as the user types. Zotero notes and annotation
 * comments go straight to the worker's edit queue, which debounces and
 * writes them (and writes them first when the source note re-renders or a
 * sync starts). Comments on local files are written to their sidecar here,
 * after a pause.
 */
const editableRegionSyncPlugin = ViewPlugin.fromClass(
    class {
        private pending = new Map<string, PendingWrite>();
        private destroyed = false;
        private unregister: (() => void)[];

        constructor(private readonly view: EditorView) {
            this.unregister = [
                // A sync first writes the sidecar comments still held back.
                services.pendingEdits.register(() => this.flush()),
                // A gone note's prompt reads its latest text from here.
                registerNoteTextSource({
                    text: (libraryID, noteKey) =>
                        this.destroyed ||
                        getLibraryId(this.view.state.doc) !== libraryID
                            ? null
                            : noteRegionText(this.view.state, noteKey),
                }),
            ];
        }

        update(update: ViewUpdate) {
            if (!update.docChanged) return;

            // Skip programmatic updates (e.g. template re-renders via
            // vault.modify()).  Only user-typed edits should sync to the
            // worker — otherwise we get a circular chain
            const isUserEdit = update.transactions.some(
                (tr) =>
                    tr.docChanged &&
                    !tr.isUserEvent("set") &&
                    (tr.isUserEvent("input") ||
                        tr.isUserEvent("delete") ||
                        tr.isUserEvent("move") ||
                        tr.isUserEvent("undo") ||
                        tr.isUserEvent("redo")),
            );
            if (!isUserEdit) return;

            const regions = update.state.field(editableRegionsField, false);
            if (!regions || regions.length === 0) return;

            const libraryId = getLibraryId(update.state.doc);
            let target: SyncTarget | null = null;
            if (libraryId !== null) {
                target = { kind: "zotero", libraryId };
            } else {
                const attachmentPath = getLocalAttachmentPath(update.state.doc);
                if (attachmentPath !== null) {
                    target = { kind: "local", attachmentPath };
                }
            }
            if (!target) return;

            // Find which regions were touched by the changes
            const touched = new Set<EditableRegion>();
            update.changes.iterChangedRanges((fromA, toA) => {
                for (const region of regions) {
                    // Check if the change range overlaps this region's editable zone
                    if (fromA <= region.to && toA >= region.from) {
                        touched.add(region);
                    }
                }
            });
            for (const region of touched) {
                this.send(target, region, update.state);
            }
        }

        /** Writes the sidecar comments still held back. */
        flush(): Promise<void> {
            const runs = [...this.pending.values()];
            this.pending.clear();
            for (const p of runs) window.clearTimeout(p.timer);
            return Promise.all(runs.map((p) => p.run())).then(() => undefined);
        }

        private send(
            target: SyncTarget,
            region: EditableRegion,
            state: EditorState,
        ) {
            // PERSIST regions are purely local — never sync them anywhere.
            if (region.type === "PERSIST") return;

            if (target.kind === "zotero") {
                // The source note's item: the parent of its child notes, and
                // the note whose render must first write these edits.
                const sourceKey = getZoteroKey(state.doc) ?? "";
                if (region.type === "NOTE") {
                    // NOTE regions: include meta comment for wrapper-div
                    // attributes reconstruction, then convert MD → HTML.
                    const content = state.doc.sliceString(
                        region.metaFrom ?? region.from,
                        region.to,
                    );
                    workerBridge.editQueue
                        .submitNote(
                            target.libraryId,
                            region.key,
                            content,
                            "editor",
                            sourceKey,
                            sourceKey,
                        )
                        .catch((e: unknown) => this.reportSendFailure(e));
                } else if (region.type === "ANNO") {
                    // MD → restricted HTML happens worker-side.
                    workerBridge.editQueue
                        .submitAnnotationComment(
                            target.libraryId,
                            region.key,
                            annoCommentText(state, region),
                            sourceKey,
                        )
                        .catch((e: unknown) => this.reportSendFailure(e));
                }
                return;
            }

            // Local notes only carry ANNO regions.
            if (region.type !== "ANNO") return;
            const debounceKey = `${target.attachmentPath}-${region.key}`;
            const existing = this.pending.get(debounceKey);
            if (existing !== undefined) window.clearTimeout(existing.timer);

            const run = () =>
                this.writeLocalComment(
                    target.attachmentPath,
                    region.key,
                    annoCommentText(state, region),
                );
            const timer = window.setTimeout(() => {
                this.pending.delete(debounceKey);
                void run();
            }, LOCAL_DEBOUNCE_DELAY);
            this.pending.set(debounceKey, { timer, run });
        }

        private reportSendFailure(e: unknown) {
            services.logService.error(
                "Failed to send an edit to the worker",
                "ZotFlowEditableRegion",
                e,
            );
        }

        /**
         * Local attachment: comments live in the .zf.json sidecar as Zotero's
         * restricted annotation HTML — LocalDataManager converts MD → HTML,
         * mirroring the worker path. No note re-render (the note already
         * contains the new text). Never rejects.
         */
        private async writeLocalComment(
            attachmentPath: string,
            annotationKey: string,
            comment: string,
        ): Promise<void> {
            const file = services.app.vault.getAbstractFileByPath(attachmentPath);
            if (!(file instanceof TFile)) return;
            try {
                const changed = await new LocalDataManager(
                    file,
                ).updateAnnotationCommentFromNote(annotationKey, comment);
                if (changed) {
                    // Let an open local reader refresh its cache.
                    services.eventHub.localAnnotationChanged.emit(
                        attachmentPath,
                        annotationKey,
                    );
                }
            } catch (e) {
                services.logService.error(
                    "Failed to save local annotation comment from note",
                    "ZotFlowEditableRegion",
                    e,
                );
            }
        }

        destroy() {
            // Closing the editor writes what it still holds back.
            void this.flush();
            this.destroyed = true;
            for (const unregister of this.unregister) unregister();
        }
    },
);

/**
 * An ANNO region's comment. ANNO regions live inside blockquotes in the
 * template:
 *   > <!-- ZF_ANNO_BEG_KEY -->
 *   > comment text here
 *   > <!-- ZF_ANNO_END_KEY -->
 * so the leading `> ` of each line is stripped.
 */
function annoCommentText(state: EditorState, region: EditableRegion): string {
    return state.doc
        .sliceString(region.from, region.to)
        .replace(/^>[ \t]?/gm, "");
}

/* ================================================================ */
/*  Region Unlock Toggle                                            */
/* ================================================================ */

/** Dispatched to toggle a region's lock state by key. */
export const toggleRegionLockEffect = StateEffect.define<string>();

/** Tracks which region keys are currently unlocked by the user. */
export const unlockedRegionsField = StateField.define<Set<string>>({
    create() {
        return new Set();
    },

    update(unlocked, tr) {
        let next = unlocked;
        for (const effect of tr.effects) {
            if (effect.is(toggleRegionLockEffect)) {
                next = new Set(next);
                if (next.has(effect.value)) {
                    next.delete(effect.value);
                } else {
                    next.add(effect.value);
                }
            }
        }
        return next;
    },
});

/* ================================================================ */
/*  Extension Factory                                               */
/* ================================================================ */

/** CM6 extension for editable regions: StateField tracking + unlock toggle + ViewPlugin sync. */
export function ZotFlowEditableRegionExtension(): Extension {
    return [
        editableRegionsField,
        unlockedRegionsField,
        editableRegionSyncPlugin,
    ];
}
