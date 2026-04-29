/**
 * Zotero Note HTML → Markdown conversion.
 *
 * Schema-driven: every handler is derived from Zotero's ProseMirror note-editor
 * schema (v10). Unknown elements fall through to `rehype-remark` defaults.
 *
 * Runs entirely in the Web Worker — no DOM dependency.
 */

import { unified } from "unified";
import rehypeRemark from "rehype-remark";
import remarkStringify from "remark-stringify";
import { defaultHandlers as defaultRehype2RemarkHandlers } from "hast-util-to-mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { toHtml } from "hast-util-to-html";
import { toText } from "hast-util-to-text";
import { visitParents } from "unist-util-visit-parents";
import { visit } from "unist-util-visit";
import { h } from "hastscript";

import type { Processor } from "unified";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProcessor = Processor<any, any, any, any, any>;
import type { Root as HRoot } from "hast";
import type { Root as MRoot } from "mdast";
import type { Handle } from "hast-util-to-mdast";

/* ================================================================ */
/*  Helpers                                                         */
/* ================================================================ */

/** In-place overwrite all properties of `target` with those from `source`. */
function replaceNode(target: any, source: any): void {
    target.type = source.type;
    target.tagName = source.tagName;
    target.properties = source.properties;
    target.value = source.value;
    target.children = source.children;
}

/** Read `className` from a hast element as a string array (always safe). */
function classNames(node: any): string[] {
    const raw = node.properties?.className;
    return Array.isArray(raw) ? raw : [];
}

/** Read inline `style` as a string (always safe). */
function styleStr(node: any): string {
    return String(node.properties?.style ?? "");
}

/** Check whether a hast element has a specific attribute (including data-*). */
function hasAttr(node: any, name: string): boolean {
    return node.properties?.[name] != null;
}

/* ================================================================ */
/*  Phase 1 — HTML string → rehype (parse + pre-clean)             */
/* ================================================================ */

/**
 * Parse a Zotero note HTML string into a rehype (hast) tree.
 *
 * Pre-cleaning steps (order matters):
 *  1. Extract + strip the metadata wrapper `<div data-schema-version>`.
 *  2. Normalize `<br>` whitespace.
 *  3. Wrap orphan `<span>`/`<img>` at root in `<p>`.
 *  4. Remove empty `<p>` at root.
 */
interface NoteParseResult {
    tree: HRoot;
    /** Serialized HTML attributes of the wrapper div (for round-trip). */
    wrapperAttrs: string | null;
}

function parseNoteHtml(
    html: string,
    rehypeParser: AnyProcessor,
): NoteParseResult {
    const tree = rehypeParser.parse(html);

    let wrapperAttrs: string | null = null;

    // 1. Unwrap metadata container `<div data-schema-version="...">`.
    //    Preserve data-* attributes (data-citation-items, data-schema-version)
    //    so md2html can reconstruct the wrapper during round-trip.
    for (let i = tree.children.length - 1; i >= 0; i--) {
        const child = tree.children[i] as any;
        if (
            child.type === "element" &&
            child.tagName === "div" &&
            child.properties?.dataSchemaVersion != null
        ) {
            // Serialize attributes via toHtml on a childless clone
            const stub = {
                type: "element" as const,
                tagName: "div",
                properties: child.properties,
                children: [],
            };
            const stubHtml = toHtml(stub as any);
            const openEnd = stubHtml.indexOf(">");
            if (openEnd > 5) {
                // '<div ' is 5 chars
                wrapperAttrs = stubHtml.slice(5, openEnd).trim();
            }

            tree.children.splice(i, 1, ...child.children);
        }
    }

    // 2. Normalize <br>: strip blank text nodes immediately before/after.
    const stripAdjacentBlanks = (brNode: any, parent: any, offset: number) => {
        const idx = parent.children.indexOf(brNode);
        const sibling = parent.children[idx + offset];
        if (sibling?.type === "text" && !sibling.value.replace(/[\r\n]/g, "")) {
            parent.children.splice(idx + offset, 1);
        }
    };
    visitParents(
        tree,
        (n: any) => n.type === "element" && n.tagName === "br",
        (n: any, ancestors) => {
            const parent = ancestors[ancestors.length - 1];
            if (!parent) return;
            stripAdjacentBlanks(n, parent, -1);
            stripAdjacentBlanks(n, parent, 1);
        },
    );

    // 3. Wrap orphan inline elements at root in <p>.
    visitParents(
        tree,
        (n: any) =>
            n.type === "element" &&
            (n.tagName === "span" || n.tagName === "img"),
        (n: any, ancestors) => {
            const parent = ancestors[ancestors.length - 1];
            if (parent !== tree) return;
            const wrapper = h("span");
            replaceNode(wrapper, n);
            replaceNode(n, h("p", [wrapper]));
        },
    );

    // 4. Remove empty <p> at root.
    visitParents(
        tree,
        (n: any) => n.type === "element" && n.tagName === "p",
        (n: any, ancestors) => {
            const parent = ancestors[ancestors.length - 1];
            if (parent !== tree) return;
            if (!n.children.length && !toText(n)) {
                parent.children.splice(parent.children.indexOf(n), 1);
            }
        },
    );

    return { tree, wrapperAttrs };
}

/* ================================================================ */
/*  Phase 2 — rehype → remark  (schema-driven handler registry)    */
/* ================================================================ */
/*                                                                  */
/*  ┌──────────────────────────────────────────────────────────┐    */
/*  │              Zotero Note Schema v10 — Nodes              │    */
/*  ├──────────────────────────────────────────────────────────┤    */
/*  │  BLOCK:  paragraph, heading(1-6), codeBlock,             │    */
/*  │          blockquote, horizontalRule, orderedList,         │    */
/*  │          bulletList, listItem, table*, math_display       │    */
/*  │  INLINE: text, hardBreak, image, citation,               │    */
/*  │          highlight, underline_annotation, math_inline     │    */
/*  ├──────────────────────────────────────────────────────────┤    */
/*  │              Zotero Note Schema v10 — Marks              │    */
/*  ├──────────────────────────────────────────────────────────┤    */
/*  │  strong, em, underline(<u>), strike(<span style>),       │    */
/*  │  subsup(<sub>/<sup>), textColor(<span style="color">),   │    */
/*  │  backgroundColor(<span style="background-color">),       │    */
/*  │  link(<a>), code(<code>)                                 │    */
/*  └──────────────────────────────────────────────────────────┘    */
/*                                                                  */
/*  Strategy per element:                                           */
/*    convertible  → map to standard mdast node                     */
/*    passthrough  → serialize to raw HTML (data-preserving)        */
/*    default      → delegate to rehype-remark built-in handler     */
/*                                                                  */
/* ================================================================ */

/* ---------- custom mdast node stringify handlers ----------------- */

/**
 * These tell remark-stringify how to serialize our custom mdast node
 * types back to markdown text.
 */
const mdastStringifyHandlers: Record<string, (node: any) => string> = {
    /* marks serialized as HTML (no native md syntax) */
    u: (n) => `<u>${n.value}</u>`,
    sub: (n) => `<sub>${n.value}</sub>`,
    sup: (n) => `<sup>${n.value}</sup>`,

    /* math */
    inlineMath: (n) => `$${n.value}$`,
    math: (n) => `$$\n${n.value}\n$$`,

    /* code block: fenced. Auto-bump fence width when the content
     * itself contains a run of backticks, otherwise the inner ``` would
     * close the outer fence (e.g. nested code samples). */
    code: (n) => {
        const value: string = n.value ?? "";
        const runs = value.match(/`+/g) ?? [];
        let longestRun = 0;
        for (const r of runs) {
            if (r.length > longestRun) longestRun = r.length;
        }
        const fence = "`".repeat(Math.max(3, longestRun + 1));
        return `${fence}\n${value}\n${fence}`;
    },
};

/* ---------- rehype → remark handlers (HTML AST → MD AST) --------- */

function buildRehype2RemarkHandlers(
    options?: Html2MdOptions,
): Record<string, Handle> {
    const handlers: Record<string, Handle> = {};

    /* ---- Block Nodes -------------------------------------------- */

    // <pre class="math">$$...$$</pre>  →  math block
    // <pre> (no math)                  →  delegate to default (code block)
    handlers.pre = (state, node) => {
        if (classNames(node).includes("math")) {
            const raw = toText(node);
            // Strip surrounding $$ delimiters stored inside the element
            const value =
                raw.startsWith("$$") && raw.endsWith("$$")
                    ? raw.slice(2, -2).trim()
                    : raw;
            return { type: "math", value } as any;
        }
        return defaultRehype2RemarkHandlers.pre(state, node);
    };

    // Tables: detect styled tables and empty <thead>, delegate to default
    // for rendering, then tag headerless tables for post-processing.
    handlers.table = (state, node) => {
        let hasStyle = false;
        let hasHeader = false;

        visitParents(
            node,
            (n: any) =>
                n.type === "element" && ["tr", "td", "th"].includes(n.tagName),
            (n: any) => {
                if (n.properties?.style) hasStyle = true;
                if (!hasHeader && n.tagName === "th") hasHeader = true;
            },
        );

        // Styled tables cannot be represented in markdown — passthrough.
        if (hasStyle) {
            return { type: "html", value: toHtml(node) } as any;
        }

        const tableNode = defaultRehype2RemarkHandlers.table(
            state,
            node,
        ) as any;

        // Mark tables without a real <thead> so remark2md can insert
        // placeholder header cells (`<!-- -->`).
        if (!hasHeader && tableNode) {
            if (!tableNode.data) tableNode.data = {};
            tableNode.data.bnRemove = true;
        }
        return tableNode;
    };

    // <li>: merge inline children to prevent unwanted line breaks
    // when a list item contains mixed text + inline math.
    // (Ported from zotero-better-notes issues #820, #1207, #1300)
    handlers.li = (state, node) => {
        const base = defaultRehype2RemarkHandlers.li(state, node) as any;
        if (!base || base.children.length < 2) return base;

        const blockTypes = ["list", "code", "math", "table"];

        // Only merge when orphaned inline content (inlineMath, html, text)
        // is mixed in with paragraphs. If all children are paragraphs or
        // block nodes, keep them separate (e.g. <dt>/<dd> round-trips).
        const hasOrphanedInline = base.children.some(
            (c: any) =>
                c?.type &&
                c.type !== "paragraph" &&
                !blockTypes.includes(c.type),
        );
        if (!hasOrphanedInline) return base;

        const merged: any[] = [];

        while (base.children.length > 0) {
            const current = base.children.shift();
            let last = merged[merged.length - 1];

            // Ensure a paragraph accumulator exists
            if (last?.type !== "paragraph") {
                last = { type: "paragraph", children: [] };
                merged.push(last);
            }

            if (current?.type === "paragraph") {
                last.children.push(...current.children);
            } else if (current?.type === "inlineMath") {
                // Pad inline math with spaces for readability
                last.children.push({ type: "text", value: " " });
                last.children.push(current);
                last.children.push({ type: "text", value: " " });
            } else if (current?.type && !blockTypes.includes(current.type)) {
                last.children.push(current);
            } else {
                // Block-level child → start a new accumulator after it
                merged.push(current);
            }
        }

        base.children.push(...merged);
        return base;
    };

    /* ---- Inline Nodes — Convertible ----------------------------- */

    // <span>: dispatches based on class/style to the correct mdast type.
    //
    //  class="math"                        → inlineMath
    //  class="citation" data-citation      → passthrough (raw HTML)
    //  class="highlight" data-annotation   → passthrough (raw HTML)
    //  class="underline" data-annotation   → passthrough (raw HTML)
    //  style="text-decoration: line-through" → ~~strikethrough~~
    //  style="background-color: ..."       → passthrough (raw HTML)
    //  style="color: ..."                  → passthrough (raw HTML)
    //  (other)                             → unwrap children
    handlers.span = (state, node) => {
        const cls = classNames(node);
        const style = styleStr(node);

        // — Zotero math_inline: <span class="math">$x$</span>
        if (cls.includes("math")) {
            const raw = toText(node);
            const value =
                raw.startsWith("$") && raw.endsWith("$")
                    ? raw.slice(1, -1)
                    : raw;
            return { type: "inlineMath", value } as any;
        }

        // — Zotero citation: <span class="citation" data-citation="…">
        if (cls.includes("citation")) {
            return { type: "html", value: toHtml(node) } as any;
        }

        // — Zotero highlight: <span class="highlight" data-annotation="…">
        if (cls.includes("highlight")) {
            return { type: "html", value: toHtml(node) } as any;
        }

        // — Zotero underline_annotation: <span class="underline" data-annotation="…">
        if (cls.includes("underline") && hasAttr(node, "dataAnnotation")) {
            return { type: "html", value: toHtml(node) } as any;
        }

        // — Zotero strike mark: <span style="text-decoration: line-through">
        if (style.includes("text-decoration: line-through")) {
            return {
                type: "delete",
                children: state.all(node),
            } as any;
        }

        // — Zotero backgroundColor mark: <span style="background-color: …">
        if (style.includes("background-color")) {
            return { type: "html", value: toHtml(node) } as any;
        }

        // — Zotero textColor mark: <span style="color:">
        if (style.includes("color")) {
            return { type: "html", value: toHtml(node) } as any;
        }

        // — Generic wrapper <span>: unwrap inline children. Returning
        //   `state.all(node)` (an array) splices children into the parent
        //   inline context. Wrapping in a `paragraph` here would force the
        //   surrounding context (e.g. <li>, <td>) into block mode and
        //   break GFM task lists / inline table cells.
        return state.all(node) as any;
    };

    // <img>: images with Zotero annotation data → markdown image with
    //        embedded <img> tag as alt text (preserves all data-* attrs);
    //        plain images → standard markdown image.
    handlers.img = (state, node) => {
        const hasAnnotationData =
            hasAttr(node, "dataAttachmentKey") ||
            hasAttr(node, "dataAnnotation");

        if (hasAnnotationData) {
            const key = node.properties?.dataAttachmentKey as
                | string
                | undefined;
            const folder = options?.annotationImageFolder?.replace(/\/$/, "");

            // When we have both the attachment key and a target folder,
            // produce a markdown image whose alt text carries the full
            // <img> tag (round-trip safe) and whose URL points to the
            // extracted image file.
            if (key && folder) {
                const imgHtml = toHtml(node);
                const width = node.properties?.width as
                    | string
                    | number
                    | undefined;
                const widthSuffix = width ? ` | ${width}` : "";
                return {
                    type: "html",
                    value: `![${imgHtml}${widthSuffix}](${folder}/${key}.png)`,
                } as any;
            }

            // Fallback: raw HTML passthrough when no folder is configured.
            return { type: "html", value: toHtml(node) } as any;
        }

        // Delegate to default handler for standard images
        return defaultRehype2RemarkHandlers.img(state, node);
    };

    /* ---- Inline Nodes — Marks (no native Markdown syntax) ------- */

    // <u> (underline mark) → custom mdast "u" node → `<u>text</u>`
    handlers.u = (_state, node) => {
        return { type: "u", value: toText(node) } as any;
    };

    // <sub> → custom mdast "sub" node → `<sub>text</sub>`
    handlers.sub = (_state, node) => {
        return { type: "sub", value: toText(node) } as any;
    };

    // <sup> → custom mdast "sup" node → `<sup>text</sup>`
    handlers.sup = (_state, node) => {
        return { type: "sup", value: toText(node) } as any;
    };

    // <br> handling depends on the vault's strict-line-breaks setting.
    //
    // strict OFF (default): `<br>` → bare `\n`.  Obsidian renders a single
    //   newline as a visual line break.  Round-trip: `\n` → md2html's
    //   `convertBreaks` re-inserts `{ type: "break" }` → `<br>` in HTML.
    //
    // strict ON: `<br>` → literal `<br>` HTML passthrough.  A bare `\n`
    //   would be a soft break (ignored).  Round-trip: remark keeps raw HTML
    //   as-is → rehype outputs `<br>` → stable.  No accumulation risk
    //   because `convertBreaks` only runs when strict is OFF.
    if (options?.strictLineBreaks) {
        handlers.br = () => {
            return { type: "html", value: "<br>" } as any;
        };
    } else {
        handlers.br = () => {
            return { type: "text", value: "\n" } as any;
        };
    }

    /* ---- Everything else ---------------------------------------- */
    /* <p>, <h1>-<h6>, <blockquote>, <hr>, <ol>, <ul>,             */
    /* <a>, <strong>, <em>, <code>, <br>, <table> sub-elements     */
    /* are all handled by rehype-remark's built-in defaults.        */

    return handlers;
}

/* ================================================================ */
/*  Phase 2.5 — Protect Obsidian-only inline syntax                */
/* ================================================================ */

/**
 * `mdast-util-to-markdown` escapes `[`, `!`, etc. in text nodes to
 * prevent them from being re-parsed as link/image syntax. That escape
 * pass mangles Obsidian-specific syntax that arrives as plain text:
 *
 *   [[Note]]      →  \[\[Note]]
 *   [[A|B]]       →  \[\[A|B]]
 *   [^1]          →  \[^1]
 *
 * To preserve them through the round-trip we walk the mdast tree and
 * split any text node containing such patterns into a sequence of
 * `text` and `html` nodes — `html` nodes are emitted verbatim by the
 * stringifier, bypassing the escape rules.
 *
 * Adjacent newlines are folded into the `html` segment because a
 * trailing `\n` in a text node followed by an html node is normalized
 * to a single space by `mdast-util-to-markdown`'s `safe()` pass.
 *
 * Skipped inside `code`, `inlineCode`, and existing `html` contexts.
 */
const WIKILINK_RE = /(\n?)(\[\[[^\[\]\n]+?]]|\[\^[^\[\]\n]+?])(\n?)/g;

/**
 * Detect task-list markers preserved as plain text by `md2html`.
 *
 * Zotero's note-editor schema strips `<input type="checkbox">`, so we
 * round-trip task lists as literal `[x] ` / `[ ] ` prefixes inside the
 * `<li>`. After `rehype-remark` builds the mdast, walk every `listItem`
 * whose first text child begins with such a marker, lift the state into
 * `listItem.checked`, and strip the prefix from the text. The remarkGfm
 * stringifier then re-emits the canonical `* [x] foo` syntax.
 */
const TASK_PREFIX_RE = /^\[([ xX])\]\s+/;

function detectTaskListItems(tree: MRoot): void {
    visit(tree as any, "listItem", (node: any) => {
        if (typeof node.checked === "boolean") return;
        const firstBlock = node.children?.[0];
        if (!firstBlock) return;
        // First text node may live directly in the listItem (loose list)
        // or inside a wrapping paragraph.
        const container =
            firstBlock.type === "paragraph" ? firstBlock : firstBlock;
        const firstText = container.children?.[0];
        if (!firstText || firstText.type !== "text") return;
        const m = TASK_PREFIX_RE.exec(firstText.value);
        if (!m) return;
        node.checked = m[1]!.toLowerCase() === "x";
        firstText.value = firstText.value.slice(m[0].length);
        // If stripping emptied the text node and there are no more
        // children, drop it so the stringifier doesn't emit a stray
        // empty paragraph.
        if (!firstText.value && container.children.length === 1) {
            container.children.shift();
        }
    });
}

function protectObsidianSyntax(tree: MRoot): void {
    visitParents(
        tree as any,
        (n: any) => n.type === "text",
        (node: any, ancestors: any[]) => {
            for (const a of ancestors) {
                if (
                    a.type === "code" ||
                    a.type === "inlineCode" ||
                    a.type === "html"
                ) {
                    return;
                }
            }

            const value: string = node.value;
            if (!WIKILINK_RE.test(value)) return;
            WIKILINK_RE.lastIndex = 0;

            const parts: any[] = [];
            let last = 0;
            let m: RegExpExecArray | null;
            while ((m = WIKILINK_RE.exec(value)) !== null) {
                const [whole, leadingNl, link, trailingNl] = m;
                if (m.index > last) {
                    parts.push({
                        type: "text",
                        value: value.slice(last, m.index),
                    });
                }
                parts.push({
                    type: "html",
                    value: `${leadingNl}${link}${trailingNl}`,
                });
                last = m.index + whole.length;
            }
            if (last < value.length) {
                parts.push({ type: "text", value: value.slice(last) });
            }

            const parent = ancestors[ancestors.length - 1];
            const idx = parent.children.indexOf(node);
            if (idx >= 0) {
                parent.children.splice(idx, 1, ...parts);
            }
        },
    );
}

/* ================================================================ */
/*  Phase 3 — remark → Markdown string                             */
/* ================================================================ */

function remarkToMarkdown(
    remark: MRoot,
    remarkStringifier: AnyProcessor,
): string {
    const tableHandler = (node: any) => {
        const ext = gfmTableToMarkdown();
        const txt = toMarkdown(node, {
            extensions: [ext, gfmStrikethroughToMarkdown()],
            handlers: mdastStringifyHandlers,
        });

        // Tables without a real header: insert `<!-- -->` placeholders.
        if (node.data?.bnRemove) {
            const lines = txt.split("\n");
            if (lines[0]) {
                lines[0] = lines[0].replace(/(\| +)+/g, (s: string) =>
                    s.replace(/ +/g, " <!-- --> "),
                );
            }
            return lines.join("\n");
        }
        return txt;
    };

    return String(
        remarkStringifier()
            .use(remarkStringify, {
                handlers: {
                    ...mdastStringifyHandlers,
                    table: tableHandler,
                },
            } as any)
            .stringify(remark as any),
    );
}

/* ================================================================ */
/*  Public API                                                      */
/* ================================================================ */

/** Options for HTML → Markdown conversion. */
export interface Html2MdOptions {
    /** Vault-relative folder for annotation images (e.g. "ZotFlow/images"). */
    annotationImageFolder?: string;
    /**
     * Mirror of the vault's "strict line breaks" setting.
     * When `false` (Obsidian default), `<br>` → bare `\n` (Obsidian renders
     * a single newline as a visual line break).
     * When `true`, `<br>` → literal `<br>` HTML passthrough (because a bare
     * `\n` is treated as a soft break and would be lost).
     */
    strictLineBreaks?: boolean;
}

/** Marker prefix for the wrapper-div metadata comment (`<!-- ZF_NOTE_META ... -->`). */
export const NOTE_META_PREFIX = "ZF_NOTE_META";

/**
 * Convert Zotero-format note HTML to Markdown.
 *
 * Pipeline: html → rehype parse → rehype→remark → remark→md string
 *
 * If the input contains a wrapper `<div data-schema-version>`, its
 * attributes are preserved as an HTML comment at the top of the output
 * so that `md2html` can reconstruct the wrapper on the way back.
 *
 * Processors are injected by ConvertService (frozen, reusable).
 */
export async function html2mdWithProcessors(
    html: string,
    rehypeParser: AnyProcessor,
    remarkStringifier: AnyProcessor,
    options?: Html2MdOptions,
): Promise<string> {
    const { tree, wrapperAttrs } = parseNoteHtml(html, rehypeParser);

    const remark = (await unified()
        .use(rehypeRemark, {
            // Preserve hand-written line breaks inside paragraphs so that
            // `<p>123\n[[link]]\n123</p>` round-trips as three lines instead
            // of being collapsed into `123 [[link]] 123` (the HTML default).
            newlines: true,
            handlers: buildRehype2RemarkHandlers(options),
        })
        .run(tree as any)) as MRoot | null;

    if (!remark) return html; // fallback: return raw HTML if conversion fails

    // Lift `[x] ` / `[ ] ` text prefixes (from md2html's task-list
    // sentinels, or hand-written) into proper mdast `listItem.checked`
    // state, so the stringifier emits canonical task-list markdown.
    detectTaskListItems(remark);

    // Protect Obsidian-only inline syntax (e.g. [[wikilinks]]) from
    // mdast-util-to-markdown's text-node escape rules.
    protectObsidianSyntax(remark);

    let md = remarkToMarkdown(remark, remarkStringifier);

    // Prepend an HTML comment with the wrapper div's metadata so md2html
    // can reconstruct the wrapper on the way back. The CM6 meta extension
    // collapses and protects this line in Source Mode.
    if (wrapperAttrs) {
        md = `<!-- ${NOTE_META_PREFIX} ${wrapperAttrs} -->\n` + md;
    }

    return md;
}
