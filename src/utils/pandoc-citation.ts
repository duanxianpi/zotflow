import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import type { PandocCitation, PandocCite } from "types/pandoc-citation";

// Pandoc keys may contain internal punctuation, but cannot end in it.
const KEY = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&+?<>~/-]*[\p{L}\p{N}_])?`;
const CITE = new RegExp(
    String.raw`^(?:(.*?)\s+)?(-?)@(${KEY})(?![\p{L}\p{N}_])([\s\S]*)$`,
    "u",
);
const parser = unified().use(remarkParse).use(remarkMath);

/** Conservative bracketed Pandoc citations; unsupported syntax stays editable. */
export function parsePandocCitation(raw: string): PandocCite[] | null {
    if (!raw.startsWith("[") || !raw.endsWith("]")) return null;
    const cites: PandocCite[] = [];
    for (const part of raw.slice(1, -1).split(";")) {
        const m = CITE.exec(part.trim());
        if (!m || !m[3] || /[@[\]\\]/.test((m[1] ?? "") + m[4]!)) return null;
        const cite: PandocCite = { citekey: m[3] };
        if (m[2]) cite.suppressAuthor = true;
        if (m[1]?.trim()) cite.prefix = m[1].trim() + " ";
        const tail = m[4]!.trim();
        const locator =
            /^,?\s*(p{1,2}\.|pages?|chap(?:ter)?\.?|sec(?:tion)?\.?)\s+((?:\d+[a-z]?|[ivxlcdm]+)(?:\s*[-–,]\s*(?:\d+[a-z]?|[ivxlcdm]+))*)(.*)$/iu.exec(
                tail,
            );
        if (locator) {
            cite.label = /^p/i.test(locator[1]!)
                ? "page"
                : /^ch/i.test(locator[1]!)
                  ? "chapter"
                  : "section";
            cite.locator = locator[2];
            if (locator[3]?.trim()) cite.suffix = locator[3].trim();
        } else if (tail) {
            // A bare numeric locator is also accepted by Pandoc.
            const page = /^,\s*(\d+(?:[-–]\d+)?)$/.exec(tail);
            if (page) {
                cite.label = "page";
                cite.locator = page[1];
            } else cite.suffix = tail;
        }
        cites.push(cite);
    }
    return cites.length ? cites : null;
}

/** Match source offsets only in Markdown prose, never code, links, math or YAML. */
export function findPandocCitations(
    source: string,
    includeLiterals = false,
): PandocCitation[] {
    const result: PandocCitation[] = [];
    // Mask rather than remove non-prose so source offsets remain exact.
    const masked = source
        .replace(
            /^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/,
            (s) => s.replace(/[^\r\n]/g, " "),
        )
        .replace(/%%[\s\S]*?%%/g, (s) => s.replace(/[^\r\n]/g, " "))
        .replace(/<([a-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (s) =>
            s.replace(/[^\r\n]/g, " "),
        );
    type MarkdownNode = {
        type: string;
        position?: { start: { offset?: number }; end: { offset?: number } };
        children?: MarkdownNode[];
    };
    const visit = (node: MarkdownNode): void => {
        if (
            ["link", "linkReference", "image", "imageReference"].includes(
                node.type,
            )
        )
            return;
        if (node.type !== "text") {
            for (const child of node.children ?? []) visit(child);
            return;
        }
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const text = masked.slice(start, end);
        for (const m of text.matchAll(
            /\[[^[\]\r\n]*@[^ [\]\r\n][^[\]\r\n]*\]/g,
        )) {
            const from = start + m.index;
            // Escaped brackets and Obsidian wikilinks/embeds are not citations.
            const backslashes =
                /\\+$/.exec(source.slice(0, from))?.[0].length ?? 0;
            const literal = backslashes % 2 === 1;
            if (
                (literal && !includeLiterals) ||
                /^[[!]$/.test(source[from - 1] ?? "") ||
                source[from + m[0].length] === "]"
            )
                continue;
            const cites = parsePandocCitation(m[0]);
            if (cites)
                result.push({
                    from,
                    to: from + m[0].length,
                    raw: m[0],
                    cites,
                    ...(literal ? { literal: true } : {}),
                });
        }
    };
    visit(parser.parse(masked));
    return result;
}
