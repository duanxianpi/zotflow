/**
 * The template tester's variable list: the scope a template renders with,
 * grouped and explained per item type, without changing the scope itself.
 */
import { describe, test, expect } from "vitest";
import { Liquid } from "liquidjs";

import { describeTemplateScope } from "worker/services/template-variables";

import type { TemplateVariable, TemplateVariables } from "types/template-preview";

const engine = new Liquid();

function find(vars: TemplateVariables, path: string): TemplateVariable | undefined {
    const walk = (list: TemplateVariable[]): TemplateVariable | undefined => {
        for (const v of list) {
            if (v.path === path) return v;
            const inner = v.children && walk(v.children);
            if (inner) return inner;
        }
        return undefined;
    };
    for (const g of vars.groups) {
        const hit = walk(g.variables);
        if (hit) return hit;
    }
    return undefined;
}

const caseItem = {
    caseName: "Roe v. Wade",
    title: "Roe v. Wade",
    court: "SCOTUS",
    authority: "SCOTUS",
    year: "1973",
    key: "CASE0001",
    date: null,
    creators: [{ name: "Burger", creatorType: "author" }],
};

describe("describeTemplateScope", () => {
    test("a base name filled from a type-specific field says where it comes from", () => {
        const vars = describeTemplateScope({
            scope: { item: caseItem },
            engine,
            item: { type: "case", under: "item" },
        });
        const fields = vars.groups[0]!;
        expect(fields.label).toBe("Zotero fields · Case");
        const names = fields.variables.map((v) => v.name);
        // The base name follows the field it is filled from.
        expect(names.indexOf("title")).toBe(names.indexOf("caseName") + 1);
        expect(find(vars, "item.caseName")).toMatchObject({ kind: "type-specific", value: "Roe v. Wade" });
        expect(find(vars, "item.title")).toMatchObject({ kind: "base-mapped", mappedFrom: "caseName" });
        expect(find(vars, "item.authority")).toMatchObject({ kind: "base-mapped", mappedFrom: "court" });
    });

    test("fields the type has but the item leaves empty are listed empty", () => {
        const vars = describeTemplateScope({
            scope: { item: caseItem },
            engine,
            item: { type: "case", under: "item" },
        });
        expect(find(vars, "item.reporter")).toMatchObject({ kind: "field", type: "null", value: "" });
    });

    test("what ZotFlow adds is a group of its own", () => {
        const vars = describeTemplateScope({
            scope: { item: caseItem },
            engine,
            item: { type: "case", under: "item" },
        });
        const zotflow = vars.groups.find((g) => g.label === "ZotFlow variables")!;
        expect(zotflow.variables.map((v) => v.name)).toEqual(["year", "key", "creators"]);
        expect(find(vars, "item.creators")).toMatchObject({ type: "array", count: 1 });
        expect(find(vars, "item.creators[0].name")).toMatchObject({ value: "Burger" });
    });

    test("schema fields the type does not have are folded away, not mixed in", () => {
        const vars = describeTemplateScope({
            scope: { item: { title: "A", publicationTitle: "J" } },
            engine,
            item: { type: "journalArticle", under: "item" },
        });
        const unused = vars.groups.find((g) => g.collapsed)!;
        expect(unused.label).toBe("Fields Journal Article does not have");
        expect(unused.variables.map((v) => v.name)).toContain("caseName");
        expect(unused.variables.map((v) => v.name)).not.toContain("publicationTitle");
        // `date: null` filled for every type is not a ZotFlow variable.
        const zotflow = vars.groups.find((g) => g.label === "ZotFlow variables")!;
        expect(zotflow.variables).toEqual([]);
    });

    test("item variables at the root (note paths) say the item. prefix works too", () => {
        const vars = describeTemplateScope({
            scope: { title: "A", libraryName: "Lib" },
            engine,
            item: { type: "journalArticle" },
        });
        expect(find(vars, "title")).toMatchObject({ kind: "field" });
        expect(find(vars, "libraryName")).toMatchObject({ kind: "zotflow" });
        expect(vars.groups[0]!.note).toMatch(/item\. prefix/);
    });

    test("other root variables are listed after the item", () => {
        const vars = describeTemplateScope({
            scope: { item: { title: "A" }, notePath: "Source/A.md" },
            engine,
            item: { type: "journalArticle", under: "item" },
        });
        expect(vars.groups.at(-1)).toMatchObject({ label: "Other variables" });
        expect(find(vars, "notePath")).toMatchObject({ value: "Source/A.md" });
    });

    test("credentials and internal keys are never listed", () => {
        const vars = describeTemplateScope({
            scope: {
                settings: { zoteroapikey: "SECRET", webdavpassword: "SECRET", sourceNoteFolder: "S" },
                __zfReadOnlyKeys: new Set(),
            },
            engine,
        });
        expect(JSON.stringify(vars)).not.toContain("SECRET");
        expect(JSON.stringify(vars)).not.toContain("__zf");
        expect(find(vars, "settings.sourceNoteFolder")).toBeDefined();
    });

    test("keys Liquid cannot read with a dot get bracket paths", () => {
        const vars = describeTemplateScope({
            scope: { csl: { "container-title": "J" } },
            engine,
        });
        expect(find(vars, 'csl["container-title"]')).toMatchObject({ value: "J" });
    });

    test("long and multi-line values are previewed on one line", () => {
        const vars = describeTemplateScope({
            scope: { a: "x\ny", b: "z".repeat(500) },
            engine,
        });
        expect(find(vars, "a")!.value).toBe("x ↵ y");
        expect(find(vars, "b")!.value.length).toBeLessThan(310);
    });

    test("nesting stops at a fixed depth", () => {
        const deep = { a: { b: { c: { d: { e: 1 } } } } };
        const vars = describeTemplateScope({ scope: deep, engine });
        expect(find(vars, "a.b.c")).toBeDefined();
        expect(find(vars, "a.b.c.d")).toMatchObject({ type: "object" });
        expect(find(vars, "a.b.c.d")!.children).toBeUndefined();
    });

    test("ZotFlow's filters are listed without Liquid's built-ins", () => {
        const e = new Liquid();
        e.registerFilter("html2md", (x: string) => x);
        expect(describeTemplateScope({ scope: {}, engine: e }).filters).toEqual(["html2md"]);
    });
});
