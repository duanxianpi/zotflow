/**
 * The template tester's write-back rules: which setting or file a tested
 * template is saved to, and when saving clears a setting instead.
 */
import { describe, test, expect } from "vitest";

import {
    CONTEXT_LABELS,
    effectiveTemplate,
    matchesSaved,
    planWriteBack,
    TEMPLATE_TARGETS,
    writeBackWarnings,
} from "ui/activity-center/template-targets";
import { DEFAULT_SETTINGS } from "settings/types";

import type {
    SavedTemplate,
    TemplateContext,
} from "ui/activity-center/template-targets";

function saved(over: Partial<SavedTemplate> & { context: TemplateContext }): SavedTemplate {
    return { stored: "", filePath: "", builtIn: "BUILT-IN", ...over };
}

describe("targets", () => {
    test("every context has a target, and every target names a real setting", () => {
        for (const context of Object.keys(CONTEXT_LABELS) as TemplateContext[]) {
            const target = TEMPLATE_TARGETS[context];
            const key = target.kind === "setting" ? target.key : target.pathKey;
            expect(typeof DEFAULT_SETTINGS[key]).toBe("string");
        }
    });

    test("source notes save to a file, the rest to a setting", () => {
        expect(TEMPLATE_TARGETS.library.kind).toBe("file");
        expect(TEMPLATE_TARGETS.local.kind).toBe("file");
        expect(TEMPLATE_TARGETS["display-title"]).toMatchObject({
            kind: "setting",
            key: "itemDisplayTitleTemplate",
        });
    });
});

describe("effectiveTemplate / matchesSaved", () => {
    test("an empty setting means the built-in template", () => {
        const s = saved({ context: "citation-pandoc", stored: "  " });
        expect(effectiveTemplate(s)).toBe("BUILT-IN");
        expect(matchesSaved("BUILT-IN\n", s)).toBe(true);
    });

    test("a missing template file means the built-in template", () => {
        const s = saved({ context: "library", stored: null, filePath: "T.md" });
        expect(effectiveTemplate(s)).toBe("BUILT-IN");
    });

    test("a setting is compared trimmed, as it is trimmed before use", () => {
        const s = saved({ context: "library-path", stored: "P/{{key}}" });
        expect(matchesSaved("  P/{{key}}\n", s)).toBe(true);
        expect(matchesSaved("P/{{title}}", s)).toBe(false);
    });

    test("a template file is compared exactly: its whitespace reaches the note", () => {
        const s = saved({ context: "library", stored: "---\na: 1\n---\ntext", filePath: "T.md" });
        // An indent makes a code block; a blank line first hides the frontmatter.
        expect(matchesSaved("---\na: 1\n---\n    text", s)).toBe(false);
        expect(matchesSaved("\n---\na: 1\n---\ntext", s)).toBe(false);
        expect(matchesSaved("---\na: 1\n---\ntext", s)).toBe(true);
    });

    test("an empty template file means the built-in template, as for real renders", () => {
        expect(effectiveTemplate(saved({ context: "local", stored: "", filePath: "T.md" }))).toBe("BUILT-IN");
        // Whitespace is not empty: the renderer uses it as it is.
        expect(effectiveTemplate(saved({ context: "local", stored: " ", filePath: "T.md" }))).toBe(" ");
    });
});

describe("planWriteBack", () => {
    test("a setting gets the trimmed template", () => {
        expect(planWriteBack(saved({ context: "citation-pandoc" }), "\n[@{{ item.key }}]\n")).toEqual({
            kind: "setting",
            key: "citationPandocTemplate",
            value: "[@{{ item.key }}]",
            clearsToBuiltIn: false,
        });
    });

    test("the built-in template clears the setting, to keep following the default", () => {
        expect(planWriteBack(saved({ context: "library-path" }), " BUILT-IN ")).toEqual({
            kind: "setting",
            key: "librarySourceNotePathTemplate",
            value: "",
            clearsToBuiltIn: true,
        });
    });

    test("an empty display title template clears the setting", () => {
        expect(
            planWriteBack(saved({ context: "display-title", builtIn: "" }), ""),
        ).toMatchObject({ value: "", clearsToBuiltIn: false });
    });

    test("a file target with a template file overwrites it", () => {
        expect(
            planWriteBack(saved({ context: "library", filePath: "T/note.md" }), "# x"),
        ).toEqual({ kind: "file", path: "T/note.md", content: "# x", setsPath: null });
    });

    test("a file target without one writes the chosen file and sets the path", () => {
        expect(
            planWriteBack(saved({ context: "local", stored: null }), "# x", " Mine.md "),
        ).toEqual({
            kind: "file",
            path: "Mine.md",
            content: "# x",
            setsPath: "localSourceNoteTemplatePath",
        });
    });

    test("a chosen path without .md gets it, like the path real renders read", () => {
        expect(
            planWriteBack(saved({ context: "library", stored: null }), "# x", "Templates/Mine"),
        ).toMatchObject({ path: "Templates/Mine.md" });
    });

    test("without a chosen path the default file is suggested", () => {
        const plan = planWriteBack(saved({ context: "library", stored: null }), "# x");
        expect(plan).toMatchObject({
            path: "Templates/ZotFlow Library Source Note.md",
            setsPath: "librarySourceNoteTemplatePath",
        });
    });
});

describe("writeBackWarnings", () => {
    test("line breaks in a one-line setting are pointed out", () => {
        expect(
            writeBackWarnings(saved({ context: "display-title" }), "{{ a }}\n{{ b }}"),
        ).toHaveLength(1);
    });

    test("multi-line settings and trailing newlines are fine", () => {
        expect(writeBackWarnings(saved({ context: "citation-footnote" }), "a\nb")).toEqual([]);
        expect(writeBackWarnings(saved({ context: "display-title" }), "a\n")).toEqual([]);
    });
});
