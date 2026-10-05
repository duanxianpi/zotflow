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
