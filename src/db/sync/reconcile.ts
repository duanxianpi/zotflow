/*
    ***** BEGIN LICENSE BLOCK *****

    Ported from Zotero:
      chrome/content/zotero/xpcom/data/dataObjectUtilities.js
        (patch, diff, applyChanges and their helpers)
      chrome/content/zotero/xpcom/sync/syncLocal.js
        (_reconcileChanges, _reconcileChangesWithoutCache)

    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org

    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version. This port is distributed under
    version 3 of that License, as part of ZotFlow.

    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    ***** END LICENSE BLOCK *****
*/

/**
 * Field-level comparison of Zotero API JSON (`item.data`): changesets,
 * applying them, patch payloads, and the three-way merge sync uses when a
 * row with local changes meets a newer server copy.
 *
 * Pure: nothing here reads or writes the database, and no input is modified.
 * `applyChanges` returns a new object.
 *
 * Differences from Zotero:
 * - Only item semantics are kept (ZotFlow syncs no collections or searches
 *   upstream), so there is no auto-merge object type.
 * - `lastRead` and ISBN hyphenation are not special-cased.
 * - Note HTML is compared by its text without a DOM (`DOMParser` does not
 *   exist in a worker), and that rule applies to the three-way merge too.
 */

/** API JSON of one object (`item.data`). */
export type ObjectJSON = Record<string, unknown>;

export type ChangeOp =
    | "add"
    | "modify"
    | "delete"
    | "member-add"
    | "member-remove"
    | "property-member-add"
    | "property-member-remove";

/** One field-level change between two versions of an object. */
export interface Change {
    field: string;
    op: ChangeOp;
    value?: unknown;
}

/** A local change and a remote change that cannot both be applied. */
export type FieldConflict = [local: Change, remote: Change];

export interface Reconciliation {
    /** Remote changes to apply to the local object. */
    changes: Change[];
    /** Changes made differently on both sides; the user must choose. */
    conflicts: FieldConflict[];
    /** Whether local changes remain that the remote side does not have. */
    localChanged: boolean;
}

/**
 * Fields ignored when merging: Zotero's own list, plus `annotationIsExternal`,
 * a ZotFlow-only flag that never reaches the server. Storage fields (`md5`,
 * `mtime`) are compared, unlike Zotero, which handles them in its file sync.
 */
export const SYNC_IGNORE_FIELDS: readonly string[] = [
    "dateAdded",
    "dateModified",
    "annotationIsExternal",
];

interface Tag {
    tag: string;
    type?: number;
}

type Relations = Record<string, string | string[]>;

/* ------------------------------------------------------------------ */
/*  Value helpers (Zotero.Tags / Zotero.Creators / Zotero.Utilities)   */
/* ------------------------------------------------------------------ */

function cleanTag(t: Tag): Tag {
    const tag = str(t.tag).trim();
    const type = Number(t.type ?? 0) || 0;
    return type ? { tag, type } : { tag };
}

function tagsEqual(a: Tag, b: Tag): boolean {
    const x = cleanTag(a);
    const y = cleanTag(b);
    return x.tag === y.tag && (x.type ?? 0) === (y.type ?? 0);
}

/** A field value as text: strings as-is, numbers printed, anything else empty. */
function str(v: unknown): string {
    if (typeof v === "string") return v;
    return typeof v === "number" ? String(v) : "";
}

function cleanCreator(c: Record<string, unknown>): string {
    const out: Record<string, unknown> = { creatorType: c.creatorType ?? "author" };
    if (typeof c.name === "string" && c.name !== "") {
        out.name = c.name.trim();
    } else {
        out.firstName = str(c.firstName).trim();
        out.lastName = str(c.lastName).trim();
    }
    return JSON.stringify(out);
}

function creatorsEqual(a: unknown, b: unknown): boolean {
    return cleanCreator(a as Record<string, unknown>) === cleanCreator(b as Record<string, unknown>);
}

function arrayEquals(a: unknown[], b: unknown[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Members of `a` not in `b` (by `===`). */
function arrayDiff<T>(a: T[], b: T[]): T[] {
    return a.filter((v) => !b.includes(v));
}

function relationValues(v: string | string[] | undefined): string[] {
    if (v === undefined || v === "") return [];
    return typeof v === "string" ? [v] : v;
}

/** Whether a value counts as present (Zotero's `val && val !== "" || val === 0`). */
function hasValue(v: unknown): boolean {
    return (!!v && v !== "") || v === 0;
}

/* ------------------------------------------------------------------ */
/*  Field comparison                                                  */
/* ------------------------------------------------------------------ */

function creatorsChanged(a: unknown[], b: unknown[] | undefined): boolean {
    if (!b || a.length !== b.length) return true;
    return a.some((c, i) => !creatorsEqual(c, b[i]));
}

function collectionsChanged(a: string[], b: string[] | undefined): boolean {
    if (!b || a.length !== b.length) return true;
    return !arrayEquals([...a].sort(), [...b].sort());
}

function tagsChanged(a: Tag[], b: Tag[] | undefined): boolean {
    if (!b || a.length !== b.length) return true;
    const cmp = (x: Tag, y: Tag) => {
        if (x.tag === y.tag) return (y.type ?? 0) - (x.type ?? 0);
        return x.tag > y.tag ? 1 : -1;
    };
    const s1 = [...a].sort(cmp);
    const s2 = [...b].sort(cmp);
    return s1.some((t, i) => !tagsEqual(t, s2[i]!));
}

function relationsChanged(a: Relations, b: Relations | undefined): boolean {
    if (!b) return true;
    const p1 = Object.keys(a).sort();
    const p2 = Object.keys(b).sort();
    if (!arrayEquals(p1, p2)) return true;
    return p1.some((p) => !arrayEquals(relationValues(a[p]), relationValues(b[p])));
}

function fieldChanged(field: string, a: unknown, b: unknown): boolean {
    switch (field) {
        case "collections":
            return collectionsChanged(a as string[], b as string[] | undefined);
        case "creators":
            return creatorsChanged(a as unknown[], b as unknown[] | undefined);
        case "tags":
            return tagsChanged(a as Tag[], b as Tag[] | undefined);
        case "relations":
            return relationsChanged(a as Relations, b as Relations | undefined);
        // The server answers `deleted: 1`; a local trash writes `true`.
        case "deleted":
            return !!a !== !!b;
        default:
            if (a && b && typeof a === "object" && typeof b === "object") {
                return JSON.stringify(a) !== JSON.stringify(b);
            }
            return a !== b;
    }
}

/* ------------------------------------------------------------------ */
/*  patch                                                             */
/* ------------------------------------------------------------------ */

/**
 * The fields of `obj` that differ from `base`, for a patch-mode upload
 * (Zotero's `toJSON({ mode: "patch", patchBase })`). A field `base` has and
 * `obj` lacks is cleared explicitly: `false` for the boolean-ish fields,
 * `""` otherwise.
 */
export function patch(base: ObjectJSON, obj: ObjectJSON): ObjectJSON {
    const target: ObjectJSON = { ...obj };
    for (const field of Object.keys(base)) {
        if (field === "key" || field === "version" || field === "dateModified") continue;
        if (field in target) {
            if (!fieldChanged(field, base[field], target[field])) delete target[field];
            continue;
        }
        switch (field) {
            // A note or attachment that became a child loses `collections`;
            // there is nothing to clear.
            case "collections":
                break;
            case "deleted":
            case "parentItem":
            case "inPublications":
                if (base[field]) target[field] = false;
                break;
            default:
                if (base[field] !== "") target[field] = "";
        }
    }
    return target;
}

/* ------------------------------------------------------------------ */
/*  diff                                                              */
/* ------------------------------------------------------------------ */

function creatorsDiff(a: unknown[], b: unknown[] | undefined): Change[] {
    if (!b || b.length === 0) {
        return a.length === 0 ? [] : [{ field: "creators", op: "delete" }];
    }
    return creatorsChanged(a, b) ? [{ field: "creators", op: "modify", value: b }] : [];
}

function collectionsDiff(a: string[], b: string[] = []): Change[] {
    return [
        ...arrayDiff(a, b).map((v): Change => ({ field: "collections", op: "member-remove", value: v })),
        ...arrayDiff(b, a).map((v): Change => ({ field: "collections", op: "member-add", value: v })),
    ];
}

function tagsDiff(a: Tag[], b: Tag[] = []): Change[] {
    const out: Change[] = [];
    for (const t of a) {
        if (!b.some((u) => tagsEqual(t, u))) out.push({ field: "tags", op: "member-remove", value: t });
    }
    for (const t of b) {
        if (!a.some((u) => tagsEqual(t, u))) out.push({ field: "tags", op: "member-add", value: t });
    }
    return out;
}

function relationsDiff(a: Relations, b: Relations = {}): Change[] {
    const out: Change[] = [];
    for (const pred of Object.keys(a)) {
        const v1 = relationValues(a[pred]);
        const v2 = relationValues(b[pred]);
        for (const v of arrayDiff(v1, v2)) {
            out.push({ field: "relations", op: "property-member-remove", value: { key: pred, value: v } });
        }
        for (const v of arrayDiff(v2, v1)) {
            out.push({ field: "relations", op: "property-member-add", value: { key: pred, value: v } });
        }
    }
    for (const pred of Object.keys(b)) {
        if (a[pred]) continue;
        for (const v of relationValues(b[pred])) {
            out.push({ field: "relations", op: "property-member-add", value: { key: pred, value: v } });
        }
    }
    return out;
}

function htmlDiff(field: string, a: string, b = ""): Change | undefined {
    if (a === "" && b !== "") return { field, op: "add", value: b };
    if (a !== "" && b === "") return { field, op: "delete" };
    // Zotero's one known client/server sanitizing difference.
    const norm = (s: string) => s.replace(/<p>&nbsp;<\/p>/g, "<p> </p>");
    return norm(a) !== norm(b) ? { field, op: "modify", value: b } : undefined;
}

/**
 * The changes that turn `a` into `b`. Tags, collections and relations are
 * diffed member by member; creators as a whole (order matters).
 */
export function diff(a: ObjectJSON, b: ObjectJSON, ignoreFields: readonly string[] = []): Change[] {
    let out: Change[] = [];
    const skip = new Set(["key", "version", ...ignoreFields]);

    for (const field of Object.keys(a)) {
        if (skip.has(field)) continue;
        const v1 = a[field];
        const v2 = b[field];
        skip.add(field);
        if (!hasValue(v1) && !hasValue(v2)) continue;

        switch (field) {
            case "creators":
                out = out.concat(creatorsDiff(v1 as unknown[], v2 as unknown[] | undefined));
                break;
            case "collections":
                out = out.concat(collectionsDiff((v1 ?? []) as string[], v2 as string[] | undefined));
                break;
            case "relations":
                out = out.concat(relationsDiff((v1 ?? {}) as Relations, v2 as Relations | undefined));
                break;
            case "tags":
                out = out.concat(tagsDiff((v1 ?? []) as Tag[], v2 as Tag[] | undefined));
                break;
            case "note": {
                const c = htmlDiff(field, str(v1), str(v2));
                if (c) out.push(c);
                break;
            }
            default:
                if (v1 === v2) break;
                // The server answers `deleted: 1`; a local trash writes `true`.
                if (field === "deleted" && !!v1 === !!v2) break;
                if (hasValue(v1) && !hasValue(v2)) out.push({ field, op: "delete" });
                else if (!hasValue(v1) && hasValue(v2)) out.push({ field, op: "add", value: v2 });
                else out.push({ field, op: "modify", value: v2 });
        }
    }

    for (const field of Object.keys(b)) {
        if (skip.has(field)) continue;
        const v = b[field];
        // A member field absent from `a` is an empty one: diffed member by
        // member, so the same addition on two sides is recognised as such.
        if (field === "tags" || field === "collections" || field === "relations") {
            if (field === "tags") out = out.concat(tagsDiff([], v as Tag[] | undefined));
            else if (field === "collections") out = out.concat(collectionsDiff([], v as string[] | undefined));
            else out = out.concat(relationsDiff({}, v as Relations | undefined));
            continue;
        }
        if (
            v === false ||
            v === "" ||
            v === null ||
            v === undefined ||
            (typeof v === "object" && Object.keys(v).length === 0)
        ) {
            continue;
        }
        out.push({ field, op: "add", value: v });
    }
    return out;
}

/* ------------------------------------------------------------------ */
/*  applyChanges                                                      */
/* ------------------------------------------------------------------ */

/** A copy of `json` with `changes` (from `diff`) applied. */
export function applyChanges(json: ObjectJSON, changes: readonly Change[]): ObjectJSON {
    const out = structuredClone(json);
    for (const c of changes) {
        switch (c.op) {
            case "delete":
                delete out[c.field];
                break;
            case "add":
            case "modify":
                out[c.field] = structuredClone(c.value);
                break;
            case "member-add": {
                if (c.field === "collections") {
                    const list = (out.collections ??= []) as string[];
                    if (!list.includes(c.value as string)) list.push(c.value as string);
                } else if (c.field === "tags") {
                    const list = (out.tags ??= []) as Tag[];
                    if (!list.some((t) => tagsEqual(t, c.value as Tag))) {
                        list.push(structuredClone(c.value as Tag));
                    }
                } else {
                    throw new Error(`Unexpected field '${c.field}'`);
                }
                break;
            }
            case "member-remove": {
                if (c.field === "collections") {
                    const list = (out.collections ?? []) as string[];
                    const pos = list.indexOf(c.value as string);
                    if (pos !== -1) list.splice(pos, 1);
                } else if (c.field === "tags") {
                    const list = (out.tags ?? []) as Tag[];
                    const pos = list.findIndex((t) => tagsEqual(t, c.value as Tag));
                    if (pos !== -1) list.splice(pos, 1);
                } else {
                    throw new Error(`Unexpected field '${c.field}'`);
                }
                break;
            }
            case "property-member-add": {
                if (c.field !== "relations") throw new Error(`Unexpected field '${c.field}'`);
                const { key, value } = c.value as { key: string; value: string };
                const rel = (out.relations ??= {}) as Relations;
                const vals = relationValues(rel[key]).slice();
                if (!vals.includes(value)) vals.push(value);
                rel[key] = vals;
                break;
            }
            case "property-member-remove": {
                if (c.field !== "relations") throw new Error(`Unexpected field '${c.field}'`);
                const { key, value } = c.value as { key: string; value: string };
                const rel = out.relations as Relations | undefined;
                const current = rel?.[key];
                if (!rel || current === undefined) break;
                if (typeof current === "string") {
                    if (current === value) delete rel[key];
                    break;
                }
                const pos = current.indexOf(value);
                if (pos === -1) break;
                current.splice(pos, 1);
                if (current.length === 0) delete rel[key];
                break;
            }
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/*  Reconciliation                                                    */
/* ------------------------------------------------------------------ */

/** Decodes the entities an HTML serializer must emit, plus numeric ones. */
function decodeEntities(text: string): string {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
        if (!body.startsWith("#")) return named[body.toLowerCase()] ?? whole;
        const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

/**
 * The text of a note's HTML with whitespace collapsed — what Zotero compares
 * (via `DOMParser`) to tell a markup-only difference from a real one.
 */
export function noteText(html: string): string {
    const text = html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "");
    return decodeEntities(text).replace(/\s+/g, " ").trim();
}

/**
 * Drops note conflicts whose two sides differ only in markup, taking the
 * remote side (Zotero's rule for notes edited outside its editor).
 */
function settleNoteMarkup(r: Reconciliation): Reconciliation {
    const conflicts: FieldConflict[] = [];
    const changes = [...r.changes];
    for (const pair of r.conflicts) {
        const [c1, c2] = pair;
        if (
            c1.field === "note" &&
            c1.op !== "delete" &&
            c2.op !== "delete" &&
            noteText(str(c1.value)) === noteText(str(c2.value))
        ) {
            changes.push(c2);
            continue;
        }
        conflicts.push(pair);
    }
    return { ...r, changes, conflicts };
}

/**
 * Three-way merge of a local and a remote version against their common base
 * (the server copy the local edits started from).
 *
 * Changes to different fields merge; the same change on both sides is not a
 * conflict; tags, collections and relations merge member by member; when
 * both sides are in the trash the remote side wins. What remains is a
 * conflict.
 */
export function reconcile3(
    base: ObjectJSON,
    local: ObjectJSON,
    remote: ObjectJSON,
    ignoreFields: readonly string[] = SYNC_IGNORE_FIELDS,
): Reconciliation {
    const changeset1: (Change | undefined)[] = diff(base, local, ignoreFields);
    const changeset2 = diff(base, remote, ignoreFields);
    const conflicts: FieldConflict[] = [];
    const matchedLocal = new Set<number>();
    const bothTrashed = !!local.deleted && !!remote.deleted;

    for (let i = 0; i < changeset1.length; i++) {
        for (let j = 0; j < changeset2.length; j++) {
            const c1 = changeset1[i];
            if (!c1) break;
            const c2 = changeset2[j]!;
            if (c1.field !== c2.field) continue;

            if (c1.op.startsWith("member-") && c2.op.startsWith("member-")) {
                if (c1.field === "collections" && c1.value !== c2.value) continue;
                if (c1.field === "tags" && !tagsEqual(c1.value as Tag, c2.value as Tag)) {
                    // The same tag added with different types: treat as a
                    // modify to the remote type.
                    const t1 = c1.value as Tag;
                    const t2 = c2.value as Tag;
                    if (c1.op === "member-add" && c2.op === "member-add" && t1.tag === t2.tag) {
                        changeset1.splice(i--, 1);
                        if (i < 0) i = 0;
                        changeset2.splice(j--, 1);
                        if ((t1.type ?? 0) > 0) {
                            changeset2.push({ field: "tags", op: "member-remove", value: t1 });
                            changeset2.push({ field: "tags", op: "member-add", value: t2 });
                        }
                    }
                    continue;
                }
            }

            if (c1.op.startsWith("property-member-") && c2.op.startsWith("property-member-")) {
                const v1 = c1.value as { key: string; value: string };
                const v2 = c2.value as { key: string; value: string };
                if (v1.key !== v2.key || v1.value !== v2.value) continue;
            }

            // Equal or in conflict from here on.

            if (c1.field === "creators" && c1.op === "modify" && c2.op === "modify") {
                const a = c1.value as unknown[];
                const b = c2.value as unknown[];
                if (a.length === b.length && a.every((c, n) => creatorsEqual(c, b[n]))) {
                    matchedLocal.add(i);
                    changeset2.splice(j--, 1);
                    continue;
                }
            }

            const same =
                (c1.op === "delete" && c2.op === "delete") ||
                (c1.op === c2.op && /^(property-)?member-(add|remove)$/.test(c1.op)) ||
                (c1.op !== "delete" && c2.op !== "delete" && !fieldChanged(c1.field, c1.value, c2.value));
            if (same) {
                matchedLocal.add(i);
                changeset2.splice(j--, 1);
                continue;
            }

            // Both in the trash: the remote change applies even in conflict.
            if (bothTrashed) continue;

            matchedLocal.add(i);
            changeset2.splice(j--, 1);
            conflicts.push([c1, c2]);
        }
    }

    const localChanged = changeset1.filter(Boolean).length > matchedLocal.size;
    return settleNoteMarkup({ changes: changeset2, conflicts, localChanged });
}

/**
 * Merge without a common base (rows from before the sync cache, or a local
 * create that met a server object with the same key): member changes are
 * additive only, and any field that differs is a conflict.
 */
export function reconcile2(
    local: ObjectJSON,
    remote: ObjectJSON,
    ignoreFields: readonly string[] = SYNC_IGNORE_FIELDS,
): Reconciliation {
    const changes: Change[] = [];
    const conflicts: FieldConflict[] = [];
    const bothTrashed = !!local.deleted && !!remote.deleted;

    for (const c2 of diff(local, remote, ignoreFields)) {
        if (c2.op.endsWith("-remove")) continue;
        if (c2.op.startsWith("member-") || c2.op.startsWith("property-member-")) {
            changes.push(c2);
            continue;
        }
        if (bothTrashed) {
            changes.push(c2);
            continue;
        }
        const remoteSide: Change = c2.op === "modify" ? { ...c2, op: "add" } : c2;
        const val = local[c2.field];
        const localSide: Change =
            val !== undefined ? { field: c2.field, op: "add", value: val } : { field: c2.field, op: "delete" };
        conflicts.push([localSide, remoteSide]);
    }

    // Local member additions the remote lacks are still to be uploaded.
    const localChanged = diff(remote, local, ignoreFields).some((c) => c.op.endsWith("-add"));
    return settleNoteMarkup({ changes, conflicts, localChanged });
}

/* ------------------------------------------------------------------ */
/*  Content equality                                                  */
/* ------------------------------------------------------------------ */

const EQUALITY_IGNORED = new Set(["key", "version", "dateModified", "dateAdded", "annotationIsExternal"]);

function isEmpty(v: unknown): boolean {
    return (
        v === undefined ||
        v === null ||
        v === "" ||
        v === false ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
    );
}

function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v).sort()) {
            const x = (v as Record<string, unknown>)[k];
            if (!isEmpty(x)) out[k] = canonical(x);
        }
        return out;
    }
    return v;
}

function comparable(data: ObjectJSON): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(data).sort()) {
        if (EQUALITY_IGNORED.has(k)) continue;
        let v = data[k];
        if (isEmpty(v)) continue;
        if (k === "annotationPosition" && typeof v === "string") {
            try {
                v = JSON.parse(v) as unknown;
            } catch {
                // Compared as the raw string.
            }
        }
        if (k === "tags" && Array.isArray(v)) {
            v = (v as Tag[]).map(cleanTag).sort((a, b) => (a.tag === b.tag ? (a.type ?? 0) - (b.type ?? 0) : a.tag < b.tag ? -1 : 1));
        }
        if (k === "collections" && Array.isArray(v)) v = [...(v as string[])].sort();
        if (k === "deleted") v = !!v;
        out[k] = canonical(v);
    }
    return out;
}

/**
 * Whether two versions of an object hold the same content: versions and
 * timestamps are ignored, empty values (`""`, `[]`, `{}`, `false`, `null`,
 * absent) are equal, object keys are compared sorted, tags and collections
 * as sets, and `annotationPosition` parsed. The server adds and drops empty
 * fields, so a byte comparison would see changes that are not there.
 */
export function sameContent(a: ObjectJSON, b: ObjectJSON): boolean {
    return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}
