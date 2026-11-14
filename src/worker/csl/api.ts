import {
	BibliographyContextImpl,
	EnginePool,
	type BibliographyContext,
} from "./context";
import {
	EngineHost,
	renderBibliographyEntries,
	renderCitationCluster,
	type ResolvedResources,
} from "./engine";
import { UnavailableStyleError } from "./errors";
import { LocaleStore, normalizeLocale } from "./locales";
import type { KVStore, ResourceFetcher } from "./ports";
import { StyleResolver } from "./resolve";
import { bustCache, StyleRepository } from "./styles";
import type {
	Availability,
	CiteProps,
	CSLItem,
	LocalePreview,
	OutputFormat,
	RenderOptions,
	StyleInfo,
	StylePreview,
	StyleSample,
	StyleUpdateReport,
	UpdateAllReport,
} from "./types";
import { extractStyleMeta, slugFromStyleUri } from "./xml";

/**
 * Zotero pre-rendered style previews. `{path}` is the slug, prefixed with
 * `dependent/` for dependent styles — mirroring the styles repo layout.
 */
const DEFAULT_SAMPLE_URL =
	"https://www.zotero.org/styles-files/previews/combined/{path}.json";

const STYLES_CHECKED_KEY = "styles-checked-at";
const LOCALES_CHECKED_KEY = "locales-checked-at";
const SAMPLE_PREFIX = "sample:"; // JSON-serialized StyleSample per style id

/** When the last update-all check ran, per section (epoch ms). */
export interface UpdateStatus {
	stylesCheckedAt?: number;
	localesCheckedAt?: number;
}

export interface CslRenderServiceConfig {
	fetcher: ResourceFetcher;
	store: KVStore;
	defaultFormat?: OutputFormat;
	/** Test seam: URL template for style download; `{id}` is replaced with the slug. */
	styleUrlTemplate?: string;
	/** Test seam: URL template for locale download; `{lang}` is replaced with the tag. */
	localeUrlTemplate?: string;
	/** Test seam: URL template for rendered style samples; `{path}` is replaced. */
	styleSampleUrlTemplate?: string;
}

export interface LocaleInfo {
	/** Normalized BCP-47 tag, e.g. "de-DE". */
	tag: string;
	source: "builtin" | "folder" | "remote-cache";
	/** Download provenance (remote-cache locales only). */
	sourceUrl?: string;
	fetchedAt?: number;
}

export class CslRenderService {
	private styles: StyleRepository;
	private locales: LocaleStore;
	private resolver: StyleResolver;
	private pool = new EnginePool();
	private fetcher: ResourceFetcher;
	private store: KVStore;
	private defaultFormat: OutputFormat;
	private sampleUrlTemplate: string;

	constructor(config: CslRenderServiceConfig) {
		this.fetcher = config.fetcher;
		this.store = config.store;
		this.defaultFormat = config.defaultFormat ?? "text";
		this.sampleUrlTemplate =
			config.styleSampleUrlTemplate ?? DEFAULT_SAMPLE_URL;
		this.styles = new StyleRepository(
			config.fetcher,
			config.store,
			config.styleUrlTemplate
		);
		this.locales = new LocaleStore(config.fetcher, config.store, {
			localeUrlTemplate: config.localeUrlTemplate,
		});
		this.resolver = new StyleResolver(this.styles, this.locales);
	}

	/* ---------------- configuration (Settings tab hooks) ---------------- */

	setDefaults(opts: { format?: OutputFormat }): void {
		if (opts.format) this.defaultFormat = opts.format;
	}

	getDefaults(): { format: OutputFormat } {
		return { format: this.defaultFormat };
	}

	/* --------------------------- rendering ------------------------------ */

	private async acquireHost(opts: RenderOptions): Promise<{
		host: EngineHost;
		resolved: ResolvedResources;
	}> {
		const resolved = await this.resolver.prepare(opts);
		try {
			return { host: this.pool.acquire(resolved), resolved };
		} catch (e) {
			// XML was well-formed enough to pass introspection but the engine
			// still refused it: report as invalid, never render half-broken.
			throw new UnavailableStyleError(resolved.requestedId, {
				status: "invalid",
				reason: `engine construction failed: ${(e as Error).message}`,
			});
		}
	}

	async renderBibliography(
		items: CSLItem[],
		opts: RenderOptions
	): Promise<string[]> {
		const { host } = await this.acquireHost(opts);
		try {
			host.setItems(items);
			return renderBibliographyEntries(host, {
				format: opts.format ?? this.defaultFormat,
				htmlContainer: opts.htmlContainer ?? "keep",
			});
		} finally {
			this.pool.release(host);
		}
	}

	async renderCitation(
		items: CSLItem[],
		opts: RenderOptions,
		props?: CiteProps | (CiteProps | undefined)[]
	): Promise<string> {
		const { host } = await this.acquireHost(opts);
		try {
			host.setItems(items);
			return renderCitationCluster(
				host,
				items.map((i) => String(i.id)),
				opts.format ?? this.defaultFormat,
				props
			);
		} finally {
			this.pool.release(host);
		}
	}

	/** Render independent in-text clusters against one document-wide registry.
	 * This shares numbering and author/year disambiguation without inventing
	 * footnote history for bracketed Pandoc citations.
	 */
	async renderCitationGroups(
		items: CSLItem[],
		groups: { ids: string[]; props: CiteProps[] }[],
		opts: RenderOptions
	): Promise<string[]> {
		const { host } = await this.acquireHost(opts);
		try {
			host.setItems(items);
			return groups.map((group) => renderCitationCluster(
				host, group.ids, opts.format ?? this.defaultFormat, group.props
			));
		} finally {
			this.pool.release(host);
		}
	}

	async createContext(opts: RenderOptions): Promise<BibliographyContext> {
		const { host } = await this.acquireHost(opts);
		return new BibliographyContextImpl(host, this.pool, {
			format: opts.format ?? this.defaultFormat,
			htmlContainer: opts.htmlContainer ?? "keep",
		});
	}

	/* ---------------------- style / locale management ------------------- */

	/** Fetch (if needed) a style and its whole dependency chain; report availability. */
	async ensureStyle(id: string): Promise<Availability> {
		return this.resolver.availability(id, { allowNetwork: true });
	}

	/** Alias used by the "download dependencies" button: closes parent + locale. */
	async resolveDeps(id: string): Promise<Availability> {
		return this.ensureStyle(id);
	}

	/** Availability without touching the network (offline judgment). */
	async availabilityOffline(id: string): Promise<Availability> {
		return this.resolver.availability(id, { allowNetwork: false });
	}

	/** Resolve "nature" or "https://www.zotero.org/styles/nature" to slug + URL. */
	private parseStyleInput(input: string): { id: string; url: string } {
		const trimmed = input.trim();
		if (/^https?:\/\//i.test(trimmed)) {
			return { id: slugFromStyleUri(trimmed), url: trimmed };
		}
		// Strip stray query/fragment ("nature?source=1") and slashes.
		const id = (trimmed.split(/[?#]/)[0] as string).replace(/^\/+|\/+$/g, "");
		return { id, url: this.styles.styleUrl(id) };
	}

	/**
	 * Best-effort fetch of the pre-rendered sample for a style. Dependent
	 * styles live under `dependent/`; the other location is tried as a
	 * fallback in case the local dependent judgment disagrees with the repo
	 * layout. Returns undefined when no sample exists (e.g. custom styles).
	 */
	private async fetchSample(
		id: string,
		dependent: boolean,
		opts?: { fresh?: boolean }
	): Promise<StyleSample | undefined> {
		const paths = dependent ? [`dependent/${id}`, id] : [id, `dependent/${id}`];
		for (const path of paths) {
			try {
				const url = this.sampleUrlTemplate.replace("{path}", path);
				const raw = await this.fetcher.fetchText(
					opts?.fresh ? bustCache(url) : url
				);
				const parsed = JSON.parse(raw) as {
					citation?: unknown;
					bibliography?: unknown;
				};
				if (typeof parsed.bibliography !== "string") continue;
				return {
					citations: Array.isArray(parsed.citation)
						? parsed.citation.filter(
								(c): c is string => typeof c === "string"
							)
						: [],
					bibliographyHtml: parsed.bibliography,
				};
			} catch {
				// try the other location, then give up silently
			}
		}
		return undefined;
	}

	/** Fetch a style's sample and persist it for offline Details viewing. */
	private async cacheSample(
		id: string,
		dependent: boolean,
		opts?: { fresh?: boolean }
	): Promise<StyleSample | undefined> {
		const sample = await this.fetchSample(id, dependent, opts);
		if (sample) {
			await this.store.set(SAMPLE_PREFIX + id, JSON.stringify(sample));
		}
		return sample;
	}

	/**
	 * Best-effort: cache samples for every downloaded member of a style's
	 * (now locally closed) dependency chain. Folder styles are skipped —
	 * the previews endpoint only knows repository styles.
	 */
	private async cacheChainSamples(
		id: string,
		opts?: { skip?: string; fresh?: boolean }
	): Promise<void> {
		const chain = await this.styles.resolveChain(id, {
			allowNetwork: false,
		});
		if (!chain.ok) return;
		for (const member of chain.chain) {
			if (member === opts?.skip) continue;
			const local = await this.styles.getLocal(member);
			if (!local || local.source !== "remote-cache") continue;
			await this.cacheSample(member, local.meta?.dependent ?? false, {
				fresh: opts?.fresh,
			});
		}
	}

	/**
	 * Fetch a style by id or URL and return its metadata plus a rendered
	 * sample for user confirmation. Nothing is cached; pass the preview to
	 * addStyle(). Throws when the input is empty, unreachable, or not CSL.
	 */
	async previewStyle(input: string): Promise<StylePreview> {
		const { id: inputId, url } = this.parseStyleInput(input);
		if (!inputId) {
			throw new Error("provide a style id or a style URL");
		}
		const xml = await this.fetcher.fetchText(url);
		const meta = extractStyleMeta(xml); // throws on non-CSL payloads
		// The style's own declared id (info > id) is the authoritative slug
		// source — the user's input may carry tracking params or odd paths.
		const selfSlug = meta.selfUri ? slugFromStyleUri(meta.selfUri) : "";
		const id = /^[\w.-]+$/.test(selfSlug) ? selfSlug : inputId;
		return {
			id,
			sourceUrl: url,
			title: meta.title,
			dependent: meta.dependent,
			parent: meta.parent,
			defaultLocale: meta.defaultLocale,
			citationFormat: meta.citationFormat,
			hasBibliography: meta.hasBibliography,
			alreadyInstalled: (await this.styles.getLocal(id)) !== null,
			xml,
			sample: await this.fetchSample(id, meta.dependent),
		};
	}

	/**
	 * Rendered sample for an installed style (Details modal). Served from
	 * the persistent cache so it works offline; falls back to a network
	 * fetch (and caches it) when nothing is stored yet. Best-effort:
	 * undefined when the previews endpoint has none.
	 */
	async styleSample(id: string): Promise<StyleSample | undefined> {
		const cached = await this.store.get(SAMPLE_PREFIX + id);
		if (cached !== null) {
			try {
				return JSON.parse(cached) as StyleSample;
			} catch {
				// corrupt entry — refetch below
			}
		}
		const local = await this.styles.getLocal(id);
		return this.cacheSample(id, local?.meta?.dependent ?? false);
	}

	/**
	 * Install a previewed style: cache its XML with provenance, close the
	 * dependency chain (downloading parents) and the default locale. The
	 * style itself is marked as explicitly installed; auto-fetched parents
	 * stay implicit for ref-counted cleanup.
	 */
	async addStyle(preview: StylePreview): Promise<Availability> {
		await this.styles.cacheFetched(preview.id, preview.sourceUrl, preview.xml, {
			explicit: true,
		});
		// The preview's sample is already in hand — persist it for offline
		// Details viewing.
		if (preview.sample) {
			await this.store.set(
				SAMPLE_PREFIX + preview.id,
				JSON.stringify(preview.sample)
			);
		}
		this.pool.clear(); // may shadow a pooled engine with the same id
		const avail = await this.resolver.availability(preview.id, {
			allowNetwork: true,
		});
		// Auto-fetched parents get their samples cached too (best-effort).
		await this.cacheChainSamples(preview.id, { skip: preview.id });
		return avail;
	}

	/**
	 * Refetch a downloaded style and every member of its dependency chain
	 * from their recorded source URLs, then re-ensure the default locale.
	 */
	async updateStyle(id: string): Promise<StyleUpdateReport> {
		const local = await this.styles.getLocal(id);
		if (!local) {
			throw new Error(`style "${id}" is not installed`);
		}
		if (local.source !== "remote-cache") {
			throw new Error(
				`style "${id}" is a ${local.source} style and has no source URL to update from`
			);
		}
		const result = await this.styles.updateChain(id);
		this.pool.clear();
		// Re-resolve: a new revision may declare a different parent or locale.
		const availability = await this.resolver.availability(id, {
			allowNetwork: true,
		});
		// Refresh the cached samples alongside the styles themselves.
		await this.cacheChainSamples(id, { fresh: true });
		return { ...result, availability };
	}

	/** Register a style from the vault styles folder. */
	async registerCustomStyle(key: string, xml: string): Promise<Availability> {
		const entry = this.styles.registerCustom(key, xml);
		this.pool.clear(); // a same-id override may shadow pooled engines
		if (entry.invalidReason) {
			return { status: "invalid", reason: entry.invalidReason };
		}
		const avail = await this.resolver.availability(key, {
			allowNetwork: true,
		});
		if (avail.status !== "ready") return avail;
		// Deep validation: actually build an engine once so a well-formed but
		// broken style is flagged at registration time, not at render time.
		try {
			const resolved = await this.resolver.prepare({ styleId: key });
			this.pool.release(this.pool.acquire(resolved));
			return { status: "ready" };
		} catch (e) {
			const reason =
				e instanceof UnavailableStyleError
					? e.message
					: `engine construction failed: ${(e as Error).message}`;
			return { status: "invalid", reason };
		}
	}

	unregisterCustomStyle(key: string): void {
		this.styles.unregisterCustom(key);
		this.pool.clear();
	}

	/** Register a locale XML supplied by the platform (vault folder). */
	registerCustomLocale(lang: string, xml: string): void {
		this.locales.registerCustom(lang, xml);
		this.pool.clear();
	}

	unregisterCustomLocale(lang: string): void {
		this.locales.unregisterCustom(lang);
		this.pool.clear();
	}

	/** Drop all folder-registered styles before a re-scan. */
	clearFolderStyles(): void {
		this.styles.clearFolderStyles();
		this.pool.clear();
	}

	/** All locales known locally: bundled en-US, folder-registered, cached. */
	async listLocales(): Promise<LocaleInfo[]> {
		// en-US is always available (bundled), but an update overlays it —
		// surface the overlay's provenance so the row can show "Updated …".
		const enUsMeta = await this.locales.getMeta("en-US");
		const out: LocaleInfo[] = [
			{
				tag: "en-US",
				source: "builtin",
				sourceUrl: enUsMeta?.sourceUrl,
				fetchedAt: enUsMeta?.fetchedAt,
			},
		];
		const seen = new Set<string>(["en-US"]);
		for (const tag of this.locales.listCustomTags()) {
			if (seen.has(tag)) continue;
			seen.add(tag);
			out.push({ tag, source: "folder" });
		}
		for (const tag of await this.locales.listCached()) {
			if (seen.has(tag)) continue;
			seen.add(tag);
			const meta = await this.locales.getMeta(tag);
			out.push({
				tag,
				source: "remote-cache",
				sourceUrl: meta?.sourceUrl,
				fetchedAt: meta?.fetchedAt,
			});
		}
		return out.sort((a, b) => a.tag.localeCompare(b.tag));
	}

	/**
	 * Fetch a locale by tag and return it for user confirmation. Nothing is
	 * cached; pass the preview to addLocale(). Throws when the tag cannot be
	 * fetched or the payload is not locale XML.
	 */
	async previewLocale(lang: string): Promise<LocalePreview> {
		const tag = normalizeLocale(lang);
		if (!tag) {
			throw new Error("provide a locale tag, e.g. de-DE");
		}
		const url = this.locales.localeUrl(tag);
		const xml = await this.fetcher.fetchText(url);
		if (!xml.includes("<locale")) {
			throw new Error(
				`response for locale "${tag}" does not look like locale XML`
			);
		}
		return {
			tag,
			sourceUrl: url,
			alreadyInstalled: await this.locales.hasOffline(tag),
			xml,
		};
	}

	/** Install a previewed locale (cache its XML with provenance). */
	async addLocale(preview: LocalePreview): Promise<void> {
		await this.locales.cacheFetched(preview.tag, preview.sourceUrl, preview.xml);
		this.pool.clear();
	}

	/** Download (if needed) and cache a locale. Returns false when unavailable. */
	async ensureLocale(lang: string): Promise<boolean> {
		return this.locales.ensure(lang);
	}

	/** Refetch a downloaded locale from its recorded source URL. */
	async updateLocale(lang: string): Promise<{ updated: boolean }> {
		const result = await this.locales.update(lang);
		this.pool.clear();
		return result;
	}

	/** Remove a cached locale (bundled en-US and folder locales are kept). */
	async removeLocale(lang: string): Promise<void> {
		await this.locales.remove(lang);
		this.pool.clear();
	}

	/**
	 * Remove a style. Ref-counted cleanup: removing an alias also prunes its
	 * ancestor chain, but an ancestor is only deleted when it was pulled in
	 * implicitly (never installed directly) and no other installed style
	 * still depends on it.
	 */
	async removeStyle(id: string): Promise<void> {
		// Capture the ancestor chain before the leaf disappears.
		const ancestors: string[] = [];
		const seen = new Set<string>([id]);
		let cur = await this.styles.getLocal(id);
		while (cur?.meta?.dependent && cur.meta.parent) {
			const parent = cur.meta.parent;
			if (seen.has(parent)) break; // defensive: cycles in hand-written files
			seen.add(parent);
			ancestors.push(parent);
			cur = await this.styles.getLocal(parent);
		}

		await this.styles.remove(id);
		await this.store.delete(SAMPLE_PREFIX + id);

		for (const ancestor of ancestors) {
			const entry = await this.styles.getLocal(ancestor);
			// Stop at folder styles (user-owned) and explicit installs.
			if (!entry || entry.source !== "remote-cache" || entry.explicit) {
				break;
			}
			const dependents = await this.styles.dependentsOf(ancestor);
			if (dependents.length > 0) break; // still referenced
			await this.styles.remove(ancestor);
			await this.store.delete(SAMPLE_PREFIX + ancestor);
		}
		this.pool.clear();
	}

	/**
	 * Refetch every downloaded style (and, through the chains, every parent)
	 * exactly once. Persists the check time for "Checked …" display.
	 */
	async updateAllStyles(): Promise<UpdateAllReport> {
		const report: UpdateAllReport = {
			updated: [],
			unchanged: [],
			failed: [],
			checkedAt: Date.now(),
		};
		const visited = new Set<string>();
		for (const id of await this.styles.listCachedIds()) {
			const chain = await this.styles.updateChain(id, visited);
			report.updated.push(...chain.updated);
			report.unchanged.push(...chain.unchanged);
			report.failed.push(...chain.failed);
		}
		this.pool.clear();
		// Refresh cached samples for everything the walk touched.
		for (const id of visited) {
			const local = await this.styles.getLocal(id);
			if (!local || local.source !== "remote-cache") continue;
			await this.cacheSample(id, local.meta?.dependent ?? false, {
				fresh: true,
			});
		}
		await this.store.set(STYLES_CHECKED_KEY, String(report.checkedAt));
		return report;
	}

	/** Refetch every downloaded locale plus bundled en-US. Persists the check time. */
	async updateAllLocales(): Promise<UpdateAllReport> {
		const report: UpdateAllReport = {
			updated: [],
			unchanged: [],
			failed: [],
			checkedAt: Date.now(),
		};
		const tags = new Set(await this.locales.listCached());
		tags.add("en-US"); // bundled, but updatable via overlay
		for (const tag of tags) {
			try {
				const { updated } = await this.locales.update(tag);
				(updated ? report.updated : report.unchanged).push(tag);
			} catch (e) {
				report.failed.push({ id: tag, reason: (e as Error).message });
			}
		}
		this.pool.clear();
		await this.store.set(LOCALES_CHECKED_KEY, String(report.checkedAt));
		return report;
	}

	/** When update-all last ran for each section (undefined = never). */
	async getUpdateStatus(): Promise<UpdateStatus> {
		const styles = await this.store.get(STYLES_CHECKED_KEY);
		const locales = await this.store.get(LOCALES_CHECKED_KEY);
		return {
			stylesCheckedAt: styles !== null ? Number(styles) : undefined,
			localesCheckedAt: locales !== null ? Number(locales) : undefined,
		};
	}

	/**
	 * Known styles (custom + cached), each with its offline availability.
	 * Never touches the network.
	 */
	async listStyles(): Promise<StyleInfo[]> {
		const out: StyleInfo[] = [];
		const seen = new Set<string>();

		for (const key of this.styles.customKeys()) {
			const entry = this.styles.getCustom(key);
			if (!entry) continue;
			seen.add(key);
			out.push({
				id: key,
				title: entry.meta?.title,
				source: entry.source,
				dependent: entry.meta?.dependent,
				parent: entry.meta?.parent,
				defaultLocale: entry.meta?.defaultLocale,
				citationFormat: entry.meta?.citationFormat,
				hasBibliography: entry.meta?.hasBibliography,
				availability: entry.invalidReason
					? { status: "invalid", reason: entry.invalidReason }
					: await this.resolver.availability(key, { allowNetwork: false }),
			});
		}

		for (const id of await this.styles.listCachedIds()) {
			if (seen.has(id)) continue; // custom overrides remote with same id
			const local = await this.styles.getLocal(id);
			if (!local) continue;
			out.push({
				id,
				title: local.meta?.title,
				source: "remote-cache",
				dependent: local.meta?.dependent,
				parent: local.meta?.parent,
				defaultLocale: local.meta?.defaultLocale,
				citationFormat: local.meta?.citationFormat,
				hasBibliography: local.meta?.hasBibliography,
				explicit: local.explicit,
				remote: local.remote,
				availability: local.invalidReason
					? { status: "invalid", reason: local.invalidReason }
					: await this.resolver.availability(id, { allowNetwork: false }),
			});
		}

		return out.sort((a, b) => a.id.localeCompare(b.id));
	}

	async clearCache(): Promise<void> {
		await this.styles.clearCache();
		await this.locales.clearCache();
		for (const key of await this.store.list(SAMPLE_PREFIX)) {
			await this.store.delete(key);
		}
		await this.store.delete(STYLES_CHECKED_KEY);
		await this.store.delete(LOCALES_CHECKED_KEY);
		this.pool.clear();
	}
}
