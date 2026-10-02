import {
    StateField,
    StateEffect,
    type Extension,
    type EditorState,
    type Text,
} from "@codemirror/state";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { TFile } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { LocalDataManager } from "ui/reader/local-data-manager";
import { NoteGoneModal } from "ui/modals/note-gone-modal";
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

const DEBOUNCE_DELAY = 2000;

const editableRegionSyncPlugin = ViewPlugin.fromClass(
    class {
        /** Values are `window.setTimeout` handles — numbers, not Node's `Timeout`. */
        private debouncers = new Map<string, number>();

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
                const attachmentPath = getLocalAttachmentPath(
                    update.state.doc,
                );
                if (attachmentPath !== null) {
                    target = { kind: "local", attachmentPath };
                }
            }
            if (!target) return;

            // Find which regions were touched by the changes
            update.changes.iterChangedRanges((fromA, toA) => {
                for (const region of regions) {
                    // Check if the change range overlaps this region's editable zone
                    if (fromA <= region.to && toA >= region.from) {
                        this.scheduleSync(target, region, update.state);
                    }
                }
            });
        }

        private scheduleSync(
            target: SyncTarget,
            region: EditableRegion,
            state: EditorState,
        ) {
            // PERSIST regions are purely local — never sync them anywhere.
            if (region.type === "PERSIST") return;
            // Local notes only carry ANNO regions.
            if (target.kind === "local" && region.type !== "ANNO") return;

            const debounceKey =
                target.kind === "zotero"
                    ? `${target.libraryId}-${region.key}`
                    : `${target.attachmentPath}-${region.key}`;

            // Clear previous timer for this region
            const existing = this.debouncers.get(debounceKey);
            if (existing !== undefined) {
                window.clearTimeout(existing);
            }

            const timer = window.setTimeout(() => {
                this.debouncers.delete(debounceKey);

                if (region.type === "NOTE") {
                    if (target.kind !== "zotero") return;
                    // NOTE regions: include meta comment for wrapper-div
                    // attributes reconstruction, then convert MD → HTML.
                    const syncFrom = region.metaFrom ?? region.from;
                    const noteContent = state.doc.sliceString(
                        syncFrom,
                        region.to,
                    );
                    const libraryID = target.libraryId;
                    workerBridge.itemNote
                        .updateNoteContent(
                            libraryID,
                            region.key,
                            noteContent,
                            "editor",
                        )
                        .then((result) => {
                            if (result.status !== "gone") return;
                            // The note was deleted in Zotero: the text stays
                            // in this source note until the user chooses.
                            NoteGoneModal.show(services.app, {
                                libraryID,
                                noteKey: region.key,
                                parentKey: result.parentKey,
                                parentExists: result.parentExists,
                                content: () => noteContent,
                            });
                        })
                        .catch(() => {
                            // Background sync — errors logged by worker
                        });
                } else if (region.type === "ANNO") {
                    // ANNO regions live inside blockquotes in the template:
                    //   > <!-- ZF_ANNO_BEG_KEY -->
                    //   > comment text here
                    //   > <!-- ZF_ANNO_END_KEY -->
                    // Strip the leading `> ` prefix from each line first.
                    const content = state.doc.sliceString(
                        region.from,
                        region.to,
                    );
                    const stripped = content.replace(/^>[ \t]?/gm, "");

                    if (target.kind === "zotero") {
                        // MD → restricted HTML happens worker-side.
                        workerBridge.annotation
                            .updateAnnotationComment(
                                target.libraryId,
                                region.key,
                                stripped,
                            )
                            .catch(() => {
                                // Background sync — errors logged by worker
                            });
                    } else {
                        // Local attachment: comments live in the .zf.json
                        // sidecar as Zotero's restricted annotation HTML —
                        // LocalDataManager converts MD → HTML, mirroring the
                        // worker path. No note re-render (the note already
                        // contains the new text).
                        const file = services.app.vault.getAbstractFileByPath(
                            target.attachmentPath,
                        );
                        if (!(file instanceof TFile)) return;

                        new LocalDataManager(file)
                            .updateAnnotationCommentFromNote(
                                region.key,
                                stripped,
                            )
                            .then((changed) => {
                                if (changed) {
                                    // Let an open local reader refresh its cache.
                                    services.eventHub.localAnnotationChanged.emit(
                                        target.attachmentPath,
                                        region.key,
                                    );
                                }
                            })
                            .catch((e) => {
                                services.logService.error(
                                    "Failed to save local annotation comment from note",
                                    "ZotFlowEditableRegion",
                                    e,
                                );
                            });
                    }
                }
            }, DEBOUNCE_DELAY);

            this.debouncers.set(debounceKey, timer);
        }

        destroy() {
            for (const timer of this.debouncers.values()) {
                window.clearTimeout(timer);
            }
            this.debouncers.clear();
        }
    },
);

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
