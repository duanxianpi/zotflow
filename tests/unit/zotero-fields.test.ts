/**
 * `utils/zotero-fields` — base-field resolution against the generated
 * schema map, mirroring Zotero's `getField(field, false, true)`.
 */
import { describe, test, expect } from "vitest";

import { Liquid } from "liquidjs";

import {
    buildItemMetadata,
    getCreators,
    getField,
    getFieldValues,
} from "utils/zotero-fields";
import { ZOTERO_FIELDS } from "types/zotero-base-fields";

import type { AnyIDBZoteroItem } from "types/db-schema";

describe("getField", () => {
    test.each([
        ["case", "caseName", "title"],
        ["statute", "nameOfAct", "title"],
        ["email", "subject", "title"],
        ["bookSection", "bookTitle", "publicationTitle"],
        ["conferencePaper", "proceedingsTitle", "publicationTitle"],
        ["webpage", "websiteTitle", "publicationTitle"],
        ["thesis", "university", "publisher"],
        ["report", "institution", "publisher"],
        ["patent", "issueDate", "date"],
        ["case", "dateDecided", "date"],
        ["case", "court", "authority"],
        ["case", "docketNumber", "number"],
    ])("a %s's %s stands in for %s", (itemType, specific, base) => {
        expect(getField({ itemType, [specific]: "value" }, base)).toBe("value");
    });

    test("a field the type holds directly is read as-is", () => {
        expect(
            getField({ itemType: "journalArticle", title: "Direct" }, "title"),
        ).toBe("Direct");
    });

    test("the type-specific name still resolves to itself", () => {
        expect(
            getField({ itemType: "case", caseName: "Roe" }, "caseName"),
        ).toBe("Roe");
    });

    test("a direct value wins over the mapped one", () => {
        expect(
            getField({ itemType: "case", title: "T", caseName: "C" }, "title"),
        ).toBe("T");
    });

    test("empty strings fall through to the mapped field", () => {
        expect(
            getField({ itemType: "case", title: "", caseName: "C" }, "title"),
        ).toBe("C");
    });

    test("an unmapped type or missing field yields undefined", () => {
        expect(
            getField({ itemType: "journalArticle" }, "title"),
        ).toBeUndefined();
        expect(getField({ itemType: "unknownType" }, "title")).toBeUndefined();
        expect(
            getField({ itemType: "case", caseName: "" }, "title"),
        ).toBeUndefined();
    });

    test("non-string values are ignored", () => {
        expect(
            getField({ itemType: "journalArticle", title: 42 }, "title"),
        ).toBeUndefined();
    });
});

describe("getFieldValues", () => {
    test("sets both the base and the type-specific name", () => {
        expect(
            getFieldValues({
                itemType: "bookSection",
                title: "Chapter",
                bookTitle: "Book",
                pages: "",
            }),
        ).toEqual({
            title: "Chapter",
            bookTitle: "Book",
            publicationTitle: "Book",
        });
    });

    test("ignores keys that are not schema fields", () => {
        expect(
            getFieldValues({
                itemType: "journalArticle",
                key: "K",
                parentItem: "P",
                dateAdded: "2020-01-01",
                notAField: "x",
            }),
        ).toEqual({});
    });
});

describe("getCreators", () => {
    test("keeps role and name parts and joins a display name", () => {
        expect(
            getCreators({
                itemType: "book",
                creators: [
                    {
                        creatorType: "author",
                        firstName: "Jane",
                        lastName: "Doe",
                    },
                    { creatorType: "editor", name: "Acme" },
                ],
            }),
        ).toEqual([
            {
                creatorType: "author",
                firstName: "Jane",
                lastName: "Doe",
                name: "Jane Doe",
            },
            {
                creatorType: "editor",
                firstName: undefined,
                lastName: undefined,
                name: "Acme",
            },
        ]);
    });

    test("an item without creators yields an empty list", () => {
        expect(getCreators({ itemType: "note" })).toEqual([]);
    });
});

describe("buildItemMetadata", () => {
    const item = {
        libraryID: 1,
        key: "ARTICLE1",
        itemType: "journalArticle",
        title: "A Study",
        raw: {
            data: {
                itemType: "journalArticle",
                title: "A Study",
                DOI: "10.1/x",
                creators: [],
            },
        },
    } as unknown as AnyIDBZoteroItem;

    test("every schema field is a key, undefined when the item has no value", () => {
        const meta = buildItemMetadata(item) as unknown as Record<string, unknown>;
        for (const name of ZOTERO_FIELDS) expect(name in meta).toBe(true);
        expect(meta.DOI).toBe("10.1/x");
        expect(meta.ISBN).toBeUndefined();
        expect(meta.caseName).toBeUndefined();
    });

    test("fields with a value come first", () => {
        const keys = Object.keys(buildItemMetadata(item));
        expect(keys.indexOf("DOI")).toBeLessThan(keys.indexOf("ISBN"));
        expect(keys.indexOf("title")).toBeLessThan(keys.indexOf("abstractNote"));
    });

    test("the fields ZotFlow always sets keep their values", () => {
        expect(buildItemMetadata(item)).toMatchObject({
            title: "A Study",
            citationKey: "",
            date: null,
            accessDate: null,
            year: "",
            creators: [],
            creatorSummary: "",
        });
    });

    test("an undefined field renders exactly like a missing one", () => {
        const engine = new Liquid({ greedy: false });
        const withKeys = buildItemMetadata(item);
        const without = Object.fromEntries(
            Object.entries(withKeys).filter(([, v]) => v !== undefined),
        );
        const probes = [
            "{% if item.ISBN %}T{% else %}F{% endif %}",
            '{% if item.ISBN != "" %}T{% else %}F{% endif %}',
            "{% if item.ISBN == nil %}T{% else %}F{% endif %}",
            "{% if item.ISBN == blank %}T{% else %}F{% endif %}",
            "{% if item.ISBN == empty %}T{% else %}F{% endif %}",
            '{{ item.ISBN | default: "D" }}',
            "[{{ item.ISBN }}]",
            "[{{ item.ISBN | json }}]",
            "{{ item | json }}",
            "{{ item.ISBN | size }}",
            "{% unless item.ISBN %}U{% endunless %}",
        ];
        for (const probe of probes) {
            expect(engine.parseAndRenderSync(probe, { item: withKeys }), probe).toBe(
                engine.parseAndRenderSync(probe, { item: without }),
            );
        }
    });
});
