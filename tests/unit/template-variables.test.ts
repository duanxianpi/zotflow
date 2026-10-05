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
        expect(find(vars, "item.tags")!.children).toBeUndefined();
    });

    test("null values are listed empty", () => {
        const vars = describeTemplateScope({ item: { date: null } }, engine);
        expect(find(vars, "item.date")).toMatchObject({ type: "null", value: "" });
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

    test("ZotFlow's filters are listed without Liquid's built-ins", () => {
        const e = new Liquid();
        e.registerFilter("html2md", (x: string) => x);
        expect(describeTemplateScope({}, e).filters).toEqual(["html2md"]);
    });
});
