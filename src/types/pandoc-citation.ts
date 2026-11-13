import type { CiteProps } from "worker/csl";

export interface PandocCite extends CiteProps {
    citekey: string;
}

export interface PandocCitation {
    from: number;
    to: number;
    raw: string;
    cites: PandocCite[];
    /** Reading-view alignment only: an escaped opening bracket is literal. */
    literal?: boolean;
}

export interface CitationReference {
    libraryID: number;
    key: string;
    citekey: string;
    bibliography: string;
    /** Native Zotero item target, including the personal/group library path. */
    zoteroUri: string;
    /** CSL formatting, sanitized before inserting into the hover card. */
    bibliographyHtml?: string;
    /** Page label, not a zero-based PDF index. */
    page?: string;
    attachmentKey?: string;
}

export interface RenderedPandocCitation {
    text: string;
    references: CitationReference[];
}
