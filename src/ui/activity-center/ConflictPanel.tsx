import React, { useMemo, useState } from "react";
import { Platform } from "obsidian";
import { ObsidianIcon } from "../ObsidianIcon";
import { services } from "services/services";
import { ConflictDetailsModal } from "./conflict-details-modal";
import { itemTypeLabel } from "types/zotero-item-type-labels";
import { diffText } from "./word-diff";

import type { DiffSegment } from "./word-diff";

import type {
    ConflictAction,
    ConflictItemInfo,
    ConflictResolution,
    FieldDiff,
    ResolutionOutcome,
} from "worker/services/conflict";

/* ================================================================ */
/*  Helpers                                                         */
/* ================================================================ */

/** How a conflict can be resolved in the panel. */
type Strategy = ConflictResolution;

/**
 * One row of the conflict list: a single conflict, or every member of one
 * remote deletion (they are resolved together, so they are listed as one).
 */
export interface ConflictEntry {
    id: string;
    title: string;
    /** The conflict the row resolves through: the group's root when it is listed. */
    primary: ConflictItemInfo;
    members: ConflictItemInfo[];
}

/** The list rows for `conflicts` (which lists a group's members together, root first). */
export function groupConflicts(conflicts: ConflictItemInfo[]): ConflictEntry[] {
    const out: ConflictEntry[] = [];
    const groups = new Map<string, ConflictEntry>();
    for (const c of conflicts) {
        if (!c.group || (c.groupSize ?? 1) <= 1) {
            out.push({
                id: conflictId(c),
                title: c.title,
                primary: c,
                members: [c],
            });
            continue;
        }
        const id = `${c.libraryID}:group:${c.group}`;
        const entry = groups.get(id);
        if (entry) {
            entry.members.push(c);
            if (c.key === c.group) {
                entry.primary = c;
                entry.title = c.title;
            }
            continue;
        }
        const created: ConflictEntry = {
            id,
            title:
                c.key === c.group
                    ? c.title
                    : (c.details.groupRoot?.title ?? c.title),
            primary: c,
            members: [c],
        };
        groups.set(id, created);
        out.push(created);
    }
    return out;
}

/** Stable id of a conflict across reloads. */
export function conflictId(
    c: Pick<ConflictItemInfo, "libraryID" | "key">,
): string {
    return `${c.libraryID}:${c.key}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

const STRATEGY_LABEL: Record<Strategy, string> = {
    "keep-local": "Keep Local",
    "accept-remote": "Accept Remote",
    "keep-local-copy": "Keep Local (all fields)",
    "accept-remote-copy": "Accept Remote (all fields)",
};

/** The main action a whole-copy variant belongs to (blocked with it). */
const BASE_ACTION: Record<Strategy, ConflictAction> = {
    "keep-local": "keep-local",
    "accept-remote": "accept-remote",
    "keep-local-copy": "keep-local",
    "accept-remote-copy": "accept-remote",
};

/** The whole-copy variant shown under each main action. */
const COPY_OF: Record<ConflictAction, Strategy> = {
    "keep-local": "keep-local-copy",
    "accept-remote": "accept-remote-copy",
};

/**
 * Whether the whole-copy variants are offered: when conflicting fields and
 * merged ones are both present, so "only the conflicts" and "every field"
 * mean different things to the user (even where a result happens to match).
 */
function offersCopies(fields: FieldDiff[]): boolean {
    return (
        fields.some((f) => f.merge === "conflict") &&
        fields.some((f) => f.merge !== "conflict")
    );
}

/**
 * Where a resolution takes a field from, for an item changed on both sides:
 * a conflicting field from the chosen side, any other field from wherever
 * its change came (both sides' changes combine either way).
 */
function resultSide(
    f: FieldDiff,
    strategy: Strategy,
): "local" | "remote" | "combined" {
    if (strategy === "keep-local-copy") return "local";
    if (strategy === "accept-remote-copy") return "remote";
    if (f.merge === "conflict" || !f.merge)
        return strategy === "keep-local" ? "local" : "remote";
    return f.merge;
}

/** The push/pull counts and the loss of a strategy, for an item changed on both sides. */
function mergeOutcome(
    fields: FieldDiff[],
    strategy: Strategy,
): ResolutionOutcome {
    let push = 0;
    let pull = 0;
    // Fields where a side's own value is not kept.
    let lostHere = 0;
    let lostThere = 0;
    for (const f of fields) {
        const side = resultSide(f, strategy);
        if (side !== "remote") push++;
        if (side !== "local") pull++;
        if (side === "remote" && f.merge !== "remote") lostHere++;
        if (side === "local" && f.merge !== "local") lostThere++;
    }
    const losses: string[] = [];
    if (lostHere > 0)
        losses.push(
            `Your changes to ${plural(lostHere, "field")} here are discarded`,
        );
    if (lostThere > 0)
        losses.push(
            `Zotero's changes to ${plural(lostThere, "field")} are overwritten`,
        );
    return {
        hint: "",
        effect: "",
        push,
        pull,
        ...(losses.length > 0 ? { loses: losses.join("; ") + "." } : {}),
    };
}

/* ================================================================ */
/*  Conflict list                                                   */
/* ================================================================ */

export const ConflictPanel: React.FC<{
    entries: ConflictEntry[];
    libraryNames: Map<number, string>;
    selectedKey: string | null;
    /** `null` goes back to the list (phones show one or the other). */
    onSelect: (key: string | null) => void;
    onResolve: (
        entry: ConflictItemInfo,
        action: ConflictResolution,
    ) => Promise<void>;
}> = ({ entries, libraryNames, selectedKey, onSelect, onResolve }) => {
    const selected = entries.find((e) => e.id === selectedKey);
    // A phone has no room for both: the list, or one conflict full-screen.
    const phone = Platform.isPhone;

    if (entries.length === 0) {
        return (
            <div className="zotflow-sync-empty">
                <ObsidianIcon
                    icon="check-circle"
                    iconStyle={{ color: "var(--text-faint)" }}
                />
                <span>No conflicts. Everything is in sync.</span>
            </div>
        );
    }

    const list = (
        <div className="zotflow-conflict-list">
            {entries.map((e) => {
                const c = e.primary;
                const count = e.members.length;
                return (
                    <div
                        key={e.id}
                        className={`zotflow-conflict-item ${selectedKey === e.id ? "is-selected" : ""}`}
                        onClick={() => onSelect(e.id)}
                    >
                        <span className="zotflow-conflict-title">
                            {e.title}
                        </span>
                        <div className="zotflow-conflict-item-header">
                            <span
                                className={`zotflow-conflict-type-badge zotflow-conflict-type-badge--${c.conflictType}`}
                            >
                                {count > 1
                                    ? `Deleted in Zotero · ${count} items`
                                    : c.details.label}
                            </span>
                            <span className="zotflow-conflict-key">
                                {c.group ?? c.key}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    const resolver = selected && (
        // Keyed: a newly selected conflict starts with a fresh choice.
        <ConflictResolver
            key={selected.id}
            entry={selected.primary}
            title={selected.title}
            members={selected.members}
            libraryName={libraryNames.get(selected.primary.libraryID)}
            onResolve={onResolve}
            onBack={phone ? () => onSelect(null) : undefined}
        />
    );

    if (phone) {
        return (
            <div className="zotflow-conflict-container">{resolver ?? list}</div>
        );
    }

    return (
        <div className="zotflow-conflict-container">
            {list}
            {resolver ?? (
                <div className="zotflow-conflict-diff zotflow-sync-empty">
                    <ObsidianIcon icon="arrow-left" />
                    <span>
                        Select a conflict to see what happened and how to
                        resolve it.
                    </span>
                </div>
            )}
        </div>
    );
};

/* ================================================================ */
/*  Resolver — why, choose, preview, resolve                        */
/* ================================================================ */

const ConflictFooter: React.FC<React.PropsWithChildren<{ phone: boolean }>> = ({
    phone,
    children,
}) =>
    // On phones, only Resolve sticks; the decision scrolls with the content.
    phone ? (
        <>{children}</>
    ) : (
        <div className="zotflow-conflict-footer">{children}</div>
    );

const ConflictResolver: React.FC<{
    entry: ConflictItemInfo;
    title: string;
    /** Every conflict the resolution ends: more than one for a group. */
    members: ConflictItemInfo[];
    libraryName?: string;
    onResolve: (
        entry: ConflictItemInfo,
        action: ConflictResolution,
    ) => Promise<void>;
    /** Phones: back to the conflict list. */
    onBack?: () => void;
}> = ({ entry, title, members, libraryName, onResolve, onBack }) => {
    const isMerge = entry.kind === "changed";
    const isGroup = members.length > 1;
    // A group is described as a whole; its members' own summaries describe each item.
    const changedMembers = members.filter((m) => m.fields.length > 0).length;
    const summary = isGroup
        ? `“${title}” was deleted in Zotero, which deletes everything under it. ${changedMembers === 1 ? "1 item" : `${changedMembers} items`} of the ${members.length} ${changedMembers === 1 ? "has" : "have"} changes here that were never uploaded.`
        : entry.summary;
    // Every resolution gives something up, so nothing is preselected.
    const [side, setSide] = useState<ConflictAction | null>(null);
    const [overwriteAll, setOverwriteAll] = useState(false);
    const [resolving, setResolving] = useState(false);

    const blockedFor = (s: Strategy) =>
        BASE_ACTION[s] === "keep-local"
            ? entry.keepLocalBlocked
            : entry.acceptRemoteBlocked;
    const strategies: ConflictAction[] = ["keep-local", "accept-remote"];
    // "Overwrite all fields" turns the chosen side into its whole-copy
    // variant; offered only where that means something different.
    const showCopies = isMerge && offersCopies(entry.fields);
    const isCopy = showCopies && overwriteAll;
    const strategy: Strategy | null = side && (isCopy ? COPY_OF[side] : side);

    const outcome: ResolutionOutcome | undefined = !strategy
        ? undefined
        : isMerge
          ? mergeOutcome(entry.fields, strategy)
          : entry.outcomes?.[BASE_ACTION[strategy]];
    const canResolve = !!strategy && !blockedFor(strategy) && !resolving;

    const resolve = async () => {
        if (!strategy || !canResolve) return;
        setResolving(true);
        try {
            await onResolve(entry, strategy);
        } finally {
            setResolving(false);
        }
    };

    return (
        <div className="zotflow-conflict-diff zotflow-conflict-resolver">
            {onBack && (
                <button className="zotflow-conflict-back" onClick={onBack}>
                    <ObsidianIcon icon="chevron-left" />
                    <span>Conflicts</span>
                </button>
            )}
            <div className="zotflow-conflict-diff-header">
                <div className="zotflow-conflict-diff-title-row">
                    <span className="zotflow-conflict-diff-heading">
                        {title}
                    </span>
                    <button
                        className="clickable-icon zotflow-conflict-why-btn"
                        aria-label="Why is this a conflict?"
                        title="Why is this a conflict?"
                        onClick={() =>
                            new ConflictDetailsModal(services.app, entry).open()
                        }
                    >
                        <ObsidianIcon icon="help-circle" />
                    </button>
                </div>
                <span className="zotflow-conflict-meta">
                    {[itemTypeLabel(entry.itemType), libraryName, entry.key]
                        .filter(Boolean)
                        .join(" · ")}
                    {entry.details.parent && (
                        <> · in “{entry.details.parent.title}”</>
                    )}
                </span>
            </div>

            <div
                className={`zotflow-conflict-summary zotflow-conflict-summary--${entry.conflictType === "update" ? "conflict" : "danger"}`}
            >
                <span className="zotflow-conflict-summary-label">
                    {entry.details.label}
                </span>
                <span>{summary}</span>
            </div>

            {isMerge ? (
                <MergeTable fields={entry.fields} strategy={strategy} />
            ) : members.length > 1 ? (
                <MemberTree members={members} />
            ) : (
                <SideTable entry={entry} />
            )}

            <ConflictFooter phone={Platform.isPhone}>
                {/* The decision on the left, its outcome and Resolve on the right. */}
                <div className="zotflow-conflict-decision">
                    {showCopies && (
                        <label className="zotflow-conflict-overwrite">
                            <input
                                type="checkbox"
                                checked={overwriteAll}
                                onChange={(e) =>
                                    setOverwriteAll(e.target.checked)
                                }
                            />
                            <span>
                                Overwrite all fields with the selected side
                            </span>
                        </label>
                    )}
                    <div
                        className="zotflow-conflict-strategies"
                        role="radiogroup"
                        aria-label="Resolution"
                    >
                        {strategies.map((s) => (
                            <button
                                key={s}
                                role="radio"
                                aria-checked={side === s}
                                className={`zotflow-conflict-strategy ${side === s ? "is-active" : ""}`}
                                disabled={!!blockedFor(s)}
                                title={blockedFor(s)}
                                onClick={() => setSide(s)}
                            >
                                <span className="zotflow-conflict-strategy-name">
                                    {STRATEGY_LABEL[s]}
                                </span>
                                <span className="zotflow-conflict-strategy-hint">
                                    {isMerge
                                        ? `${isCopy ? "All fields" : "Conflicting fields"}: ${s === "keep-local" ? "the local value" : "Zotero's value"}`
                                        : isGroup
                                          ? s === "keep-local"
                                              ? `Re-create all ${members.length} in Zotero`
                                              : `Remove all ${members.length} here`
                                          : entry.outcomes?.[s]?.hint}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="zotflow-conflict-commit">
                    {outcome && (
                        <span className="zotflow-conflict-outcome-counts">
                            <CountChip
                                direction="push"
                                count={outcome.push}
                                title={`${plural(outcome.push, isMerge ? "field" : "item")} uploaded to Zotero on the next sync`}
                            />
                            <CountChip
                                direction="pull"
                                count={outcome.pull}
                                title={`${plural(outcome.pull, isMerge ? "field" : "item")} changed here to match Zotero`}
                            />
                            <span className="zotflow-conflict-outcome-unit">
                                {isMerge ? "fields" : "items"}
                            </span>
                        </span>
                    )}
                    <button
                        className={
                            outcome?.loses && (!isMerge || isCopy)
                                ? "mod-warning"
                                : "mod-cta"
                        }
                        disabled={!canResolve}
                        title={outcome?.loses}
                        onClick={() => void resolve()}
                    >
                        {resolving
                            ? "Resolving…"
                            : strategy
                              ? `Resolve: ${STRATEGY_LABEL[strategy]}`
                              : "Resolve"}
                    </button>
                </div>
            </ConflictFooter>
        </div>
    );
};

/* ================================================================ */
/*  Field tables                                                    */
/* ================================================================ */

const Value: React.FC<{ value?: string; missing?: string }> = ({
    value,
    missing,
}) =>
    value === undefined ? (
        <span className="zotflow-field-diff-missing">{missing ?? "—"}</span>
    ) : value === "" ? (
        <span className="zotflow-field-diff-missing">(empty)</span>
    ) : (
        <pre>{value}</pre>
    );

/**
 * Whether an added run replaces a removed block (a rewritten value, or
 * removed lines) that does not end in a line break: shown below it, not
 * glued to its last word.
 */
function startsOwnLine(segments: DiffSegment[], i: number): boolean {
    const prev = segments[i - 1];
    if (prev?.type !== "del" || prev.text.endsWith("\n")) return false;
    return segments.length === 2 || prev.text.includes("\n");
}

/** Fields that hold one entry per line (tags, creators, collections): diffed by line. */
const LINE_FIELDS = new Set(["tags", "creators", "collections"]);

/**
 * A value with what changed since the last sync marked, git-style: removed
 * text struck through, added text on its side's colour. Plain when there is
 * no base to compare with or the field is not diffed (HTML shown raw).
 */
const DiffValue: React.FC<{
    field: FieldDiff;
    value?: string;
    side: "local" | "remote";
    missing?: string;
}> = ({ field, value, side, missing }) => {
    const base = field.baseValue;
    // Computed once per value, not on every choice the user makes.
    const segments = useMemo(
        () =>
            value && base !== undefined && base !== value && !field.noDiff
                ? diffText(base, value, {
                      lines: LINE_FIELDS.has(field.field),
                  })
                : undefined,
        [value, base, field.noDiff, field.field],
    );
    if (!segments) return <Value value={value} missing={missing} />;
    return (
        <pre>
            {segments.map((seg, i) =>
                seg.type === "same" ? (
                    <React.Fragment key={i}>{seg.text}</React.Fragment>
                ) : seg.type === "del" ? (
                    <del key={i} className="zotflow-diff-del">
                        {seg.text}
                    </del>
                ) : (
                    <React.Fragment key={i}>
                        {/* A replaced block: the new text starts on its own line. */}
                        {startsOwnLine(segments, i) && "\n"}
                        <ins
                            className={`zotflow-diff-add zotflow-diff-add--${side}`}
                        >
                            {seg.text}
                        </ins>
                    </React.Fragment>
                ),
            )}
        </pre>
    );
};

const SIDE_TAG: Record<
    "local" | "remote" | "combined",
    { icon: string; text: string; title: string }
> = {
    local: {
        icon: "arrow-up",
        text: "local",
        title: "Kept from this device; uploaded to Zotero",
    },
    remote: { icon: "arrow-down", text: "Zotero", title: "Taken from Zotero" },
    combined: {
        icon: "git-merge",
        text: "combined",
        title: "Both sides' changes combined; uploaded to Zotero",
    },
};

/** An item changed on both sides: Local | Zotero | Result, per field. */
const MergeTable: React.FC<{
    fields: FieldDiff[];
    strategy: Strategy | null;
}> = ({ fields, strategy }) => {
    if (fields.length === 0) {
        return (
            <div className="zotflow-sync-empty">
                <ObsidianIcon icon="info" />
                <span>The two versions hold the same content.</span>
            </div>
        );
    }
    return (
        <div className="zotflow-field-diff-wrapper">
            <table className="zotflow-field-diff-table zotflow-field-diff-table--merge">
                <thead>
                    <tr>
                        <th>Field</th>
                        <th className="zotflow-field-diff-head--local">
                            Local (Obsidian)
                        </th>
                        <th className="zotflow-field-diff-head--remote">
                            Remote (Zotero)
                        </th>
                        <th>Result</th>
                    </tr>
                </thead>
                <tbody>
                    {fields.map((f) => {
                        const isConflict = f.merge === "conflict";
                        // A conflicting field waits for the choice; any
                        // other field merges the same way either way.
                        const side =
                            isConflict && !strategy
                                ? undefined
                                : resultSide(f, strategy ?? "keep-local");
                        const result =
                            side === "local"
                                ? f.localValue
                                : side === "remote"
                                  ? f.remoteValue
                                  : f.mergedValue;
                        const tag = side ? SIDE_TAG[side] : undefined;
                        return (
                            <tr
                                key={f.field}
                                className={isConflict ? "is-conflict" : ""}
                            >
                                <td className="zotflow-field-diff-name">
                                    <span>{f.field}</span>
                                    {isConflict && (
                                        <span className="zotflow-field-diff-flag">
                                            conflict
                                        </span>
                                    )}
                                </td>
                                {(["local", "remote"] as const).map((s) => (
                                    <td
                                        key={s}
                                        className={`zotflow-field-diff-val ${side === s ? "is-chosen" : ""}`}
                                        data-label={
                                            s === "local"
                                                ? "Local (Obsidian)"
                                                : "Remote (Zotero)"
                                        }
                                    >
                                        <DiffValue
                                            field={f}
                                            side={s}
                                            value={
                                                s === "local"
                                                    ? f.localValue
                                                    : f.remoteValue
                                            }
                                        />
                                    </td>
                                ))}
                                <td
                                    className="zotflow-field-diff-val zotflow-field-diff-val--result"
                                    data-label="Result"
                                >
                                    {tag ? (
                                        <>
                                            <span
                                                className={`zotflow-field-diff-origin zotflow-field-diff-origin--${side}`}
                                                title={tag.title}
                                            >
                                                <ObsidianIcon icon={tag.icon} />
                                                {tag.text}
                                            </span>
                                            <Value value={result} />
                                        </>
                                    ) : (
                                        <span className="zotflow-field-diff-missing">
                                            Choose Keep Local or Accept Remote
                                        </span>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
};

/**
 * A remote deletion's members as the tree they form here: each with what
 * changed here, items without changes shown only for their place.
 */
const MemberTree: React.FC<{ members: ConflictItemInfo[] }> = ({ members }) => {
    const byKey = new Map(members.map((m) => [m.key, m]));
    const children = new Map<string, ConflictItemInfo[]>();
    const roots: ConflictItemInfo[] = [];
    for (const m of members) {
        const parent = m.details.parent?.key;
        if (parent && byKey.has(parent) && parent !== m.key) {
            const list = children.get(parent) ?? [];
            list.push(m);
            children.set(parent, list);
        } else {
            roots.push(m);
        }
    }
    const rows: { member: ConflictItemInfo; depth: number }[] = [];
    const visit = (m: ConflictItemInfo, depth: number) => {
        rows.push({ member: m, depth });
        for (const child of children.get(m.key) ?? []) visit(child, depth + 1);
    };
    for (const r of roots) visit(r, 0);

    return (
        <div className="zotflow-field-diff-wrapper zotflow-conflict-members">
            {rows.map(({ member, depth }) => (
                <MemberRow
                    key={member.key}
                    member={member}
                    depth={Math.min(depth, 4)}
                />
            ))}
        </div>
    );
};

const MemberRow: React.FC<{ member: ConflictItemInfo; depth: number }> = ({
    member,
    depth,
}) => {
    const changed = member.fields.length;
    const [open, setOpen] = useState(changed > 0);
    return (
        <div
            className={`zotflow-conflict-member zotflow-conflict-member--depth-${depth} ${changed ? "" : "is-unchanged"}`}
        >
            <div
                className={`zotflow-conflict-member-head ${changed ? "is-expandable" : ""}`}
                onClick={changed ? () => setOpen(!open) : undefined}
            >
                <ObsidianIcon
                    icon={
                        changed
                            ? open
                                ? "chevron-down"
                                : "chevron-right"
                            : "dot"
                    }
                    className="zotflow-conflict-member-chevron"
                />
                <span className="zotflow-conflict-member-title">
                    {member.title}
                </span>
                <span className="zotflow-conflict-member-type">
                    {itemTypeLabel(member.itemType)}
                </span>
                <span className="zotflow-conflict-member-status">
                    {changed
                        ? `${plural(changed, "field")} changed here`
                        : "no changes here"}
                </span>
            </div>
            {open && changed > 0 && (
                <table className="zotflow-field-diff-table zotflow-conflict-member-fields">
                    <colgroup>
                        <col className="zotflow-conflict-member-field-col" />
                        <col />
                    </colgroup>
                    <tbody>
                        {member.fields.map((f) => (
                            <tr key={f.field}>
                                <td className="zotflow-field-diff-name">
                                    {f.field}
                                </td>
                                <td className="zotflow-field-diff-val">
                                    <DiffValue
                                        field={f}
                                        side="local"
                                        value={f.localValue}
                                    />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
};

/** A deletion or refusal: what each side holds, with what changed marked. */
const SideTable: React.FC<{ entry: ConflictItemInfo }> = ({ entry }) => {
    const missingLocal =
        entry.kind === "local-deleted" ? "deleted here" : undefined;
    const missingRemote =
        entry.kind === "remote-deleted" ? "deleted in Zotero" : "not available";
    if (entry.fields.length === 0) {
        return (
            <div className="zotflow-sync-empty">
                <ObsidianIcon icon="info" />
                <span>
                    {entry.kind === "remote-deleted"
                        ? "No changes to this item itself; the changes are in the items under it."
                        : "No field changes recorded."}
                </span>
            </div>
        );
    }
    return (
        <div className="zotflow-field-diff-wrapper">
            <table className="zotflow-field-diff-table">
                <thead>
                    <tr>
                        <th>Field</th>
                        <th className="zotflow-field-diff-head--local">
                            Local (Obsidian)
                        </th>
                        <th className="zotflow-field-diff-head--remote">
                            Remote (Zotero)
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {entry.fields.map((f) => (
                        <tr key={f.field}>
                            <td className="zotflow-field-diff-name">
                                {f.field}
                            </td>
                            <td
                                className="zotflow-field-diff-val"
                                data-label="Local (Obsidian)"
                            >
                                <DiffValue
                                    field={f}
                                    side="local"
                                    value={f.localValue}
                                    missing={missingLocal}
                                />
                            </td>
                            <td
                                className="zotflow-field-diff-val"
                                data-label="Remote (Zotero)"
                            >
                                <DiffValue
                                    field={f}
                                    side="remote"
                                    value={f.remoteValue}
                                    missing={missingRemote}
                                />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

/* ================================================================ */
/*  Push / pull counts                                              */
/* ================================================================ */

/** An ↑ (push) or ↓ (pull) count; `count` undefined while unknown. */
export const CountChip: React.FC<{
    direction: "push" | "pull";
    count?: number | "loading" | "error";
    title: string;
}> = ({ direction, count, title }) => (
    <span
        className={`zotflow-sync-count zotflow-sync-count--${direction} ${count === 0 ? "is-zero" : ""}`}
        title={title}
    >
        <ObsidianIcon icon={direction === "push" ? "arrow-up" : "arrow-down"} />
        <span>
            {count === "loading"
                ? "…"
                : count === "error" || count === undefined
                  ? "?"
                  : count}
        </span>
    </span>
);
