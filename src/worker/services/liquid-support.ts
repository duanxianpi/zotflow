import { Liquid, LiquidError } from "liquidjs";

import type { Liquid as LiquidEngine, LiquidOptions } from "liquidjs";
import type { IParentProxy } from "bridge/types";
import type {
    TemplateError,
    TemplatePreviewResult,
} from "types/template-preview";

/**
 * Per-render values the template services stash on the Liquid environment for
 * their filters to read back. Both are optional because the citation and
 * preview render paths do not populate them.
 */
export interface ZfEnvironments {
    __zfZoteroLibPrefix?: string;
    __zfReadOnlyKeys?: Set<string>;
}

/**
 * LiquidJS's filter `this`, kept deliberately wide. Its own `FilterImpl` is
 * not exported from the package root, and `this` is contravariant — declaring
 * `environments` as `ZfEnvironments` here makes the handler unassignable to
 * `FilterHandler`, whose `environments` is the engine's broad `Scope`.
 */
export interface LiquidFilterScope {
    context?: { environments?: unknown };
}

/** Reads this render's stashed values off the filter scope. */
export function zfEnv(scope: LiquidFilterScope): ZfEnvironments {
    return scope?.context?.environments ?? {};
}

/** `Liquid.parseAndRender` is typed `any`; every template here renders text. */
export async function renderLiquid(
    engine: LiquidEngine,
    template: string,
    scope: object,
): Promise<string> {
    return (await engine.parseAndRender(template, scope)) as string;
}

/**
 * A copy of `engine` for previews that rejects unknown filters
 * (`strictFilters`): a real render passes `{{ x | typo }}` through unchanged,
 * a preview reports it. Call it once `engine`'s own filters are registered;
 * the copy shares them.
 */
export function strictFilterEngine(
    engine: LiquidEngine,
    options: LiquidOptions,
): LiquidEngine {
    const strict = new Liquid({ ...options, strictFilters: true });
    for (const [name, impl] of Object.entries(engine.filters)) {
        strict.registerFilter(name, impl);
    }
    return strict;
}

/** A template problem, positioned in the template the user typed. */
export class TemplatePreviewError extends Error {
    constructor(readonly info: TemplateError) {
        super(info.message);
        this.name = "TemplatePreviewError";
    }
}

/** Liquid appends `, file:…, line:…, col:…` to its messages; the position is reported apart. */
const LIQUID_POSITION_SUFFIX = /(?:, file:.*?)?, line:\d+, col:\d+$/;

/**
 * Describe a Liquid error for the user. `firstLine` is the line, in the whole
 * template, where the rendered fragment starts: a source note renders its
 * frontmatter and body separately, and Liquid counts from each fragment.
 * `firstCol` is the column the fragment starts at on that line.
 */
export function liquidErrorInfo(
    e: unknown,
    firstLine = 1,
    firstCol = 1,
): TemplateError {
    if (!LiquidError.is(e)) {
        return {
            phase: "render",
            message: e instanceof Error ? e.message : String(e),
        };
    }
    const phase =
        e.name === "ParseError" || e.name === "TokenizationError"
            ? "parse"
            : "render";
    const [line = 1, col = 1] = e.token.getPosition();
    return {
        phase,
        message: e.message.replace(LIQUID_POSITION_SUFFIX, ""),
        line: line + firstLine - 1,
        col: line === 1 ? col + firstCol - 1 : col,
    };
}

/** Render one fragment of a template, positioning any Liquid error in the whole template. */
export async function renderFragment(
    engine: LiquidEngine,
    source: string,
    scope: object,
    firstLine = 1,
    firstCol = 1,
): Promise<string> {
    try {
        return await renderLiquid(engine, source, scope);
    } catch (e) {
        throw new TemplatePreviewError(liquidErrorInfo(e, firstLine, firstCol));
    }
}

/**
 * Where `template.trim()` starts in `template`, for settings that are trimmed
 * before rendering: an error in the trimmed text is reported where the user
 * sees it.
 */
export function trimmedStart(template: string): {
    source: string;
    firstLine: number;
    firstCol: number;
} {
    const leading = template.slice(0, template.length - template.trimStart().length);
    const lines = leading.split("\n");
    return {
        source: template.trim(),
        firstLine: lines.length,
        firstCol: (lines[lines.length - 1] ?? "").length + 1,
    };
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A source-note template split into its frontmatter (rendered, then parsed
 * as YAML) and its body. The frontmatter's first line is line 2 of the
 * template; `bodyLine` is where the body starts.
 */
export function splitFrontmatter(template: string): {
    frontmatter: string;
    body: string;
    bodyLine: number;
} {
    const match = FRONTMATTER_RE.exec(template);
    if (!match) return { frontmatter: "", body: template, bodyLine: 1 };
    return {
        frontmatter: match[1] || "",
        body: template.substring(match[0].length),
        bodyLine: match[0].split("\n").length,
    };
}

/** Line 2: the line after the opening `---`. */
export const FRONTMATTER_FIRST_LINE = 2;

/**
 * Run a preview. Template problems become `ok: false`; anything else (a
 * missing item, a failed read) still throws.
 */
export async function previewResult(
    run: (hints: string[]) => Promise<{
        output: string;
        frontmatter?: Record<string, unknown>;
    }>,
): Promise<TemplatePreviewResult> {
    const hints: string[] = [];
    try {
        const { output, frontmatter } = await run(hints);
        return frontmatter
            ? { ok: true, output, frontmatter, hints }
            : { ok: true, output, hints };
    } catch (e) {
        if (e instanceof TemplatePreviewError) {
            return { ok: false, error: e.info, hints };
        }
        if (LiquidError.is(e)) {
            return { ok: false, error: liquidErrorInfo(e), hints };
        }
        throw e;
    }
}

/**
 * Render a source-note template's frontmatter and parse it as YAML.
 *
 * A real render (`strict` off) never fails over the frontmatter: the problem
 * is logged and the note gets no template frontmatter. A preview (`strict`)
 * reports it, positioned in the template where Liquid can tell.
 */
export async function renderTemplateFrontmatter(opts: {
    engine: LiquidEngine;
    source: string;
    scope: object;
    parentHost: IParentProxy;
    strict: boolean;
    logContext: string;
}): Promise<Record<string, unknown>> {
    const { engine, source, scope, parentHost, strict, logContext } = opts;
    if (!source.trim()) return {};

    try {
        const rendered = await renderFragment(
            engine,
            source,
            scope,
            FRONTMATTER_FIRST_LINE,
        );
        let parsed: unknown;
        try {
            parsed = await parentHost.parseYaml(rendered);
        } catch (e) {
            throw new TemplatePreviewError({
                phase: "frontmatter",
                message: e instanceof Error ? e.message : String(e),
                renderedFrontmatter: rendered,
            });
        }
        // An empty frontmatter (every line inside a false `{% if %}`) parses to null.
        if (parsed === null || parsed === undefined) return {};
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new TemplatePreviewError({
                phase: "frontmatter",
                message: "Frontmatter must be a list of key: value pairs",
                renderedFrontmatter: rendered,
            });
        }
        return parsed as Record<string, unknown>;
    } catch (e) {
        if (strict) throw e;
        parentHost.log(
            "error",
            "Failed to parse template frontmatter",
            logContext,
            e,
        );
        return {};
    }
}

/**
 * Preview hint for template frontmatter keys the plugin writes itself: the
 * template's value never reaches the note.
 */
export function mandatoryKeyHint(
    templateFrontmatter: Record<string, unknown>,
    mandatory: Record<string, unknown>,
): string | null {
    const overridden = Object.keys(templateFrontmatter)
        .map((k) => (k.startsWith("??") ? k.slice(2) : k))
        .filter((k) => k in mandatory);
    if (overridden.length === 0) return null;
    const list = overridden.map((k) => `"${k}"`).join(", ");
    return `ZotFlow writes ${list} itself; the template's value is not used.`;
}
