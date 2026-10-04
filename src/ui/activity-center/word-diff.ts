import { diffLines, diffWordsWithSpace } from "diff";

import type { ChangeObject } from "diff";

/** One run of a diff: text both versions share, or only the old / new one has. */
export interface DiffSegment {
    type: "same" | "del" | "add";
    text: string;
}

/**
 * Edit distances past which a diff gives up and falls back a level (words →
 * lines → the whole value): Myers' algorithm is fast for small changes, and
 * a change this large reads better coarser anyway.
 */
const MAX_WORD_EDITS = 400;
const MAX_LINE_EDITS = 2000;

/** Below this share of unchanged text, a value reads as rewritten: shown old then new, not word by word. */
const REWRITE_BELOW = 0.5;

/** Appends a run, merging it into the previous one of the same type. */
function push(out: DiffSegment[], type: DiffSegment["type"], text: string) {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === type) last.text += text;
    else out.push({ type, text });
}

function toSegments(changes: ChangeObject<string>[]): DiffSegment[] {
    const out: DiffSegment[] = [];
    for (const c of changes) {
        push(out, c.added ? "add" : c.removed ? "del" : "same", c.value);
    }
    return out;
}

/** The old text removed, then the new one added: the coarsest diff. */
function replaced(before: string, after: string): DiffSegment[] {
    const out: DiffSegment[] = [];
    push(out, "del", before);
    push(out, "add", after);
    return out;
}

/** The share of non-space text both versions keep. */
function similarity(
    segments: DiffSegment[],
    before: string,
    after: string,
): number {
    const size = (t: string) => t.replace(/\s/g, "").length;
    const kept = segments
        .filter((s) => s.type === "same")
        .reduce((n, s) => n + size(s.text), 0);
    const total = Math.max(size(before), size(after));
    return total === 0 ? 1 : kept / total;
}

/**
 * The share of non-space text made of words both versions have (counting
 * repeats): an upper bound of what any diff of the two keeps, in O(n).
 */
function sharedWords(before: string, after: string): number {
    const counts = new Map<string, number>();
    let sizeBefore = 0;
    for (const w of before.split(/\s+/)) {
        if (!w) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
        sizeBefore += w.length;
    }
    let shared = 0;
    let sizeAfter = 0;
    for (const w of after.split(/\s+/)) {
        if (!w) continue;
        sizeAfter += w.length;
        const n = counts.get(w) ?? 0;
        if (n > 0) {
            shared += w.length;
            counts.set(w, n - 1);
        }
    }
    const total = Math.max(sizeBefore, sizeAfter);
    return total === 0 ? 1 : shared / total;
}

/**
 * Word-level diff of a line; old-then-new when it was mostly rewritten or
 * the change is too large to diff word by word.
 */
function wordDiff(before: string, after: string): DiffSegment[] {
    // A diff can keep at most the words both share: when that is under the
    // threshold the line is rewritten for certain, no diff needed.
    if (sharedWords(before, after) < REWRITE_BELOW)
        return replaced(before, after);
    const changes = diffWordsWithSpace(before, after, {
        maxEditLength: MAX_WORD_EDITS,
    });
    if (!changes) return replaced(before, after);
    const segments = toSegments(changes);
    return similarity(segments, before, after) >= REWRITE_BELOW
        ? segments
        : replaced(before, after);
}

/** Lines, each keeping its line break. */
function splitLines(text: string): string[] {
    const parts = text.split("\n");
    return parts
        .map((line, i) => (i < parts.length - 1 ? `${line}\n` : line))
        .filter((t) => t !== "");
}

/**
 * Line-level diff; where a run of lines was replaced by as many lines, each
 * pair is diffed word by word (an edited line, not a removed and an added
 * one). `refine: false` keeps whole lines (list fields).
 */
function lineDiff(
    before: string,
    after: string,
    refine: boolean,
): DiffSegment[] {
    const changes = diffLines(before, after, { maxEditLength: MAX_LINE_EDITS });
    if (!changes) return replaced(before, after);
    const lines = toSegments(changes);
    if (!refine) return lines;

    const out: DiffSegment[] = [];
    for (let k = 0; k < lines.length; k++) {
        const seg = lines[k]!;
        const next = lines[k + 1];
        if (seg.type === "del" && next?.type === "add") {
            const old = splitLines(seg.text);
            const now = splitLines(next.text);
            if (old.length === now.length) {
                old.forEach((line, n) => {
                    for (const part of wordDiff(line, now[n]!)) {
                        push(out, part.type, part.text);
                    }
                });
                k++;
                continue;
            }
        }
        push(out, seg.type, seg.text);
    }
    return out;
}

/**
 * What changed from `before` to `after`, git-style, as runs of shared,
 * removed and added text. Text with line breaks is compared line by line
 * (edited lines word by word); `lines` compares whole lines only (list
 * fields: one entry per line). A change too large for one level falls back
 * to the next coarser one, down to the whole value removed and added.
 */
export function diffText(
    before: string,
    after: string,
    { lines = false }: { lines?: boolean } = {},
): DiffSegment[] {
    if (lines) return lineDiff(before, after, false);
    if (before.includes("\n") || after.includes("\n")) {
        return lineDiff(before, after, true);
    }
    return wordDiff(before, after);
}
