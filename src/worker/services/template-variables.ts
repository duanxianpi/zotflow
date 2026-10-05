import { Liquid } from "liquidjs";

import type {
    TemplateVariable,
    TemplateVariables,
} from "types/template-preview";
import type {
    AnnotationTemplateContext,
    AttachmentTemplateContext,
    CreatorTemplateContext,
    ItemTemplateContext,
    NoteTemplateContext,
    RelatedItemTemplateContext,
} from "types/template-context";

/** Levels of nesting listed below a root variable (`item.attachments[0].annotations[0].text`). */
const MAX_DEPTH = 3;
const MAX_VALUE_LENGTH = 300;
/** Never listed, whatever a scope carries. */
const HIDDEN_KEYS = new Set(["zoteroapikey", "webdavpassword"]);
const BUILT_IN_FILTERS: ReadonlySet<string> = new Set(
    Object.keys(new Liquid().filters),
);

/**
 * What a key of a template object holds, so that the list can show an
 * array's element structure when no element shows it: an empty array, or
 * an element without an optional key.
 */
type FieldShape = "value" | "object" | { elements: ElementShape | "value" };
type ElementShape = { readonly [key: string]: FieldShape };
/**
 * Exactly the keys of `T`: a context type that gains or loses a key does not
 * compile until its shape follows.
 */
type ShapeOf<T> = { readonly [K in keyof Required<T>]: FieldShape };
/** The keys of `T` that hold arrays. */
type ArrayKeys<T> = {
    [K in keyof T]-?: NonNullable<T[K]> extends readonly unknown[] ? K : never;
}[keyof T];

/** The array keys of each of `T`'s types, together. */
type ArrayKeysOf<T extends readonly unknown[]> = {
    [I in keyof T]: ArrayKeys<T[I]>;
}[number];
/** Every array key of the item, attachment, annotation and note contexts. */
type ContextArrayKeys = ArrayKeysOf<
    [
        ItemTemplateContext,
        AttachmentTemplateContext,
        AnnotationTemplateContext,
        NoteTemplateContext,
    ]
>;

const TAG = { tag: "value", type: "value" } as const satisfies ShapeOf<
    ItemTemplateContext["tags"][number]
>;

const CREATOR = {
    creatorType: "value",
    firstName: "value",
    lastName: "value",
    name: "value",
} as const satisfies ShapeOf<CreatorTemplateContext>;

const ANNOTATION = {
    key: "value",
    libraryID: "value",
    parentItem: "value",
    type: "value",
    authorName: "value",
    text: "value",
    comment: "value",
    color: "value",
    pageLabel: "value",
    tags: { elements: TAG },
    dateAdded: "value",
    dateModified: "value",
    isExternal: "value",
    readOnly: "value",
    raw: "object",
} as const satisfies ShapeOf<AnnotationTemplateContext>;

const ATTACHMENT = {
    key: "value",
    libraryID: "value",
    parentItem: "value",
    title: "value",
    accessDate: "value",
    url: "value",
    contentType: "value",
    filename: "value",
    tags: { elements: TAG },
    dateAdded: "value",
    dateModified: "value",
    annotations: { elements: ANNOTATION },
} as const satisfies ShapeOf<AttachmentTemplateContext>;

const NOTE = {
    key: "value",
    libraryID: "value",
    parentItem: "value",
    note: "value",
    title: "value",
    tags: { elements: TAG },
    dateAdded: "value",
    dateModified: "value",
} as const satisfies ShapeOf<NoteTemplateContext>;

const RELATED_ITEM = {
    key: "value",
    libraryID: "value",
    resolved: "value",
    title: "value",
    itemType: "value",
    citationKey: "value",
    notePath: "value",
} as const satisfies ShapeOf<RelatedItemTemplateContext>;

/**
 * Element structure of the context's arrays, by key. Every array key of the
 * item, attachment, annotation and note contexts has an entry; the citation
 * scope's `annotations` and the local note's `item.annotations` share one.
 */
const ARRAY_ELEMENTS: Readonly<Record<string, ElementShape | "value">> = {
    creators: CREATOR,
    tags: TAG,
    itemPaths: "value",
    attachments: ATTACHMENT,
    annotations: ANNOTATION,
    attachmentAnnotations: ANNOTATION,
    notes: NOTE,
    relatedItems: RELATED_ITEM,
} satisfies Record<ContextArrayKeys, ElementShape | "value">;

/** Variables for a shape with no value behind it: listed empty. */
function describeShape(
    shape: ElementShape,
    prefix: string,
    depth: number,
): TemplateVariable[] {
    return Object.entries(shape).map(([name, field]): TemplateVariable => {
        const path = joinPath(prefix, name);
        if (field === "value") return { path, name, type: "null", value: "" };
        if (field === "object") return { path, name, type: "object", value: "" };
        const variable: TemplateVariable = { path, name, type: "array", value: "", count: 0 };
        const children = elementStructure(field.elements, path, depth);
        if (children) variable.children = children;
        return variable;
    });
}

/** The `[0]` element's variables of an array with no element to show them. */
function elementStructure(
    elements: ElementShape | "value",
    path: string,
    depth: number,
): TemplateVariable[] | undefined {
    if (depth >= MAX_DEPTH) return undefined;
    const first = `${path}[0]`;
    return elements === "value"
        ? [{ path: first, name: "[0]", type: "null", value: "" }]
        : describeShape(elements, first, depth + 1);
}

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
        const elements = ARRAY_ELEMENTS[name];
        if (value.length > 0 && depth < MAX_DEPTH) {
            const first: unknown = value[0];
            if (typeof first === "object" && first !== null && !Array.isArray(first)) {
                const listed = describeObject(first as Record<string, unknown>, `${path}[0]`, depth + 1);
                // Keys this element lacks (an unresolved related item has no
                // title) are listed empty, as for an empty array.
                if (elements && elements !== "value") {
                    const missing = Object.fromEntries(
                        Object.entries(elements).filter(([key]) => !(key in first)),
                    );
                    listed.push(...describeShape(missing, `${path}[0]`, depth + 1));
                }
                variable.children = listed;
            } else {
                variable.children = [describeValue("[0]", `${path}[0]`, first, depth + 1)];
            }
        } else if (value.length === 0 && elements) {
            const children = elementStructure(elements, path, depth);
            if (children) variable.children = children;
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
