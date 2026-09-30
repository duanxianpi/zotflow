import type { AnnotationJSON } from "./zotero-reader";
import type { ZoteroFieldName } from "./zotero-base-fields";

/** Utility functions available inside LiquidJS templates. */
export interface TemplateUtils {
    formatCreators: (creators: string[]) => string;
    formatDate: (date: string, format?: string) => string;
}

/**
 * Every Zotero item field, keyed by schema name and resolved like Zotero's
 * `getField()` — a book section has both `bookTitle` and `publicationTitle`.
 * Absent when the item has no value.
 */
export type ZoteroFieldValues = Partial<Record<ZoteroFieldName, string>>;

/** A creator as templates see it. */
export interface CreatorTemplateContext {
    /** Role, e.g. `author`, `editor`, `translator`. */
    creatorType?: string;
    firstName?: string;
    lastName?: string;
    /** Single-field name, or `firstName lastName` joined. */
    name: string;
}

/** Bibliographic variables shared by source-note and note-path templates. */
export interface ItemMetadataContext extends Omit<
    ZoteroFieldValues,
    "title" | "citationKey" | "date" | "accessDate"
> {
    title: string;
    citationKey: string;
    date: string | null;
    /** Null rather than absent when the item has none, matching `date`. */
    accessDate: string | null;
    year: string;
    creators: CreatorTemplateContext[];
    /** Zotero's own short creator line, e.g. "Doe and Smith". */
    creatorSummary: string;
}

/** Template rendering context for a top-level Zotero item. */
export interface ItemTemplateContext extends ItemMetadataContext {
    // Identity
    key: string;
    version: number;
    libraryID: number;
    itemType: string;
    itemPaths: string[];
    /** Parent item key (e.g. for standalone attachments/notes). Empty for top-level items. */
    parentItem: string;

    dateAdded: string;
    dateModified: string;

    tags: Array<{ tag: string; type?: number }>;

    /** CSL-JSON payload from the Zotero API (synced with include=csljson). */
    csljson?: Record<string, unknown>;

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
    /** Key of the parent (top-level) item this attachment belongs to. */
    parentItem: string;
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
    /** Key of the parent (top-level) item this note belongs to. */
    parentItem: string;
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
    /** Key of the attachment item this annotation belongs to. */
    parentItem?: string;
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
