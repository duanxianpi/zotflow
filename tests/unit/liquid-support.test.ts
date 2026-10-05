/**
 * Template preview helpers: where a Liquid error is reported. Liquid counts
 * lines from the string it was handed, and source notes render frontmatter
 * and body apart, so every position is shifted back into the whole template.
 */
import { describe, test, expect } from "vitest";
import { Liquid } from "liquidjs";

import {
    liquidErrorInfo,
    previewResult,
    renderFragment,
    splitFrontmatter,
    TemplatePreviewError,
    trimmedStart,
} from "worker/services/liquid-support";

const engine = new Liquid({ greedy: false });

async function errorOf(source: string, firstLine = 1, firstCol = 1) {
    try {
        await renderFragment(engine, source, {}, firstLine, firstCol);
    } catch (e) {
        if (e instanceof TemplatePreviewError) return e.info;
        throw e;
    }
    throw new Error("rendered without an error");
}

describe("liquidErrorInfo", () => {
    test("a syntax error is a parse error at its line and column", async () => {
        expect(await errorOf("ok\n  {{ item.title")).toEqual({
            phase: "parse",
            message: expect.stringContaining("output"),
            line: 2,
            col: 3,
        });
    });

    test("an unclosed tag is a parse error", async () => {
        expect(await errorOf("{% if x %}\nyes")).toMatchObject({
            phase: "parse",
            line: 1,
        });
    });

    test("an evaluation error is a render error", async () => {
        // No file system is configured, so a partial cannot be found.
        expect(await errorOf("a\n{% render 'missing' %}")).toMatchObject({
            phase: "render",
            line: 2,
            col: 1,
        });
    });

    test("the message loses Liquid's own position suffix", async () => {
        const info = await errorOf("{{ x");
        expect(info.message).not.toMatch(/line:\d+/);
    });

    test("positions are shifted to where the fragment starts", async () => {
        expect(await errorOf("x\n{{ y", 10)).toMatchObject({ line: 11, col: 1 });
    });

    test("the start column applies to the fragment's first line only", async () => {
        expect(await errorOf("{{ y", 3, 5)).toMatchObject({ line: 3, col: 5 });
        expect(await errorOf("x\n{{ y", 3, 5)).toMatchObject({ line: 4, col: 1 });
    });

    test("a non-Liquid error is a render error without a position", () => {
        expect(liquidErrorInfo(new Error("boom"))).toEqual({
            phase: "render",
            message: "boom",
        });
    });
});

describe("splitFrontmatter", () => {
    test("the body starts after the closing fence", () => {
        const t = "---\na: 1\nb: 2\n---\n# Body";
        const { frontmatter, body, bodyLine } = splitFrontmatter(t);
        expect(frontmatter).toBe("a: 1\nb: 2");
        expect(body).toBe("# Body");
        expect(t.split("\n")[bodyLine - 1]).toBe("# Body");
    });

    test("a template without frontmatter is all body", () => {
        expect(splitFrontmatter("# Body")).toEqual({
            frontmatter: "",
            body: "# Body",
            bodyLine: 1,
        });
    });

    test("CRLF line endings count the same lines", () => {
        const t = "---\r\na: 1\r\n---\r\n# Body";
        const { bodyLine } = splitFrontmatter(t);
        expect(t.split("\n")[bodyLine - 1]).toBe("# Body");
    });
});

describe("trimmedStart", () => {
    test("leading blank lines and spaces move the start", () => {
        expect(trimmedStart("\n\n  {{ x }}  \n")).toEqual({
            source: "{{ x }}",
            firstLine: 3,
            firstCol: 3,
        });
    });

    test("an untrimmed template starts at 1:1", () => {
        expect(trimmedStart("{{ x }}")).toEqual({
            source: "{{ x }}",
            firstLine: 1,
            firstCol: 1,
        });
    });
});

describe("previewResult", () => {
    test("a template error is an answer, with the hints gathered so far", async () => {
        const result = await previewResult(async (hints) => {
            hints.push("first");
            await renderFragment(engine, "{{ x", {});
            return { output: "" };
        });
        expect(result).toMatchObject({
            ok: false,
            error: { phase: "parse" },
            hints: ["first"],
        });
    });

    test("any other failure still throws", async () => {
        await expect(
            previewResult(async () => {
                throw new Error("item missing");
            }),
        ).rejects.toThrow("item missing");
    });
});
