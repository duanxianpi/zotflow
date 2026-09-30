/**
 * `utils/zotero-fields` — base-field resolution against the generated
 * schema map, mirroring Zotero's `getField(field, false, true)`.
 */
import { describe, test, expect } from "vitest";

import { getCreators, getField, getFieldValues } from "utils/zotero-fields";

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
