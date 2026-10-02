import { describe, expect, test } from "vitest";
import {
    mergeTemplateFrontmatter,
    withMandatoryFirst,
} from "utils/template-frontmatter";

describe("template frontmatter merge protocol", () => {
    test("bare keys overwrite while ?? keys preserve existing values", () => {
        expect(
            mergeTemplateFrontmatter(
                { rating: "5 stars", status: "draft" },
                { "??rating": "unrated", status: "published" },
            ),
        ).toEqual({ rating: "5 stars", status: "published" });
    });

    test("a ?? key supplies a default when the key is absent", () => {
        expect(mergeTemplateFrontmatter({}, { "??rating": "unrated" })).toEqual(
            { rating: "unrated" },
        );
    });

    test.each([false, 0, "", null])(
        "an existing falsy value (%j) is still preserved",
        (value) => {
            expect(
                mergeTemplateFrontmatter(
                    { rating: value },
                    { "??rating": "unrated" },
                ),
            ).toEqual({ rating: value });
        },
    );

    test("an empty prefixed key is ignored", () => {
        expect(mergeTemplateFrontmatter({}, { "??": "ignored" })).toEqual({});
    });
});

describe("withMandatoryFirst", () => {
    test("mandatory keys come first, in their order; the rest keep theirs", () => {
        const out = withMandatoryFirst(
            { "zotflow-locked": true, "zotero-key": "ABCD1234" },
            { title: "T", "zotero-key": "OLD", tags: ["a"] },
        );
        expect(Object.keys(out)).toEqual(["zotflow-locked", "zotero-key", "title", "tags"]);
        expect(out["zotero-key"]).toBe("ABCD1234");
    });
});
