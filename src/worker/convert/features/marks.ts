/**
 * Inline marks — underline, sub/superscript, strikethrough.
 *
 * `~~strike~~` has GFM syntax; the other three do not and survive as inline
 * HTML tags, which CommonMark passes through and Obsidian renders.
 */

import { visit } from "unist-util-visit";

import { styleStr } from "./element";
import { PASS, stringifyAs } from "./types";

import type { Root as HRoot } from "hast";
import type {
    Delete,
    Parents,
    PhrasingContent,
    Root as MRoot,
} from "mdast";
import type { InlineHtmlMark } from "../model/nodes";
import type { SyntaxFeature } from "./types";

type InlineHtmlTag = InlineHtmlMark["type"];

/**
 * Serialize a phrasing container as an inline HTML tag.
 *
 * The node keeps real `children`, so nested marks survive: `<u>a
 * <strong>b</strong></u>` becomes `<u>a **b**</u>` rather than flattening to
 * the bare text `<u>a b</u>`. CommonMark treats the tag as raw inline HTML
 * and keeps parsing markdown around it, so Obsidian renders the nested
 * emphasis and the next `html2md` sees the original structure again.
 */
function inlineHtmlMark(tag: InlineHtmlTag) {
    return stringifyAs<InlineHtmlMark>((node, _parent, state, info) => {
        const open = `<${tag}>`;
        const close = `</${tag}>`;
        const inner = state.containerPhrasing(node, {
            ...info,
            before: open,
            after: close,
        });
        return open + inner + close;
    });
}

export const marksFeature: SyntaxFeature = {
    name: "marks",

    hastHandlers: () => ({
        // Zotero's strike mark is a styled span, not <del>.
        span: (state, node) => {
            if (!styleStr(node).includes("text-decoration: line-through")) {
                return PASS;
            }
            const del: Delete = {
                type: "delete",
                children: state.all(node) as PhrasingContent[],
            };
            return del;
        },

        // <u>/<sub>/<sup> → phrasing containers of the same name.
        u: (state, node) => markNode("u", state.all(node)),
        sub: (state, node) => markNode("sub", state.all(node)),
        sup: (state, node) => markNode("sup", state.all(node)),
    }),

    stringifyHandlers: () => ({
        u: inlineHtmlMark("u"),
        sub: inlineHtmlMark("sub"),
        sup: inlineHtmlMark("sup"),
    }),

    transformMdastIn(tree: MRoot) {
        hoistMarkWhitespace(tree);
    },

    /**
     * GFM `~~strike~~` becomes `<del>`, but Zotero's schema expresses strike
     * as a styled span. Rewrite on the way out.
     */
    transformHast(tree: HRoot) {
        visit(tree, "element", (node) => {
            if (node.tagName !== "del") return;
            node.tagName = "span";
            node.properties.style = "text-decoration: line-through";
        });
    },
};

/** Marks whose Markdown delimiters cannot sit next to whitespace. */
const DELIMITED_MARKS = new Set(["strong", "emphasis", "delete"]);

/**
 * Move whitespace at the edges of `**`/`*`/`~~` marks to just outside them.
 *
 * Zotero lets a mark swallow a boundary space (`<strong>Title </strong>Body`),
 * but CommonMark does not recognise `**Title **Body` as emphasis. Left as is,
 * `mdast-util-to-markdown` keeps the mark valid by character-referencing the
 * space and the next character (`**Title&#x20;**&#x42;ody`), which Obsidian's
 * editor shows verbatim. Hoisting the whitespace gives `**Title** Body`.
 *
 * Children are processed first, so whitespace bubbles up through nested marks
 * (`<strong><em>a </em></strong>`). A mark left empty is dropped.
 */
function hoistMarkWhitespace(parent: Parents): void {
    const kids = parent.children as PhrasingContent[];
    for (let i = 0; i < kids.length; i++) {
        const node = kids[i]!;
        if ("children" in node) hoistMarkWhitespace(node);
        if (!DELIMITED_MARKS.has(node.type) || !("children" in node)) continue;

        const inner = node.children;
        const first = inner[0];
        let before = "";
        let after = "";

        if (first?.type === "text") {
            const lead = /^\s+/.exec(first.value)?.[0] ?? "";
            before = lead;
            first.value = first.value.slice(lead.length);
            if (!first.value) inner.shift();
        }
        const tail = inner[inner.length - 1];
        if (tail?.type === "text") {
            const trail = /\s+$/.exec(tail.value)?.[0] ?? "";
            after = trail;
            tail.value = tail.value.slice(0, tail.value.length - trail.length);
            if (!tail.value) inner.pop();
        }

        const out: PhrasingContent[] = [];
        if (before) out.push({ type: "text", value: before });
        if (inner.length > 0) out.push(node);
        if (after) out.push({ type: "text", value: after });
        kids.splice(i, 1, ...out);
        i += out.length - 1;
    }
}

function markNode(tag: InlineHtmlTag, children: unknown): InlineHtmlMark {
    return { type: tag, children: children as PhrasingContent[] };
}
