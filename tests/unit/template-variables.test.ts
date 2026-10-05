/**
 * The template tester's variable list: the scope a template renders with,
 * listed as it is.
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
    return walk(vars.variables);
}

describe("describeTemplateScope", () => {
    test("lists the scope as it is, in its own order", () => {
        const vars = describeTemplateScope(
            { item: { caseName: "Roe v. Wade", title: "Roe v. Wade", year: "1973" }, notePath: "N.md" },
            engine,
        );
        expect(vars.variables.map((v) => v.path)).toEqual(["item", "notePath"]);
        expect(find(vars, "item")!.children!.map((v) => v.name)).toEqual(["caseName", "title", "year"]);
        expect(find(vars, "item.title")).toEqual({
            path: "item.title",
            name: "title",
            type: "string",
            value: "Roe v. Wade",
        });
    });

    test("arrays give their length and their first element", () => {
        const vars = describeTemplateScope(
            { item: { creators: [{ name: "Burger" }, { name: "Blackmun" }], tags: [] } },
            engine,
        );
        expect(find(vars, "item.creators")).toMatchObject({ type: "array", count: 2 });
        expect(find(vars, "item.creators[0].name")).toMatchObject({ value: "Burger" });
        expect(find(vars, "item.tags")).toMatchObject({ count: 0 });
        expect(find(vars, "item.tags")!.children!.map((v) => v.path)).toEqual([
            "item.tags[0].tag",
            "item.tags[0].type",
        ]);
    });

    test("null, undefined and empty strings stay apart", () => {
        const vars = describeTemplateScope(
            { item: { date: null, ISBN: undefined, citationKey: "" } },
            engine,
        );
        expect(find(vars, "item.date")).toMatchObject({ type: "null", value: "" });
        expect(find(vars, "item.ISBN")).toMatchObject({ type: "undefined", value: "" });
        expect(find(vars, "item.citationKey")).toMatchObject({ type: "string", value: "" });
    });

    test("credentials and internal keys are never listed", () => {
        const vars = describeTemplateScope(
            {
                settings: { zoteroapikey: "SECRET", webdavpassword: "SECRET", sourceNoteFolder: "S" },
                __zfReadOnlyKeys: new Set(),
            },
            engine,
        );
        expect(JSON.stringify(vars)).not.toContain("SECRET");
        expect(JSON.stringify(vars)).not.toContain("__zf");
        expect(find(vars, "settings.sourceNoteFolder")).toBeDefined();
    });

    test("keys Liquid cannot read with a dot get bracket paths", () => {
        const vars = describeTemplateScope({ csl: { "container-title": "J" } }, engine);
        expect(find(vars, 'csl["container-title"]')).toMatchObject({ value: "J" });
    });

    test("long and multi-line values are previewed on one line", () => {
        const vars = describeTemplateScope({ a: "x\ny", b: "z".repeat(500) }, engine);
        expect(find(vars, "a")!.value).toBe("x ↵ y");
        expect(find(vars, "b")!.value.length).toBeLessThan(310);
    });

    test("nesting stops at a fixed depth", () => {
        const vars = describeTemplateScope({ a: { b: { c: { d: { e: 1 } } } } }, engine);
        expect(find(vars, "a.b.c.d")).toMatchObject({ type: "object" });
        expect(find(vars, "a.b.c.d")!.children).toBeUndefined();
    });

    test("an empty array shows its element structure, empty", () => {
        const vars = describeTemplateScope({ item: { attachments: [], itemPaths: [] } }, engine);
        expect(find(vars, "item.attachments")).toMatchObject({ type: "array", count: 0 });
        expect(find(vars, "item.attachments[0].filename")).toEqual({
            path: "item.attachments[0].filename",
            name: "filename",
            type: "undefined",
            value: "",
        });
        expect(find(vars, "item.attachments[0].annotations[0].pageLabel")).toMatchObject({ type: "undefined" });
        expect(find(vars, "item.itemPaths[0]")).toMatchObject({ type: "undefined" });
    });

    test("a citation's annotations show their structure with none picked", () => {
        const vars = describeTemplateScope({ annotations: [] }, engine);
        expect(find(vars, "annotations[0].text")).toBeDefined();
        expect(find(vars, "annotations[0].raw")).toMatchObject({ type: "undefined" });
    });

    test("an element missing an optional key lists it empty after its own keys", () => {
        const vars = describeTemplateScope(
            { item: { relatedItems: [{ key: "K", libraryID: 1, resolved: false }] } },
            engine,
        );
        const names = find(vars, "item.relatedItems")!.children!.map((v) => v.name);
        expect(names).toEqual(["key", "libraryID", "resolved", "title", "itemType", "citationKey", "notePath"]);
        expect(find(vars, "item.relatedItems[0].title")).toMatchObject({ type: "undefined", value: "" });
    });

    test("an array the context does not define stays without structure", () => {
        const vars = describeTemplateScope({ settings: { librariesConfig: [] } }, engine);
        expect(find(vars, "settings.librariesConfig")!.children).toBeUndefined();
    });

    test("the structure stops at the same depth as values", () => {
        const vars = describeTemplateScope({ item: { attachments: [] } }, engine);
        expect(find(vars, "item.attachments[0].annotations[0].tags")).toMatchObject({ type: "undefined" });
        expect(find(vars, "item.attachments[0].annotations[0].tags")!.children).toBeUndefined();
    });

    test("ZotFlow's filters are listed without Liquid's built-ins", () => {
        const e = new Liquid();
        e.registerFilter("html2md", (x: string) => x);
        expect(describeTemplateScope({}, e).filters).toEqual(["html2md"]);
    });
});
