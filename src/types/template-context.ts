import type { AnnotationJSON } from "./zotero-reader";

/** Utility functions available inside LiquidJS templates. */
export interface TemplateUtils {
    formatCreators: (creators: string[]) => string;
    formatDate: (date: string, format?: string) => string;
}

/** Template rendering context for a top-level Zotero item. */
export interface ItemTemplateContext {
    // Identity
    key: string;
    version: number;
    citationKey: string;
    libraryID: number;
    itemType: string;
    itemPaths: string[];

    // Metadata
    title: string;
    creators: Array<{
        creatorType?: string;
        firstName?: string;
        lastName?: string;
        name?: string;
    }>;
    date: string | null;
    dateAdded: string;
    dateModified: string;

    accessDate?: string;
    abstractNote?: string;
    publicationTitle?: string;
    publisher?: string;
    place?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    series?: string;
    seriesNumber?: string;
    edition?: string;

    url?: string;
    DOI?: string;
    ISBN?: string;
    ISSN?: string;

    tags: Array<{ tag: string; type?: number }>;

    // Children
    attachments: AttachmentTemplateContext[];
    annotations: AnnotationTemplateContext[];
    attachmentAnnotations: AnnotationTemplateContext[];
    notes: NoteTemplateContext[];

    // Cross-references (Zotero "Related" tab — dc:relation)
    relatedItems: RelatedItemTemplateContext[];
}

/** Template rendering context for a Zotero "related" item (dc:relation). */
export interface RelatedItemTemplateContext {
    /** Item key (always present — parsed from the URI even if unresolved). */
    key: string;
    /** Library ID (always present — parsed from the URI). */
    libraryID: number;
    /** True when the related item was found in the local DB. */
    resolved: boolean;
    /** Title of the related item. Undefined when unresolved. */
    title?: string;
    /** Zotero item type. Undefined when unresolved. */
    itemType?: string;
    /** Citation key (e.g. Better BibTeX). Empty string or undefined when unresolved. */
    citationKey?: string;
    /** Vault path of that item's ZotFlow source note. Undefined when unresolved. */
    notePath?: string;
}

/** Template rendering context for a Zotero attachment. */
export interface AttachmentTemplateContext {
    key: string;
    libraryID: number;
    title?: string;
    accessDate?: string;
    url?: string;
    contentType?: string;
    filename?: string;

    tags: Array<{ tag: string; type?: number }>;
    dateAdded: string;
    dateModified: string;

    annotations: AnnotationTemplateContext[];
}

/** Template rendering context for a Zotero note child item. */
export interface NoteTemplateContext {
    key: string;
    libraryID: number;
    note: string;
    title: string;
    tags: Array<{ tag: string; type?: number }>;
    dateAdded: string;
    dateModified: string;
}

/** Template rendering context for a single Zotero annotation. */
export interface AnnotationTemplateContext {
    key: string;
    libraryID: number;
    type: string;
    authorName?: string;
    text?: string | null;
    comment?: string;
    color?: string;
    pageLabel?: string;
    tags: Array<{ tag: string; type?: number }>;
    dateAdded: string;
    dateModified: string;
    /** True for external annotations extracted from the embedded PDF. */
    isExternal: boolean;
    /** True when the annotation is read-only (external, or not authored by the user). */
    readOnly: boolean;
    raw: AnnotationJSON;
}
