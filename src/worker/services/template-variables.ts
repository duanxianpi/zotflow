import { Liquid } from "liquidjs";

import {
    BASE_FIELD_MAP,
    ITEM_TYPE_FIELDS,
    ZOTERO_FIELDS,
} from "types/zotero-base-fields";
import { itemTypeLabel } from "types/zotero-item-type-labels";

import type {
    TemplateVariable,
    TemplateVariableGroup,
    TemplateVariableKind,
    TemplateVariables,
} from "types/template-preview";

/** Levels of nesting listed below a root variable (`item.attachments[0].annotations[0].text`). */
const MAX_DEPTH = 3;
const MAX_VALUE_LENGTH = 300;
/** Never listed, whatever a scope carries. */
const HIDDEN_KEYS = new Set(["zoteroapikey", "webdavpassword"]);
const ZOTERO_FIELD_SET: ReadonlySet<string> = new Set(ZOTERO_FIELDS);
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

/**
 * An item's variables in groups: the item type's Zotero fields (base names
 * filled from a type-specific field marked as such), what ZotFlow adds, and
 * the schema fields this type does not have.
 */
function describeItem(
    item: Record<string, unknown>,
    itemType: string,
    prefix: string,
): TemplateVariableGroup[] {
    const typeFields = ITEM_TYPE_FIELDS[itemType] ?? [];
    const baseMap = BASE_FIELD_MAP[itemType] ?? {};
    const baseBySpecific = new Map(
        Object.entries(baseMap).map(([base, specific]) => [specific, base]),
    );
    const listed = new Set<string>();
    const variable = (name: string, kind: TemplateVariableKind) => {
        listed.add(name);
        return {
            ...describeValue(name, joinPath(prefix, name), item[name], 1),
            kind,
        };
    };

    const fields: TemplateVariable[] = [];
    for (const field of typeFields) {
        const base = baseBySpecific.get(field);
        fields.push(variable(field, base ? "type-specific" : "field"));
        if (base) {
            fields.push({ ...variable(base, "base-mapped"), mappedFrom: field });
        }
    }

    const zotflow: TemplateVariable[] = [];
    const unused: TemplateVariable[] = [];
    for (const [key, value] of Object.entries(item)) {
        if (listed.has(key) || !isListedKey(key, value)) continue;
        // A schema field this type does not have, which ZotFlow fills anyway
        // (`date: null`) or which happens to hold something (a note's title).
        if (ZOTERO_FIELD_SET.has(key) && (value === null || value === "")) continue;
        zotflow.push(variable(key, "zotflow"));
    }
    for (const field of ZOTERO_FIELDS) {
        if (!listed.has(field)) {
            unused.push({ path: joinPath(prefix, field), name: field, type: "null", value: "" });
        }
    }

    const label = itemTypeLabel(itemType);
    const groups: TemplateVariableGroup[] = [];
    if (fields.length > 0) {
        groups.push({
            label: `Zotero fields · ${label}`,
            note:
                Object.keys(baseMap).length > 0
                    ? "This item type names some fields its own way; the general name (e.g. title, date) is filled from it too."
                    : undefined,
            variables: fields,
        });
    }
    groups.push({
        label: "ZotFlow variables",
        note: "Identity, related items and values ZotFlow derives.",
        variables: zotflow,
    });
    groups.push({
        label: `Fields ${label} does not have`,
        note: "Always empty for this item type.",
        variables: unused,
        collapsed: true,
    });
    return groups;
}

/** ZotFlow's filters registered on `engine`, without Liquid's built-ins. */
function zotflowFilters(engine: Liquid): string[] {
    return Object.keys(engine.filters)
        .filter((name) => !BUILT_IN_FILTERS.has(name))
        .sort();
}

/**
 * Describe a template scope for the tester's variable list.
 *
 * `item` names the Zotero item's type and where its variables live: under
 * a root key (`under: "item"`, for `item.title`), or, without `under`, at
 * the root itself (note paths, where `item.` also works).
 */
export function describeTemplateScope(opts: {
    scope: Record<string, unknown>;
    engine: Liquid;
    item?: { type: string; under?: string };
}): TemplateVariables {
    const { scope, engine, item } = opts;
    const groups: TemplateVariableGroup[] = [];
    let rest = scope;

    if (item) {
        const under = item.under;
        const atRoot = under === undefined;
        const itemScope = atRoot ? scope : scope[under];
        if (typeof itemScope === "object" && itemScope !== null) {
            groups.push(
                ...describeItem(
                    itemScope as Record<string, unknown>,
                    item.type,
                    under ?? "",
                ),
            );
            if (atRoot) {
                const first = groups[0];
                if (first) {
                    first.note = [first.note, "Every variable also works with the item. prefix."]
                        .filter(Boolean)
                        .join(" ");
                }
                rest = {};
            } else {
                rest = Object.fromEntries(
                    Object.entries(scope).filter(([key]) => key !== under),
                );
            }
        }
    }

    const others = describeObject(rest, "", 0);
    if (others.length > 0) {
        groups.push({
            label: item ? "Other variables" : "Variables",
            variables: others,
        });
    }
    return { groups, filters: zotflowFilters(engine) };
}
