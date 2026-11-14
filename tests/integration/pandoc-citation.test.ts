import { beforeEach, describe, expect, test, vi } from "vitest";
import { CslRenderWorkerService } from "worker/services/csl-render";
import { DEFAULT_SETTINGS } from "settings/types";
import { findPandocCitations } from "utils/pandoc-citation";
import { resetDb, seedItem } from "../fakes/db";

const STYLE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
<info><title>Test</title><id>http://www.zotero.org/styles/pandoc-test</id></info>
<citation><layout prefix="(" suffix=")" delimiter="; "><group delimiter=", ">
<names variable="author"><name form="short"/></names><date variable="issued"><date-part name="year"/></date>
<text variable="locator" prefix="p. "/></group></layout></citation>
<bibliography><layout><text variable="title"/></layout></bibliography></style>`;
const NUMERIC = STYLE.replace(
    /<citation>[\s\S]*?<\/citation>/,
    '<citation><layout prefix="[" suffix="]" delimiter=", "><text variable="citation-number"/></layout></citation>',
);

beforeEach(resetDb);

async function seed(key: string, libraryID = 1) {
    return seedItem({
        libraryID,
        key: key.toUpperCase(),
        citationKey: key,
        csljson: {
            id: key,
            type: "article-journal",
            title: `Title ${key}`,
            author: [
                { family: key === "smith" ? "Smith" : "Jones", given: "A" },
            ],
            issued: { "date-parts": [[2024]] },
        },
    });
}

describe("Pandoc citation resolution and rendering", () => {
    test("Zotero targets distinguish personal and group libraries", async () => {
        const worker = new CslRenderWorkerService(DEFAULT_SETTINGS);
        await worker.registerCustomStyle("test", STYLE);
        await seed("smith");
        const groupItem = await seed("smith", 2);
        groupItem.raw.library.type = "group";
        const { db } = await import("db/db");
        await db.items.put(groupItem);
        const clusters = findPandocCitations("[@smith]");
        expect(
            (await worker.renderPandocCitations(clusters, [1], "test"))[0]
                ?.references[0]?.zoteroUri,
        ).toBe("zotero://select/library/items/SMITH");
        expect(
            (await worker.renderPandocCitations(clusters, [2], "test"))[0]
                ?.references[0]?.zoteroUri,
        ).toBe("zotero://select/groups/2/items/SMITH");
        worker.dispose();
    });
    test("renders cluster-specific locators, bibliography details and PDF targets offline", async () => {
        const worker = new CslRenderWorkerService(DEFAULT_SETTINGS);
        await worker.registerCustomStyle("test", STYLE);
        await seed("smith");
        await seed("jones");
        const attachment = await seedItem({
            libraryID: 1,
            key: "PDF",
            itemType: "attachment",
            parentItem: "SMITH",
        });
        if (attachment.itemType !== "attachment")
            throw new Error("Expected attachment");
        attachment.raw.data.contentType = "application/pdf";
        attachment.raw.data.linkMode = "imported_file";
        const { db } = await import("db/db");
        await db.items.put(attachment);
        const fetch = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(new Error("must remain offline"));
        try {
            const results = await worker.renderPandocCitations(
                findPandocCitations("[@smith, p. 5; @jones, pp. 8–9]"),
                [1],
                "test",
            );
            expect(results[0]?.text).toBe(
                "(Smith, 2024, p. 5; Jones, 2024, p. 8–9)",
            );
            expect(results[0]?.references).toMatchObject([
                {
                    libraryID: 1,
                    key: "SMITH",
                    citekey: "smith",
                    pandocCitation: "[@smith, p. 5]",
                    bibliography: "Title smith",
                    attachmentKey: "PDF",
                    page: "5",
                },
                {
                    libraryID: 1,
                    key: "JONES",
                    citekey: "jones",
                    pandocCitation: "[@jones, pp. 8–9]",
                    bibliography: "Title jones",
                    attachmentKey: undefined,
                    page: "8",
                },
            ]);
            expect(results[0]?.references[0]?.bibliographyHtml).toContain(
                "Title smith",
            );
            expect(results[0]?.references[0]?.bibliographyHtml).toContain(
                'data-csl-variable="title"',
            );
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            fetch.mockRestore();
            worker.dispose();
        }
    });

    test("copy payload preserves page ranges, chapters, prefixes and author suppression", async () => {
        const worker = new CslRenderWorkerService(DEFAULT_SETTINGS);
        await worker.registerCustomStyle("test", STYLE);
        await seed("smith");
        await seed("jones");
        const result = await worker.renderPandocCitations(
            findPandocCitations(
                "[see @smith, pp. 5–7; -@jones, chap. 2, for details]",
            ),
            [1],
            "test",
        );
        expect(result[0]?.references.map((ref) => ref.pandocCitation)).toEqual([
            "[see @smith, pp. 5–7]",
            "[-@jones, chap. 2, for details]",
        ]);
        worker.dispose();
    });

    test("semantic HTML preserves CSL casing and leaves ordinary exports unmarked", async () => {
        const worker = new CslRenderWorkerService(DEFAULT_SETTINGS);
        const style = STYLE.replace(
            'variable="title"',
            'variable="title" text-case="title"',
        );
        const items = [
            { id: "test", type: "article-journal", title: "a study of cement" },
        ];
        const decorated = await worker.renderBibliography(items, {
            styleXml: style,
            format: "html",
            htmlVariableSpans: true,
        });
        expect(decorated[0]).toContain(
            '<span data-csl-variable="title">A Study of Cement</span>',
        );
        const ordinary = await worker.renderBibliography(items, {
            styleXml: style,
            format: "html",
        });
        expect(ordinary[0]).toContain("A Study of Cement");
        expect(ordinary[0]).not.toContain("data-csl-variable");
        worker.dispose();
    });

    test("marks DOI and URL fields without dropping their reference text", async () => {
        const worker = new CslRenderWorkerService(DEFAULT_SETTINGS);
        const style = STYLE.replace(
            '<text variable="title"/>',
            '<text variable="title"/><text variable="DOI" prefix=". https://doi.org/"/><text variable="URL" prefix=". "/>',
        );
        const result = await worker.renderBibliography(
            [
                {
                    id: "links",
                    type: "article-journal",
                    title: "Reference",
                    DOI: "10.1234/example",
                    URL: "https://example.org/reference",
                },
            ],
            { styleXml: style, format: "html", htmlVariableSpans: true },
        );
        expect(result[0]).toContain('data-csl-variable="DOI"');
        expect(result[0]).toContain('data-csl-variable="URL"');
        expect(result[0]).toContain("10.1234/example");
        expect(result[0]).toContain("https://example.org/reference");
        worker.dispose();
    });

    test("numbering uses the whole document, including repeated citations", async () => {
        const worker = new CslRenderWorkerService(DEFAULT_SETTINGS);
        await worker.registerCustomStyle("test", NUMERIC);
        await seed("smith");
        await seed("jones");
        const result = await worker.renderPandocCitations(
            findPandocCitations("[@jones] then [@smith] then [@jones; @smith]"),
            [1],
            "test",
        );
        expect(result.map((r) => r?.text)).toEqual(["[1]", "[2]", "[1, 2]"]);
        const otherDocument = await worker.renderPandocCitations(
            findPandocCitations("[@smith]"),
            [1],
            "test",
        );
        expect(otherDocument[0]?.text).toBe("[1]");
        worker.dispose();
    });

    test("disambiguates authors and years across separate clusters", async () => {
        const worker = new CslRenderWorkerService(DEFAULT_SETTINGS);
        await worker.registerCustomStyle(
            "test",
            STYLE.replace(
                "<citation>",
                '<citation disambiguate-add-year-suffix="true">',
            ),
        );
        await seed("smith");
        await seedItem({
            libraryID: 1,
            key: "SMITH2",
            citationKey: "smith2",
            csljson: {
                id: "smith2",
                type: "article-journal",
                title: "Other Smith paper",
                author: [{ family: "Smith", given: "A" }],
                issued: { "date-parts": [[2024]] },
            },
        });
        const result = await worker.renderPandocCitations(
            findPandocCitations("[@smith] and [@smith2]"),
            [1],
            "test",
        );
        expect(new Set(result.map((r) => r?.text))).toEqual(
            new Set(["(Smith, 2024a)", "(Smith, 2024b)"]),
        );
        worker.dispose();
    });

    test("unknown, duplicate, trashed, ignored and metadata-less items preserve source", async () => {
        const worker = new CslRenderWorkerService(DEFAULT_SETTINGS);
        await worker.registerCustomStyle("test", STYLE);
        await seed("smith");
        await seed("smith", 2);
        await seedItem({
            libraryID: 1,
            key: "TRASH",
            citationKey: "trash",
            trashed: 1,
        });
        await seedItem({ libraryID: 1, key: "OLD", citationKey: "old" });
        const clusters = findPandocCitations(
            "[@smith] [@missing] [@old] [@trash] [@smith; @missing]",
        );
        expect(
            await worker.renderPandocCitations(clusters, [1, 2], "test"),
        ).toEqual([null, null, null, null, null]);
        expect(
            (await worker.renderPandocCitations(clusters, [1], "test"))[0]
                ?.text,
        ).toBe("(Smith, 2024)");
        expect(
            await worker.renderPandocCitations(clusters, [], "test"),
        ).toEqual([null, null, null, null, null]);
        expect(
            await worker.renderPandocCitations(clusters, [1], "missing-style"),
        ).toEqual([null, null, null, null, null]);
        worker.dispose();
    });
});
