/**
 * Result of a template preview in the Activity Center's template tester.
 * Previews never throw for a template problem: a broken template is an
 * answer (`ok: false`), not a failure of the call. A missing item or file
 * still throws.
 */

/** Where a template failed. */
export type TemplateErrorPhase =
    /** Liquid syntax: an unclosed tag, an unknown filter or tag. */
    | "parse"
    /** Liquid evaluation: a filter that threw, a bad argument. */
    | "render"
    /** The rendered frontmatter is not valid YAML key/value pairs. */
    | "frontmatter";

export interface TemplateError {
    phase: TemplateErrorPhase;
    /** The error without Liquid's position suffix. */
    message: string;
    /** 1-based, in the whole template as typed (frontmatter included). */
    line?: number;
    /** 1-based. */
    col?: number;
    /** For `frontmatter`: the YAML the template rendered, which failed to parse. */
    renderedFrontmatter?: string;
}

export type TemplatePreviewResult =
    | {
          ok: true;
          output: string;
          /** Source notes: the frontmatter as written to the note. */
          frontmatter?: Record<string, unknown>;
          /**
           * Things the output alone does not tell: a rule that kept the
           * template from applying, a fallback that was used instead, a value
           * the plugin changed or overrode.
           */
          hints: string[];
      }
    | { ok: false; error: TemplateError; hints: string[] };

/**
 * Where an item variable's value comes from, for an item of a given type.
 * The template context itself stays flat (`item.title`, `item.caseName`);
 * this is only the tester's explanation of it.
 */
export type TemplateVariableKind =
    /** One of the item type's own Zotero fields. */
    | "field"
    /** A type-specific field that stands in for a base field (a case's `caseName`). */
    | "type-specific"
    /** A base field name filled from the type-specific field (a case's `title`). */
    | "base-mapped"
    /** Added by ZotFlow: identity, children, derived values (`year`, `creatorSummary`). */
    | "zotflow";

export interface TemplateVariable {
    /** As written in the template, e.g. `item.title` or `item.notes[0].note`. */
    path: string;
    /** The last segment, for display. */
    name: string;
    type: "string" | "number" | "boolean" | "array" | "object" | "null";
    /** A one-line preview of the value; empty for objects and arrays. */
    value: string;
    kind?: TemplateVariableKind;
    /** For `base-mapped`: the field the value comes from. */
    mappedFrom?: string;
    /** For arrays: the number of elements. */
    count?: number;
    /** Arrays: the first element's variables. Objects: their variables. */
    children?: TemplateVariable[];
}

export interface TemplateVariableGroup {
    label: string;
    /** A short explanation shown under the label. */
    note?: string;
    variables: TemplateVariable[];
    /** Shown folded: reference material rather than values to use. */
    collapsed?: boolean;
}

/** The variables a template sees for one item or file, for the tester. */
export interface TemplateVariables {
    groups: TemplateVariableGroup[];
    /** ZotFlow's own filters available in this context (Liquid's built-ins come on top). */
    filters: string[];
}
