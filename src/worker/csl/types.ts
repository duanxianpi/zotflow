/**
 * Public core types for csl-render-core.
 *
 * A CSL-JSON item. `id` and `type` are the only required fields; everything
 * else is a standard CSL variable (`title`, `author`, `issued`, ...).
 */
export type CSLItem = { id: string; type: string; [k: string]: unknown };

export type OutputFormat = "text" | "html" | "markdown" | "markdown-pure";

export interface RenderOptions {
	/** Style id (slug like "apa" or a zotero.org/styles URL). Mutually exclusive with styleXml. */
	styleId?: string;
	/** Raw CSL style XML (custom style). Takes precedence over styleId when both are given. */
	styleXml?: string;
	/** BCP-47 locale, e.g. "en-US", "de-DE", "zh-CN". Defaults to the service default ("en-US"). */
	locale?: string;
	/** Output format. Defaults to "text". */
	format?: OutputFormat;
	/**
	 * HTML only: "keep" (default) preserves the csl-bib-body/csl-entry wrappers,
	 * "strip" removes them and flattens csl-left-margin/csl-right-inline into
	 * "[1] entry" for numbered styles.
	 */
	htmlContainer?: "keep" | "strip";
	/** HTML only: mark title, DOI and URL variables for interactive consumers. */
	htmlVariableSpans?: boolean;
}

/** Extra per-cite properties accepted by BibliographyContext.addCitation. */
export interface CiteProps {
	/** Locator value, e.g. a page number. */
	locator?: string;
	/** Locator label, e.g. "page", "chapter". */
	label?: string;
	prefix?: string;
	suffix?: string;
	suppressAuthor?: boolean;
	/** Footnote number for note styles; 0 (default) means in-text. */
	noteIndex?: number;
}

/**
 * Availability of a style is not a boolean: it is whether the whole dependency
 * chain (style -> independent parent -> locale) is closed.
 */
export type Availability =
	| { status: "ready" }
	| { status: "resolvable" }
	| { status: "unresolved-parent"; parent: string }
	| { status: "unresolved-locale"; locale: string }
	| { status: "missing" }
	| { status: "invalid"; reason: string };

export type StyleSource = "builtin" | "remote-cache" | "folder";

/** Provenance of a downloaded resource, kept for display and later updates. */
export interface RemoteMeta {
	/** Exact URL the resource was fetched from. */
	sourceUrl: string;
	/** Epoch ms of the last successful fetch. */
	fetchedAt: number;
}

export interface StyleInfo {
	/** Local key: remote styles use the slug, folder styles the file basename. */
	id: string;
	title?: string;
	source: StyleSource;
	dependent?: boolean;
	/** For dependent styles, the slug of the independent parent. */
	parent?: string;
	/** default-locale declared by the style (or its dependent override), if any. */
	defaultLocale?: string;
	/** citation-format category (numeric/author-date/note/...), own declaration. */
	citationFormat?: string;
	/**
	 * Whether the style declares a <bibliography>. Undefined for dependent
	 * styles (inherited from the parent) and for unparsable styles.
	 */
	hasBibliography?: boolean;
	/**
	 * True when the user installed this style directly; false when it was
	 * pulled in as a dependency (an alias's parent). Ref-counted cleanup on
	 * removal only prunes implicit styles. Remote-cache styles only.
	 */
	explicit?: boolean;
	/** Download provenance (remote-cache styles only). */
	remote?: RemoteMeta;
	availability: Availability;
}

/** Rendered sample output for a style, from the Zotero previews endpoint. */
export interface StyleSample {
	/** Example in-text citations, HTML-encoded. */
	citations: string[];
	/** Example bibliography as HTML (csl-bib-body markup). */
	bibliographyHtml: string;
}

/**
 * Result of fetching a style for preview (before the user confirms adding
 * it). Carries the XML so a subsequent add does not need to refetch.
 */
export interface StylePreview {
	/** Slug the style will be stored under. */
	id: string;
	sourceUrl: string;
	title?: string;
	dependent: boolean;
	/** Slug of the independent parent (dependent styles only). */
	parent?: string;
	defaultLocale?: string;
	/** citation-format category (numeric/author-date/note/...), own declaration. */
	citationFormat?: string;
	/** See StyleInfo.hasBibliography; undefined for dependent styles. */
	hasBibliography?: boolean;
	/** True when a style with this id is already installed locally. */
	alreadyInstalled: boolean;
	xml: string;
	/** Rendered sample output, when the previews endpoint has one. */
	sample?: StyleSample;
}

/** Result of fetching a locale for preview. */
export interface LocalePreview {
	/** Normalized BCP-47 tag, e.g. "de-DE". */
	tag: string;
	sourceUrl: string;
	alreadyInstalled: boolean;
	xml: string;
}

/** Outcome of updating a style through its dependency chain. */
export interface StyleUpdateReport {
	/** Chain members whose content changed. */
	updated: string[];
	/** Chain members refetched but identical to the cached copy. */
	unchanged: string[];
	/** Chain members that could not be refetched (kept as-is). */
	failed: { id: string; reason: string }[];
	/** Availability of the requested style after the update. */
	availability: Availability;
}

/** Parsed metadata extracted from a style's <info> section. */
export interface StyleMeta {
	title?: string;
	/** The style's own declared id URI (info > id), if present. */
	selfUri?: string;
	dependent: boolean;
	/** Slug of the independent parent (dependent styles only). */
	parent?: string;
	/** default-locale attribute on <style>, if any. */
	defaultLocale?: string;
	/** citation-format from info > category, if declared. */
	citationFormat?: string;
	/** Presence of <bibliography>; undefined for dependent styles. */
	hasBibliography?: boolean;
}

/** Aggregate result of updating every downloaded style / locale. */
export interface UpdateAllReport {
	updated: string[];
	unchanged: string[];
	failed: { id: string; reason: string }[];
	/** Epoch ms of this check; persisted and reported by getUpdateStatus(). */
	checkedAt: number;
}
