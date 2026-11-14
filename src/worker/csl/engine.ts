import CSL from "citeproc";
import type { CiteprocSys, CitationItem, Engine } from "citeproc";
import type { CiteProps, CSLItem, OutputFormat } from "./types";
import { registerMarkdownFormats } from "./formats/markdown";

/** Everything an engine needs, fully prefetched (sys callbacks are sync). */
export interface ResolvedResources {
	/** XML of the independent style that will actually drive rendering. */
	styleXml: string;
	/** Final normalized locale, already guaranteed loadable via localeLookup. */
	lang: string;
	/** The id/key the caller asked for (error messages, pool key). */
	requestedId: string;
	/** Pool key: identifies (independent style, lang). */
	engineKey: string;
	/** Synchronous locale lookup; must at least resolve en-US. */
	localeLookup: (lang: string) => string | null;
	htmlVariableSpans?: boolean;
}

/**
 * Owns one CSL.Engine plus the mutable item registry its sys object reads
 * from. Engines are expensive to build (XML parse), so hosts are pooled and
 * reset between contexts rather than discarded.
 */
export class EngineHost {
	readonly engine: Engine;
	readonly key: string;
	private items = new Map<string, CSLItem>();
	// citeproc engines start in "html" mode; null forces the first setFormat through.
	private currentFormat: OutputFormat | null = null;

	constructor(resolved: ResolvedResources) {
		registerMarkdownFormats();
		this.key = resolved.engineKey;
		const lookup = resolved.localeLookup;
		const sys: CiteprocSys = {
			retrieveItem: (id: string) => {
				const item = this.items.get(String(id));
				if (!item) {
					throw new Error(`csl-render: item "${id}" was not registered`);
				}
				return item;
			},
			retrieveLocale: (lang: string) => {
				// citeproc may probe several tags; anything unknown falls back
				// to en-US, which is always bundled.
				return lookup(lang) ?? (lookup("en-US") as string);
			},
		};
		if (resolved.htmlVariableSpans) {
			sys.variableWrapper = (params, pre, value, post) => {
				const variables = typeof params === "object" && params !== null &&
					"variableNames" in params && Array.isArray(params.variableNames)
					? params.variableNames : [];
				const variable = ["title", "DOI", "URL"].find((name) => variables.includes(name));
				return variable
					? `${pre}<span data-csl-variable="${variable}">${value}</span>${post}`
					: pre + value + post;
			};
		}
		this.engine = new CSL.Engine(sys, resolved.styleXml, resolved.lang, true);
	}

	setFormat(format: OutputFormat): void {
		if (format !== this.currentFormat) {
			this.engine.setOutputFormat(format);
			this.currentFormat = format;
		}
	}

	/** Replace the whole registry with these items and register them. */
	setItems(items: CSLItem[]): void {
		this.items.clear();
		this.addItems(items);
		this.engine.updateItems(items.map((i) => String(i.id)));
	}

	/** Make items retrievable without registering them as cited. */
	addItems(items: CSLItem[]): void {
		for (const item of items) {
			this.items.set(String(item.id), item);
		}
	}

	registeredIds(): string[] {
		return [...this.items.keys()];
	}

	/** Wipe all per-context state so the host can be reused safely. */
	reset(): void {
		this.items.clear();
		this.engine.restoreProcessorState([]);
		this.engine.updateItems([]);
		this.engine.updateUncitedItems([]);
	}
}

/* ------------------------------------------------------------------ */
/* Output post-processing (§8 of the plan)                             */
/* ------------------------------------------------------------------ */

const HTML_ENTRY_RE = /^\s*<div class="csl-entry">([\s\S]*)<\/div>\s*$/;
const HTML_MARGIN_RE =
	/\s*<div class="csl-left-margin">([\s\S]*?)<\/div>\s*<div class="csl-right-inline">([\s\S]*?)<\/div>\s*/g;
const HTML_BLOCK_RE = /\s*<div class="csl-(?:block|indent)">([\s\S]*?)<\/div>\s*/g;

/** Strip the csl-entry wrapper and flatten display divs into "[1] entry". */
export function stripHtmlEntry(entry: string): string {
	let s = entry;
	const m = s.match(HTML_ENTRY_RE);
	if (m && m[1] !== undefined) s = m[1];
	s = s.replace(HTML_MARGIN_RE, (_all, left: string, right: string) => {
		return `${left.trim()} ${right.trim()}`;
	});
	s = s.replace(HTML_BLOCK_RE, (_all, inner: string) => ` ${inner.trim()} `);
	return s.trim();
}

export interface BibliographyRenderOptions {
	format: OutputFormat;
	htmlContainer: "keep" | "strip";
}

/** Render the bibliography for the currently registered items. */
export function renderBibliographyEntries(
	host: EngineHost,
	opts: BibliographyRenderOptions
): string[] {
	host.setFormat(opts.format);
	const result = host.engine.makeBibliography();
	if (!result) return [];
	const [, entries] = result;
	switch (opts.format) {
		case "html":
			return opts.htmlContainer === "strip"
				? entries.map(stripHtmlEntry)
				: entries.map((e) => e.trim());
		case "text":
		case "markdown":
		case "markdown-pure":
			return entries.map((e) => e.trim());
	}
}

/**
 * One-shot citation cluster for ad-hoc rendering. Optional CiteProps
 * (locator, label, ...) are per-cite data, so they belong here rather than
 * on the CSL-JSON item: a single object applies to every cite, an array is
 * matched to the ids by position (sparse entries allowed).
 */
export function renderCitationCluster(
	host: EngineHost,
	itemIds: string[],
	format: OutputFormat,
	props?: CiteProps | (CiteProps | undefined)[]
): string {
	host.setFormat(format);
	const cluster = host.engine.makeCitationCluster(
		itemIds.map((id, i) => {
			const p = Array.isArray(props) ? props[i] : props;
			const ci: CitationItem = { id };
			if (p?.locator !== undefined) ci.locator = p.locator;
			if (p?.label !== undefined) ci.label = p.label;
			if (p?.prefix !== undefined) ci.prefix = p.prefix;
			if (p?.suffix !== undefined) ci.suffix = p.suffix;
			if (p?.suppressAuthor) ci["suppress-author"] = true;
			return ci;
		})
	);
	return cluster.trim();
}
