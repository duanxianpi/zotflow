import { Liquid } from "liquidjs";

import type {
    TemplateVariable,
    TemplateVariables,
} from "types/template-preview";

/** Levels of nesting listed below a root variable (`item.attachments[0].annotations[0].text`). */
const MAX_DEPTH = 3;
const MAX_VALUE_LENGTH = 300;
/** Never listed, whatever a scope carries. */
const HIDDEN_KEYS = new Set(["zoteroapikey", "webdavpassword"]);
const BUILT_IN_FILTERS: ReadonlySet<string> = new Set(
    Object.keys(new Liquid().filters),
);

/** `prefix.key`, or `prefix["key"]` for keys Liquid cannot read with a dot. */
function joinPath(prefix: string, key: string): string {
    if (/^[A-Za-z_][\w]*$/.test(key)) return prefix ? `${prefix}.${key}` : key;
    return `${prefix}[${JSON.stringify(key)}]`;
}

function preview(value: string): string {
    const line = value.replace(/\r?\n/g, " ↵ ");
    return line.length > MAX_VALUE_LENGTH
        ? `${line.slice(0, MAX_VALUE_LENGTH)}…`
        : line;
}

function isListedKey(key: string, value: unknown): boolean {
    return !key.startsWith("__") && !HIDDEN_KEYS.has(key) && typeof value !== "function";
}

function describeValue(
    name: string,
    path: string,
    value: unknown,
    depth: number,
): TemplateVariable {
    if (value === null || value === undefined) {
        return { path, name, type: "null", value: "" };
    }
    if (typeof value === "string") {
        return { path, name, type: "string", value: preview(value) };
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return {
            path,
            name,
            type: typeof value === "number" ? "number" : "boolean",
            value: String(value),
        };
    }
    if (value instanceof Date) {
        return { path, name, type: "string", value: value.toISOString() };
    }
    if (Array.isArray(value)) {
        const variable: TemplateVariable = {
            path,
            name,
            type: "array",
            value: "",
            count: value.length,
        };
        if (value.length > 0 && depth < MAX_DEPTH) {
            const first: unknown = value[0];
            variable.children =
                typeof first === "object" && first !== null && !Array.isArray(first)
                    ? describeObject(first as Record<string, unknown>, `${path}[0]`, depth + 1)
                    : [describeValue("[0]", `${path}[0]`, first, depth + 1)];
        }
        return variable;
    }
    if (typeof value === "object") {
        const variable: TemplateVariable = { path, name, type: "object", value: "" };
        if (depth < MAX_DEPTH) {
            variable.children = describeObject(
                value as Record<string, unknown>,
                path,
                depth + 1,
            );
        }
        return variable;
    }
    // What is left (a bigint, a symbol) never reaches a template.
    return { path, name, type: "string", value: typeof value === "bigint" ? value.toString() : "" };
}

function describeObject(
    obj: Record<string, unknown>,
    prefix: string,
    depth: number,
): TemplateVariable[] {
    return Object.entries(obj)
        .filter(([key, value]) => isListedKey(key, value))
        .map(([key, value]) =>
            describeValue(key, joinPath(prefix, key), value, depth),
        );
}

/** ZotFlow's filters registered on `engine`, without Liquid's built-ins. */
function zotflowFilters(engine: Liquid): string[] {
    return Object.keys(engine.filters)
        .filter((name) => !BUILT_IN_FILTERS.has(name))
        .sort();
}

/** Describe a template scope, as the template sees it, for the tester's variable list. */
export function describeTemplateScope(
    scope: Record<string, unknown>,
    engine: Liquid,
): TemplateVariables {
    return {
        variables: describeObject(scope, "", 0),
        filters: zotflowFilters(engine),
    };
}
