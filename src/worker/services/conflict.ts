import { db } from "db/db";
import {
    deleteQueueEntry,
    putGroup,
    readKey,
    syncTransaction,
    SyncWriter,
} from "db/sync/commit";
import {
    acceptRemote,
    acceptRemoteBlocked,
    acceptRemoteCopy,
    keepLocalBlocked,
    groupKeepLocal,
    keepLocal,
    mergeBase,
    mergeConflictFields,
    mergedData,
} from "db/sync/decide";
import { sameContent } from "db/sync/reconcile";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import { stripLeadingNoteMeta } from "utils/note-meta";
import { deleteRemovedItemFiles } from "worker/services/removed-items";

import type { IParentProxy } from "bridge/types";
import type { ConvertService } from "worker/services/convert";
import type { ZotFlowSettings } from "settings/types";
import type { FieldChoice } from "db/sync/decide";

export type { FieldChoice };
import type { KeyState } from "db/sync/model";
import type {
    AnyIDBZoteroItem,
    IDBSyncConflict,
    ItemDataJSON,
    SyncConflictKind,
} from "types/db-schema";

/* ================================================================ */
/*  Public types                                                   */
/* ================================================================ */

/** Discriminator for conflict resolution strategy. */
export type ConflictAction = "keep-local" | "accept-remote";

/**
 * Every way the Activity Center resolves a conflict. The `-copy` variants
 * exist for an item changed on both sides only: one side's copy whole, so
 * the other side's changes that did not conflict are given up too.
 */
export type ConflictResolution = ConflictAction | "keep-local-copy" | "accept-remote-copy";

/** Where a merge takes a field from. */
export type FieldMerge =
    /** Changed here only: the local value, uploaded. */
    | "local"
    /** Changed in Zotero only: the remote value, taken here. */
    | "remote"
    /** Both sides' changes combined (tags, collections, relations). */
    | "combined"
    /** Changed differently on both sides: the user picks. */
    | "conflict";

/** A single field-level diff entry */
export interface FieldDiff {
    field: string;
    /** Undefined when the local side does not exist (deleted here). */
    localValue?: string;
    /** Undefined when the remote side does not exist (deleted in Zotero). */
    remoteValue?: string;
    /** The value both sides started from, when it is known. */
    baseValue?: string;
    /** `changed` conflicts only: where a resolution takes the field from (`conflict`: the side chosen). */
    merge?: FieldMerge;
    /** `changed` conflicts only: the value both resolutions keep for a field that did not conflict. */
    mergedValue?: string;
    /** The values are raw HTML (a Markdown conversion failed): shown as they are, not diffed. */
    noDiff?: true;
}

/** What one resolution of a conflict that is not `changed` does. */
export interface ResolutionOutcome {
    /** A few words on what happens, for the option itself. */
    hint: string;
    /** A sentence on what happens. */
    effect: string;
    /** Objects sent to Zotero on the next sync. */
    push: number;
    /** Objects changed or removed here to match Zotero. */
    pull: number;
    /** What is lost, if anything. */
    loses?: string;
}

/** Why a conflict exists, for the UI. */
export interface ConflictDetails {
    /** A short label for the kind. */
    label: string;
    /** Why ZotFlow could not settle it alone. */
    explanation: string;
    detectedAt: string;
    /** The server version both sides started from (none: no common base). */
    baseVersion?: number;
    /** The server version this device's copy is from (0: never uploaded). */
    localVersion: number;
    localModified?: string;
    remoteModified?: string;
    /** The server's answer, for a refused write. */
    serverError?: string;
    parent?: { key: string; title: string };
    /** The topmost item deleted in Zotero, for a member of a deletion group. */
    groupRoot?: { key: string; title: string };
}

/** The kind of conflict as the UI groups it (derived from `kind`). */
export type ItemConflictType =
    | "update" // both sides changed
    | "delete" // deleted on one side, changed on the other
    | "push"; // the server refused the write

/** Full detail of a single item-level sync conflict. */
export interface ConflictItemInfo {
    libraryID: number;
    key: string;
    itemType: string;
    title: string;
    kind: SyncConflictKind;
    conflictType: ItemConflictType;
    /** A sentence on what happened, for the UI. */
    syncError: string;
    /** One or two sentences on what happened to this item, for the panel. */
    summary: string;
    details: ConflictDetails;
    fields: FieldDiff[];
    /** The fields changed differently on both sides: Keep Local keeps the local value of these. */
    conflictFields: string[];
    /** The local side (`{ deleted: true }` when deleted here). */
    localData?: ItemDataJSON;
    /** The remote side (`{ deleted: true }` when deleted in Zotero). */
    remoteData?: ItemDataJSON;
    /** The server version the remote side is from (0: none). */
    remoteVersion: number;
    /** The remote-deletion group (its root key); resolving one member resolves them all. */
    group?: string;
    groupSize?: number;
    /** Conflicts other than `changed`: what each resolution does. */
    outcomes?: Record<ConflictAction, ResolutionOutcome>;
    /** Why Keep Local is unavailable, if it is: an orphan that is not a note. */
    keepLocalBlocked?: string;
    /** Why Accept Remote is unavailable, if it is. */
    acceptRemoteBlocked?: string;
}

/** Fields never shown in a conflict: identity, timestamps and ZotFlow-only flags. */
const HIDDEN_FIELDS = new Set(["key", "version", "dateAdded", "dateModified", "annotationIsExternal", "annotationAuthorName"]);

/** A server refusal ("413: Tag 'xxxx…' too long") shortened for a sentence. */
function shortReason(error: string): string {
    const text = error
        .replace(/^\d{3}:\s*/, "")
        // Long quoted values (a 300-character tag) say nothing in a summary.
        .replace(/'([^']{24})[^']+'/g, "'$1…'")
        .replace(/[.\s]+$/, "");
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** Whether two values of one field hold the same content (empty values are equal). */
function sameField(field: string, a: unknown, b: unknown): boolean {
    return sameContent({ [field]: a }, { [field]: b });
}

const CONFLICT_TYPE: Record<SyncConflictKind, ItemConflictType> = {
    changed: "update",
    "local-deleted": "delete",
    "remote-deleted": "delete",
    refused: "push",
};

/* ================================================================ */
/*  Service                                                        */
/* ================================================================ */

/** Worker-side service for listing and resolving sync conflicts. */
export class ConflictService {
    /**
     * `settings` locates the files that go with removed items; without it
     * they are left. `convert` shows note and comment HTML as Markdown;
     * without it they are shown as HTML.
     */
    constructor(
        private parentHost: IParentProxy,
        private settings?: ZotFlowSettings,
        private convert?: ConvertService,
    ) {}

    public updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /* ================================================================ */
    /*  Queries                                                        */
    /* ================================================================ */

    /** All item conflicts, across libraries; members of a group are listed together. */
    async getItemConflicts(): Promise<ConflictItemInfo[]> {
        try {
            const conflicts = await db.syncConflicts.toArray();
            const results: ConflictItemInfo[] = [];
            const groupSizes = new Map<string, number>();
            for (const c of conflicts) {
                if (c.group) groupSizes.set(`${c.libraryID}/${c.group}`, (groupSizes.get(`${c.libraryID}/${c.group}`) ?? 0) + 1);
            }
            for (const c of conflicts) {
                const state = await readKey(c.libraryID, c.key);
                results.push(await this.buildInfo(c, state, groupSizes.get(`${c.libraryID}/${c.group}`)));
            }
            results.sort(
                (a, b) =>
                    a.libraryID - b.libraryID ||
                    (a.group ?? a.key).localeCompare(b.group ?? b.key) ||
                    (a.key === a.group ? -1 : b.key === b.group ? 1 : a.key.localeCompare(b.key)),
            );
            return results;
        } catch (e) {
            throw ZotFlowError.wrap(e, ZotFlowErrorCode.DB_OPEN_FAILED, "ConflictService", "Failed to query item conflicts");
        }
    }

    /* ================================================================ */
    /*  Resolution                                                     */
    /* ================================================================ */

    /**
     * Resolves one conflict — or, for a member of a remote-deletion group,
     * the whole group. `merged` (Keep Local only) is the data to keep when
     * the user chose per field; by default the local side is kept as it is.
     */
    async resolveItemConflict(
        libraryID: number,
        key: string,
        action: ConflictResolution,
        merged?: ItemDataJSON,
    ): Promise<void> {
        try {
            const conflict = await db.syncConflicts.get([libraryID, key]);
            if (conflict && conflict.kind !== "changed" && (action === "keep-local-copy" || action === "accept-remote-copy")) {
                throw new ZotFlowError(ZotFlowErrorCode.UNKNOWN, "ConflictService", `${action} applies to an item changed on both sides only`);
            }
            if (!conflict) {
                const row = await db.items.get([libraryID, key]);
                if (!row) {
                    throw new ZotFlowError(
                        ZotFlowErrorCode.RESOURCE_MISSING,
                        "ConflictService",
                        `Item not found: ${libraryID}/${key}`,
                    );
                }
                this.parentHost.log(
                    "warn",
                    `Item ${key} is not in conflict (status=${row.syncStatus}), skipping.`,
                    "ConflictService",
                );
                return;
            }

            if (conflict.kind === "remote-deleted" && conflict.group) {
                await this.resolveGroup(libraryID, conflict.group, action === "keep-local" ? "keep-local" : "accept-remote");
            } else {
                await syncTransaction(async () => {
                    const writer = new SyncWriter(libraryID);
                    await writer.update(key, (state) => {
                        const local = action === "keep-local" || action === "keep-local-copy";
                        const blocked = local ? keepLocalBlocked(state) : acceptRemoteBlocked(state);
                        if (blocked) {
                            throw new ZotFlowError(ZotFlowErrorCode.UNKNOWN, "ConflictService", blocked);
                        }
                        switch (action) {
                            case "keep-local":
                                return keepLocal(state, merged);
                            case "keep-local-copy":
                                // The local data whole: Zotero's changes that did not conflict are overwritten.
                                return keepLocal(state, state.row && structuredClone(state.row.raw.data as unknown as ItemDataJSON));
                            case "accept-remote":
                                return acceptRemote(state);
                            case "accept-remote-copy":
                                return acceptRemoteCopy(state);
                        }
                    });
                });
            }

            this.parentHost.log("info", `Resolved item conflict ${key} → ${action}`, "ConflictService");
            this.parentHost.emit("treeChanged");
        } catch (e) {
            throw ZotFlowError.wrap(e, ZotFlowErrorCode.DB_WRITE_FAILED, "ConflictService", `Failed to resolve item conflict ${key}`);
        }
    }

    /**
     * Resolves a remote-deletion group: Keep Local recreates every member
     * (uploaded parents first); Accept Remote removes every member and what
     * is under it — except a row in a conflict of its own (one that left the
     * group when the server had a newer copy of it), which stays, with its
     * subtree, for the user to resolve.
     */
    private async resolveGroup(libraryID: number, id: string, action: ConflictAction): Promise<void> {
        const removed = await syncTransaction(async () => {
            const writer = new SyncWriter(libraryID);
            const record = await db.syncGroups.get([libraryID, id]);
            const members = new Set(record?.members ?? []);
            for (const c of await db.syncConflicts.where("[libraryID+group]").equals([libraryID, id]).toArray()) {
                members.add(c.key);
            }

            const out: AnyIDBZoteroItem[] = [];
            for (const key of members) {
                const state = await readKey(libraryID, key);
                if (state.conflict?.group !== id) continue;
                if (action === "keep-local") {
                    await writer.commit(key, state, groupKeepLocal(state));
                    continue;
                }
                await this.removeRow(writer, libraryID, key, state, out);
                if (state.row) await this.removeUnder(writer, libraryID, key, out);
            }
            if (record) await putGroup({ ...record, members: [] });
            return out;
        });
        // File I/O never runs inside a Dexie transaction.
        if (this.settings) {
            await deleteRemovedItemFiles(this.parentHost, this.settings.annotationImageFolder, removed, "ConflictService");
        }
    }

    /** Removes one row and its sync records; the row is added to `out`. */
    private async removeRow(writer: SyncWriter, libraryID: number, key: string, state: KeyState, out: AnyIDBZoteroItem[]) {
        await writer.commit(key, state, {});
        await deleteQueueEntry(libraryID, key);
        if (state.row) out.push(state.row);
    }

    /**
     * Removes what is under `key`, level by level. A row in conflict is not
     * removed here: a member of the group gets its own turn, and a row in a
     * conflict of its own is kept with everything under it.
     */
    private async removeUnder(writer: SyncWriter, libraryID: number, key: string, out: AnyIDBZoteroItem[]) {
        let frontier = [key];
        const seen = new Set(frontier);
        while (frontier.length > 0) {
            const children = await db.items
                .where("[libraryID+parentItem]")
                .anyOf(frontier.map((k): [number, string] => [libraryID, k]))
                .toArray();
            const next: string[] = [];
            for (const child of children) {
                if (seen.has(child.key)) continue;
                seen.add(child.key);
                const state = await readKey(libraryID, child.key);
                if (state.conflict) continue;
                await this.removeRow(writer, libraryID, child.key, state, out);
                next.push(child.key);
            }
            frontier = next;
        }
    }

    async resolveAllItemConflicts(action: ConflictAction): Promise<number> {
        const conflicts = await this.getItemConflicts();
        let resolved = 0;
        const doneGroups = new Set<string>();

        for (const c of conflicts) {
            if (c.group) {
                const id = `${c.libraryID}/${c.group}`;
                if (doneGroups.has(id)) continue;
                doneGroups.add(id);
            }
            if (!(await db.syncConflicts.get([c.libraryID, c.key]))) continue;
            if (action === "accept-remote" && c.acceptRemoteBlocked) continue;
            if (action === "keep-local" && c.keepLocalBlocked) continue;
            await this.resolveItemConflict(c.libraryID, c.key, action);
            resolved++;
        }

        this.parentHost.log("info", `Batch-resolved ${resolved} item conflicts → ${action}`, "ConflictService");
        return resolved;
    }

    /* ================================================================ */
    /*  Private — listing helpers                                      */
    /* ================================================================ */

    private async buildInfo(c: IDBSyncConflict, state: KeyState, groupSize?: number): Promise<ConflictItemInfo> {
        const row = state.row ?? state.deleteLog?.snapshot;
        const localData: ItemDataJSON | undefined =
            c.kind === "local-deleted" ? { deleted: true } : (state.row?.raw.data as unknown as ItemDataJSON | undefined);
        const remoteData: ItemDataJSON | undefined = c.kind === "remote-deleted" ? undefined : c.remote;
        const remoteType = c.remote?.itemType;
        const itemType = row?.itemType ?? (typeof remoteType === "string" ? remoteType : "item");

        let syncError: string;
        switch (c.kind) {
            case "changed":
                syncError = "Changed both here and in Zotero.";
                break;
            case "local-deleted":
                syncError = "Deleted here, changed in Zotero.";
                break;
            case "remote-deleted":
                syncError =
                    c.group && c.group !== c.key
                        ? `An item above it (${c.group}) was deleted in Zotero.`
                        : "Deleted in Zotero, changed here.";
                break;
            case "refused":
                syncError = c.error ?? "Zotero refused the change.";
                break;
        }

        const fields = await this.asMarkdown(c.kind === "changed" ? this.mergeFields(state) : this.sideFields(c, state));
        const keepBlocked = keepLocalBlocked(state);
        const acceptBlocked = acceptRemoteBlocked(state);

        return {
            libraryID: c.libraryID,
            key: c.key,
            itemType,
            title: row?.title || `${itemType} (${c.key})`,
            kind: c.kind,
            conflictType: CONFLICT_TYPE[c.kind],
            syncError,
            summary: await this.summary(c, state, fields, groupSize ?? 1),
            details: await this.details(c, state, fields),
            fields,
            conflictFields: c.kind === "changed" ? mergeConflictFields(state) : [...c.fields],
            localData,
            remoteData: remoteData ?? { deleted: true },
            remoteVersion: c.remoteVersion,
            ...(c.group ? { group: c.group, groupSize } : {}),
            ...(c.kind === "changed" ? {} : { outcomes: this.outcomes(c, state, groupSize ?? 1) }),
            ...(keepBlocked ? { keepLocalBlocked: keepBlocked } : {}),
            ...(acceptBlocked ? { acceptRemoteBlocked: acceptBlocked } : {}),
        };
    }

    /** Why the conflict exists, in words, with the facts it rests on. */
    private async details(c: IDBSyncConflict, state: KeyState, fields: FieldDiff[]): Promise<ConflictDetails> {
        const row = state.row ?? state.deleteLog?.snapshot;
        const base = mergeBase(state) ? state.cache : undefined;
        // A row with no changes here has no local edit time to show.
        const localModified =
            c.kind === "local-deleted"
                ? state.deleteLog?.dateDeleted
                : state.row?.synced === 0
                  ? (state.row.raw.data as { dateModified?: string }).dateModified
                  : undefined;
        const remoteModified = typeof c.remote?.dateModified === "string" ? c.remote.dateModified : undefined;
        const parentKey = row?.parentItem;
        const out: ConflictDetails = {
            label: "",
            explanation: "",
            detectedAt: c.createdAt,
            localVersion: row?.version ?? 0,
            ...(base ? { baseVersion: base.version } : {}),
            ...(localModified ? { localModified } : {}),
            ...(remoteModified ? { remoteModified } : {}),
            ...(parentKey ? { parent: { key: parentKey, title: await this.titleOf(c.libraryID, parentKey) } } : {}),
        };

        // The summary in the panel says what happened; this says why ZotFlow
        // stopped to ask instead of settling it alone.
        switch (c.kind) {
            case "changed": {
                const conflicting = fields.filter((f) => f.merge === "conflict").length;
                const automatic = fields.length - conflicting;
                out.label = "Edited on both sides";
                out.explanation = base
                    ? "Both sides changed this item after they last agreed. ZotFlow merges changes to different fields on its own, " +
                      `but ${conflicting === 1 ? "one field was" : `${conflicting} fields were`} changed differently on each side, and only you can say which version is right.`
                    : (state.row?.version ?? 0) === 0
                      ? "This item was created here, and Zotero already has an item with the same key. With no common starting point, ZotFlow cannot tell which side changed what, so every field that differs counts as a conflict."
                      : "The version the changes here started from is not recorded (they predate this device's sync records). With no common starting point, ZotFlow cannot tell which side changed what, so every field that differs counts as a conflict.";
                if (automatic > 0) {
                    out.explanation +=
                        automatic === 1
                            ? " The one other change merges automatically, unless you overwrite all fields with one side."
                            : ` The ${automatic} other changes merge automatically, unless you overwrite all fields with one side.`;
                }
                break;
            }
            case "local-deleted":
                out.label = "Deleted here";
                out.explanation =
                    "You deleted this item here, but it was changed in Zotero before the deletion reached it. " +
                    "Sending the deletion now would discard those changes, so ZotFlow waits for you.";
                break;
            case "remote-deleted":
                if (c.group && c.group !== c.key) {
                    const rootTitle = await this.titleOf(c.libraryID, c.group);
                    out.groupRoot = { key: c.group, title: rootTitle };
                    out.label = "Parent deleted in Zotero";
                    out.explanation =
                        `Deleting “${rootTitle}” in Zotero deleted everything under it, this item too. ` +
                        (state.row?.synced === 1
                            ? "Items under this one have changes here that were never uploaded, so ZotFlow does not delete them here without asking."
                            : "It has changes here that were never uploaded, so ZotFlow does not delete it here without asking.");
                } else if (state.row?.synced === 1) {
                    // A root with no changes of its own: the changes are under it.
                    out.label = "Deleted in Zotero";
                    out.explanation =
                        "Zotero deletes an item together with everything under it. Items under this one have changes here that were never uploaded, " +
                        "so ZotFlow does not delete them here without asking. They are resolved together: re-created in Zotero, or removed here.";
                } else {
                    out.label = "Deleted in Zotero";
                    out.explanation =
                        "This item has changes here that were never uploaded. Deleting it here would discard them, so ZotFlow waits for you.";
                }
                break;
            case "refused":
                out.label = c.orphan ? "Parent missing" : "Rejected by Zotero";
                if (c.error) out.serverError = c.error;
                out.explanation = c.orphan
                    ? "Its parent item no longer exists, neither here nor in Zotero, so it cannot be uploaded where it belongs. Only a note can be kept, as a standalone note."
                    : "Zotero refused to save the changes made here, so ZotFlow stopped sending them. Keep Local sends them again on the next sync (fix the cause first, or Zotero refuses again); Accept Remote takes Zotero's copy.";
                break;
        }
        return out;
    }

    /** What happened to this item, in a sentence or two (the panel's summary). */
    private async summary(c: IDBSyncConflict, state: KeyState, fields: FieldDiff[], groupSize: number): Promise<string> {
        const others = groupSize - 1;
        const affected = others > 0 ? ` ${others} other item${others === 1 ? " is" : "s are"} resolved with it.` : "";
        switch (c.kind) {
            case "changed": {
                const conflicting = fields.filter((f) => f.merge === "conflict").map((f) => f.field);
                const merged = fields.length - conflicting.length;
                const named =
                    conflicting.length === 0
                        ? "No field"
                        : conflicting.length <= 2
                          ? conflicting.map((f) => `“${f}”`).join(" and ")
                          : `${conflicting.length} fields`;
                const verb = conflicting.length === 1 ? "was" : "were";
                const rest = merged > 0 ? ` ${merged} other change${merged === 1 ? "" : "s"} merge${merged === 1 ? "s" : ""} automatically.` : "";
                return `${named} ${verb} changed differently here and in Zotero.${rest}`;
            }
            case "local-deleted": {
                const n = fields.length;
                return `You deleted this item here, but Zotero changed it afterwards${n > 0 ? ` (${n} field${n === 1 ? "" : "s"})` : ""}.`;
            }
            case "remote-deleted":
                if (c.group && c.group !== c.key) {
                    return `“${await this.titleOf(c.libraryID, c.group)}” was deleted in Zotero; this item has changes here that were never uploaded.${affected}`;
                }
                if (state.row?.synced === 1) {
                    return `Deleted in Zotero; items under it have changes here that were never uploaded.${affected}`;
                }
                return `Deleted in Zotero, but it has changes here that were never uploaded.${affected}`;
            case "refused":
                if (c.orphan) return "Its parent item no longer exists anywhere, so it cannot be uploaded where it belongs.";
                return c.error ? `Zotero rejected the upload: ${shortReason(c.error)}.` : "Zotero rejected the upload.";
        }
    }

    /** What Keep Local and Accept Remote do to a conflict that is not `changed`. */
    private outcomes(c: IDBSyncConflict, state: KeyState, groupSize: number): Record<ConflictAction, ResolutionOutcome> {
        const others = groupSize - 1;
        const withOthers = others > 0 ? `, together with the ${others} other item${others === 1 ? "" : "s"} deleted with it` : "";
        switch (c.kind) {
            case "local-deleted":
                return {
                    "keep-local": {
                        hint: "Delete it in Zotero too",
                        effect: "The item stays deleted, and the deletion is sent to Zotero.",
                        push: 1,
                        pull: 0,
                        loses: `Zotero's changes (version ${c.remoteVersion}) are deleted with it.`,
                    },
                    "accept-remote": { hint: "Restore Zotero's version", effect: "The item comes back here, as it is in Zotero now.", push: 0, pull: 1 },
                };
            case "remote-deleted":
                return {
                    "keep-local": { hint: "Re-create it in Zotero", effect: `The item is re-created in Zotero from the copy here${withOthers}.`, push: groupSize, pull: 0 },
                    "accept-remote": {
                        hint: "Remove it here too",
                        effect: `The item is removed here${withOthers}, with everything under it.`,
                        push: 0,
                        pull: groupSize,
                        loses: "The changes made here that were never uploaded.",
                    },
                };
            case "refused": {
                const keep: ResolutionOutcome = c.orphan
                    ? { hint: "Keep it as a standalone note", effect: "The note becomes a standalone note and is created in Zotero.", push: 1, pull: 0 }
                    : { hint: "Keep this device's copy", effect: "The copy here is kept and sent again on the next sync.", push: 1, pull: 0 };
                const accept: ResolutionOutcome =
                    c.orphan || (!c.remote && (state.row?.version ?? 0) === 0)
                        ? { hint: "Remove it here", effect: "The item is removed here.", push: 0, pull: 1, loses: "The item and its changes; Zotero has no copy." }
                        : { hint: "Use Zotero's copy", effect: `The copy here is replaced by Zotero's (version ${c.remoteVersion || state.row?.version || 0}).`, push: 0, pull: 1, loses: "The changes made here." };
                return { "keep-local": keep, "accept-remote": accept };
            }
            case "changed":
                throw new Error("A changed conflict has a merge preview, not outcomes");
        }
    }

    /** A title for `key`, from its row or its pending delete. */
    private async titleOf(libraryID: number, key: string): Promise<string> {
        const row = (await db.items.get([libraryID, key])) ?? (await db.syncDeleteLog.get([libraryID, key]))?.snapshot;
        return row?.title || key;
    }

    /**
     * An item changed on both sides: every field the two sides hold
     * differently, with where a merge takes it from. Conflicts first.
     */
    private mergeFields(state: KeyState): FieldDiff[] {
        const row = state.row;
        const remote = state.conflict?.remote;
        if (!row || !remote) return [];
        const local = row.raw.data as unknown as ItemDataJSON;
        const base = mergeBase(state);
        const conflicts = new Set(mergeConflictFields(state));
        const merged = mergedData(state) ?? local;

        const out: FieldDiff[] = [];
        for (const field of this.fieldNames(local, remote)) {
            if (!conflicts.has(field) && sameField(field, local[field], remote[field])) continue;
            const merge: FieldMerge = conflicts.has(field)
                ? "conflict"
                : sameField(field, merged[field], local[field])
                  ? "local"
                  : sameField(field, merged[field], remote[field])
                    ? "remote"
                    : "combined";
            out.push({
                field,
                localValue: this.stringify(local[field], field),
                remoteValue: this.stringify(remote[field], field),
                ...(base ? { baseValue: this.stringify(base[field], field) } : {}),
                merge,
                mergedValue: this.stringify(merged[field], field),
            });
        }
        return out.sort((a, b) => Number(b.merge === "conflict") - Number(a.merge === "conflict"));
    }

    /**
     * A conflict with one side missing or refused: what is at stake. For a
     * deletion, the changes the other side made since the copy both started
     * from (every field when it is unknown); for a refusal, the differences
     * from Zotero's copy.
     */
    private sideFields(c: IDBSyncConflict, state: KeyState): FieldDiff[] {
        const asData = (row: AnyIDBZoteroItem | undefined) => row?.raw?.data as unknown as ItemDataJSON | undefined;
        let local: ItemDataJSON | undefined;
        let remote: ItemDataJSON | undefined;
        let base: ItemDataJSON | undefined;
        switch (c.kind) {
            case "local-deleted":
                remote = c.remote;
                base = asData(state.deleteLog?.snapshot);
                break;
            case "remote-deleted":
                local = asData(state.row);
                // A row with no changes here is its own base: nothing to list.
                base = state.cache?.data ?? (state.row?.synced === 1 ? local : undefined);
                break;
            default:
                local = asData(state.row);
                remote = c.remote;
                base = state.cache?.data;
        }

        const changed = local ?? remote;
        if (!changed) return [];
        // The side to compare the changed one with: the other side, else the base.
        const against = local && remote ? remote : base;
        const out: FieldDiff[] = [];
        for (const field of this.fieldNames(changed, against ?? {})) {
            if (against ? sameField(field, changed[field], against[field]) : this.stringify(changed[field], field) === "") continue;
            out.push({
                field,
                ...(local ? { localValue: this.stringify(local[field], field) } : {}),
                ...(remote ? { remoteValue: this.stringify(remote[field], field) } : {}),
                ...(base ? { baseValue: this.stringify(base[field], field) } : {}),
            });
        }
        return out;
    }

    /** The fields of two versions worth showing, in their order. */
    private fieldNames(a: ItemDataJSON, b: ItemDataJSON): string[] {
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => !HIDDEN_FIELDS.has(f));
    }

    /**
     * Note and comment values as the Markdown ZotFlow's editor shows (raw
     * HTML is noisy to read and to diff). When any value of a field fails to
     * convert, that field stays HTML and is marked not to be diffed.
     */
    private async asMarkdown(fields: FieldDiff[]): Promise<FieldDiff[]> {
        const convert = this.convert;
        if (!convert) return fields;
        const toMd = async (field: string, html: string | undefined): Promise<string | undefined> => {
            if (!html) return html;
            // The meta line is machine-owned: the note editor hides it too.
            return field === "note" ? stripLeadingNoteMeta(await convert.html2md(html)).trim() : convert.annoHtml2md(html).trim();
        };
        const out: FieldDiff[] = [];
        for (const f of fields) {
            if (f.field !== "note" && f.field !== "annotationComment") {
                out.push(f);
                continue;
            }
            try {
                const [localValue, remoteValue, baseValue, mergedValue] = await Promise.all([
                    toMd(f.field, f.localValue),
                    toMd(f.field, f.remoteValue),
                    toMd(f.field, f.baseValue),
                    toMd(f.field, f.mergedValue),
                ]);
                out.push({
                    ...f,
                    ...(localValue !== undefined ? { localValue } : {}),
                    ...(remoteValue !== undefined ? { remoteValue } : {}),
                    ...(baseValue !== undefined ? { baseValue } : {}),
                    ...(mergedValue !== undefined ? { mergedValue } : {}),
                });
            } catch (e) {
                this.parentHost.log("warn", `Could not show ${f.field} as Markdown; showing HTML`, "ConflictService", e);
                out.push({ ...f, noDiff: true });
            }
        }
        return out;
    }

    /** A value for display: lists as lines, other structures as JSON; empty for none. */
    private stringify(value: unknown, field?: string): string {
        if (value === undefined || value === null) return "";
        if (Array.isArray(value)) {
            if (field === "tags") return value.map((t: { tag?: unknown; type?: unknown }) => `${String(t.tag)}${t.type ? " (automatic)" : ""}`).join("\n");
            if (field === "collections") return value.map(String).join("\n");
            if (field === "creators") {
                return value
                    .map((c: { creatorType?: unknown; name?: unknown; firstName?: unknown; lastName?: unknown }) => {
                        const name = typeof c.name === "string" ? c.name : [c.lastName, c.firstName].filter(Boolean).join(", ");
                        return `${name} (${String(c.creatorType)})`;
                    })
                    .join("\n");
            }
        }
        if (typeof value === "string") return value;
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        return JSON.stringify(value, null, 2);
    }
}
