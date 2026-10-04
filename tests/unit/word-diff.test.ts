/**
 * The git-style marks in the conflict panel: what changed between the last
 * synced value and a side's value, by word or (list fields) by line.
 */
import { describe, test, expect } from "vitest";
import { diffText } from "ui/activity-center/word-diff";

describe("diffText", () => {
    test("marks a replaced word and keeps the rest", () => {
        expect(diffText("Title highlight here", "My highlight here")).toEqual([
            { type: "del", text: "Title" },
            { type: "add", text: "My" },
            { type: "same", text: " highlight here" },
        ]);
    });

    test("identical text is one shared run", () => {
        expect(diffText("same text", "same text")).toEqual([{ type: "same", text: "same text" }]);
    });

    test("from empty, everything is added", () => {
        expect(diffText("", "new words")).toEqual([{ type: "add", text: "new words" }]);
    });

    test("lines mode diffs whole entries", () => {
        expect(diffText("alpha\nbeta", "alpha\ngamma", { lines: true })).toEqual([
            { type: "same", text: "alpha\n" },
            { type: "del", text: "beta" },
            { type: "add", text: "gamma" },
        ]);
    });

    test("the runs rebuild both texts", () => {
        const before = "The quick brown fox jumps over the lazy dog";
        const after = "A quick red fox leaps over the dog today";
        const segments = diffText(before, after);
        expect(segments.filter((s) => s.type !== "add").map((s) => s.text).join("")).toBe(before);
        expect(segments.filter((s) => s.type !== "del").map((s) => s.text).join("")).toBe(after);
    });

    test("a mostly rewritten value is shown old then new", () => {
        expect(diffText("Definition.", "Comment made here")).toEqual([
            { type: "del", text: "Definition." },
            { type: "add", text: "Comment made here" },
        ]);
    });

    test("an edited line in a longer text is marked word by word; other lines stay", () => {
        expect(diffText("# Notes\nThe quick fox\nEnd", "# Notes\nThe slow fox\nEnd")).toEqual([
            { type: "same", text: "# Notes\nThe " },
            { type: "del", text: "quick" },
            { type: "add", text: "slow" },
            { type: "same", text: " fox\nEnd" },
        ]);
    });

    test("removed and added lines stay whole", () => {
        const segments = diffText("keep\ngone\nkeep too\n", "keep\nkeep too\nnew line\n");
        expect(segments).toContainEqual({ type: "del", text: "gone\n" });
        expect(segments).toContainEqual({ type: "add", text: "new line\n" });
        expect(segments.filter((s) => s.type !== "add").map((s) => s.text).join("")).toBe("keep\ngone\nkeep too\n");
    });

    test("a single huge rewritten line falls back to the whole value, old then new", () => {
        const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
        const before = words(2000, "a");
        const after = words(2000, "b");
        expect(diffText(before, after)).toEqual([
            { type: "del", text: before },
            { type: "add", text: after },
        ]);
    });

    test("a huge multi-line text still gets a line-level diff, with edited lines word by word", () => {
        const para = (i: number) => `Paragraph ${i} ${Array.from({ length: 60 }, (_, j) => `w${(i * 7 + j) % 997}`).join(" ")}\n`;
        const before = Array.from({ length: 300 }, (_, i) => para(i)).join("");
        const after = before.replace("Paragraph 50 ", "Paragraph fifty ");
        const segments = diffText(before, after);
        expect(segments).toContainEqual({ type: "del", text: "50" });
        expect(segments).toContainEqual({ type: "add", text: "fifty" });
        expect(segments.filter((s) => s.type !== "add").map((s) => s.text).join("")).toBe(before);
        expect(segments.filter((s) => s.type !== "del").map((s) => s.text).join("")).toBe(after);
    });
});
