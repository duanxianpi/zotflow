/**
 * Whitespace at the edge of `**` / `*` / `~~` marks.
 *
 * Zotero lets a mark swallow a boundary space (`<strong>Title </strong>Body`),
 * which CommonMark cannot express. The serializer used to compensate with
 * character references (`**Title&#x20;**&#x42;ody`); the space is now hoisted
 * outside the mark instead.
 */
import { describe, test, expect } from "vitest";
import { ConvertService } from "worker/services/convert";

const convert = new ConvertService();

async function h2m(html: string): Promise<string> {
    return (await convert.html2md(html)).trim();
}

describe("html2md: whitespace at mark edges", () => {
    test.each([
        [
            "trailing, strong",
            "<p><strong>Title </strong>Body</p>",
            "**Title** Body",
        ],
        ["trailing, em", "<p><em>it </em>x</p>", "*it* x"],
        ["leading, strong", "<p>a<strong> b</strong></p>", "a **b**"],
        ["both edges", "<p>a<strong> b </strong>c</p>", "a **b** c"],
        [
            "strike",
            `<p>a <span style="text-decoration: line-through">b </span>c</p>`,
            "a ~~b~~ c",
        ],
        ["nested marks", "<p><strong><em>a </em></strong>x</p>", "***a*** x"],
        [
            "whitespace-only mark is dropped",
            "<p>a<strong> </strong>b</p>",
            "a b",
        ],
    ])("%s", async (_label, html, expected) => {
        const md = await h2m(html);
        expect(md).toBe(expected);
        expect(md).not.toMatch(/&#x?[0-9a-f]+;/i);
    });

    test("marks without edge whitespace are unchanged", async () => {
        expect(await h2m("<p>a <strong>b</strong> c</p>")).toBe("a **b** c");
    });
});
