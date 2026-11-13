import { describe, expect, test } from "vitest";
import {
    findPandocCitations,
    parsePandocCitation,
} from "utils/pandoc-citation";

describe("Pandoc citation syntax", () => {
    test("aligns escaped Reading View literals with unescaped duplicates", () => {
        const source = "\\[@smith] and [@smith], then \\\\[@smith].";
        expect(findPandocCitations(source).map((c) => c.from)).toEqual([
            14, 31,
        ]);
        expect(
            findPandocCitations(source, true).map((c) => !!c.literal),
        ).toEqual([true, false, false]);
    });
    test("preserves exact source offsets and source text", () => {
        const source =
            "An emoji 🧱 and **evidence [@smith2024, p. 5]**; more [@jones; @lee].";
        const found = findPandocCitations(source);
        expect(found.map((c) => c.raw)).toEqual([
            "[@smith2024, p. 5]",
            "[@jones; @lee]",
        ]);
        for (const citation of found)
            expect(source.slice(citation.from, citation.to)).toBe(citation.raw);
    });

    test("locators belong to each reference in a cluster", () => {
        expect(
            parsePandocCitation(
                "[see @smith, pp. 5–7; -@jones, chap. 2, for details]",
            ),
        ).toEqual([
            { citekey: "smith", prefix: "see ", locator: "5–7", label: "page" },
            {
                citekey: "jones",
                suppressAuthor: true,
                locator: "2",
                label: "chapter",
                suffix: ", for details",
            },
        ]);
        expect(parsePandocCitation("[@smith, 15]")).toEqual([
            { citekey: "smith", locator: "15", label: "page" },
        ]);
    });

    test.each(["a", "Smith:2024/a-b", "王2024", "x.y", "z_1"])(
        "handles key %s",
        (key) => {
            expect(parsePandocCitation(`[@${key}]`)).toEqual([
                { citekey: key },
            ]);
        },
    );

    test.each([
        "`[@smith]`",
        "```md\n[@smith]\n```",
        "    [@smith]",
        "[[@smith]]",
        "![[@smith]]",
        "![@smith](image.png)",
        "[@smith](https://example.com)",
        "[[@smith]][ref]\n\n[ref]: https://example.com",
        "\\[@smith]",
        "<!-- [@smith] -->",
        "%% [@smith] %%",
        "$[@smith]$",
        "$$\n[@smith]\n$$",
        "<code>[@smith]</code>",
        '---\ntitle: "[@smith]"\n---\n',
    ])("does not decorate non-prose %j", (source) => {
        expect(findPandocCitations(source)).toEqual([]);
    });

    test.each([
        "[@]",
        "[@a;]",
        "[email@example.com]",
        "[@a @b]",
        "[@a; text]",
        "[plain text]",
    ])("leaves malformed syntax %s alone", (raw) => {
        expect(parsePandocCitation(raw)).toBeNull();
    });
});
