import { db, getCombinations } from "db/db";
import { Zotero_Item_Types } from "types/zotero-item-const";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type {
    PandocCitation,
    RenderedPandocCitation,
    CitationReference,
} from "types/pandoc-citation";
import { proxiedFetch } from "worker/proxied-fetch";
import { CslRenderService } from "worker/csl";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";

import type {
    BibliographyContext,
    CiteProps,
    CSLItem,
    KVStore,
    ResourceFetcher,
    Availability,
    LocalePreview,
    RenderOptions,
    StyleInfo,
    StylePreview,
    StyleSample,
    StyleUpdateReport,
    UpdateAllReport,
    UpdateStatus,
} from "worker/csl";
import type { LocaleInfo } from "worker/csl";
import type { ZotFlowSettings } from "settings/types";
import type { IParentProxy } from "bridge/types";

/** KVStore adapter over the worker-only Dexie `cslCache` table. */
class DexieKVStore implements KVStore {
    async get(key: string): Promise<string | null> {
        const entry = await db.cslCache.get(key);
        return entry ? entry.value : null;
    }

    async set(key: string, value: string): Promise<void> {
        await db.cslCache.put({ key, value });
    }

    async list(prefix: string): Promise<string[]> {
        return db.cslCache.where("key").startsWith(prefix).primaryKeys();
    }

    async delete(key: string): Promise<void> {
        await db.cslCache.delete(key);
    }
}

/**
 * ResourceFetcher over the worker's global fetch (transparently proxied
 * through ParentHost.request, so it bypasses CORS and works on mobile).
 * Only ever fetches data (XML/JSON) — never code.
 */
class WorkerFetcher implements ResourceFetcher {
    // Worker code cannot use requestUrl (main-thread Obsidian API);
    // proxiedFetch is the worker fetch installed by worker.ts, which
    // routes through ParentHost.request (requestUrl under the hood).
    async fetchText(url: string): Promise<string> {
        const res = await proxiedFetch(url);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${url}`);
        }
        return res.text();
    }
}

/**
 * Worker-side CSL rendering service. Wraps the vendored csl-render core with
 * ZotFlow's storage (Dexie) and network (proxied fetch), and flattens the
 * stateful BibliographyContext API into id-keyed methods so it can cross the
 * Comlink boundary.
 */
export class CslRenderWorkerService {
    private core: CslRenderService;
    private contexts = new Map<string, BibliographyContext>();

    constructor(
        settings: ZotFlowSettings,
        private parentHost?: IParentProxy,
    ) {
        this.core = new CslRenderService({
            fetcher: new WorkerFetcher(),
            store: new DexieKVStore(),
            defaultFormat: settings.cslDefaultFormat,
        });
    }

    private async changed<T>(operation: Promise<T>): Promise<T> {
        const result = await operation;
        this.parentHost?.emit("cslChanged");
        return result;
    }

    updateSettings(settings: ZotFlowSettings): void {
        this.core.setDefaults({ format: settings.cslDefaultFormat });
    }

    dispose(): void {
        for (const ctx of this.contexts.values()) {
            ctx.dispose();
        }
        this.contexts.clear();
    }

    /* ------------------------------ rendering ------------------------- */

    renderBibliography(
        items: CSLItem[],
        opts: RenderOptions,
    ): Promise<string[]> {
        return this.core.renderBibliography(items, opts);
    }

    renderCitation(
        items: CSLItem[],
        opts: RenderOptions,
        props?: CiteProps | (CiteProps | undefined)[],
    ): Promise<string> {
        return this.core.renderCitation(items, opts, props);
    }

    /** Offline lookup: never guess between duplicate keys or fetch item metadata. */
    async renderPandocCitations(
        clusters: PandocCitation[],
        libraryIDs: number[],
        styleId: string,
    ): Promise<(RenderedPandocCitation | null)[]> {
        try {
            if (!clusters.length || !libraryIDs.length)
                return clusters.map(() => null);
            const types = Zotero_Item_Types.filter(
                (type) => !["note", "annotation", "attachment"].includes(type),
            );
            const candidates = await db.items
                .where(["libraryID", "itemType", "trashed"])
                .anyOf(getCombinations([libraryIDs, types, [0]]))
                .toArray();
            const byKey = new Map<string, AnyIDBZoteroItem[]>();
            for (const item of candidates) {
                if (item.parentItem) continue;
                const key = item.citationKey || item.key;
                const matches = byKey.get(key) ?? [];
                matches.push(item);
                byKey.set(key, matches);
            }
            const items = new Map<string, CSLItem>();
            const resolved = clusters.map((cluster) => {
                const rows: AnyIDBZoteroItem[] = [];
                for (const cite of cluster.cites) {
                    const matches = byKey.get(cite.citekey);
                    const row = matches?.length === 1 ? matches[0] : undefined;
                    if (!row?.csljson || typeof row.csljson.type !== "string")
                        return null;
                    rows.push(row);
                }
                for (const row of rows) {
                    const id = `${row.libraryID}/${row.key}`;
                    items.set(id, {
                        ...row.csljson,
                        id,
                        type: row.csljson!.type as string,
                    });
                }
                return rows;
            });
            if (!items.size) return clusters.map(() => null);
            // A preview must not silently download CSL resources while typing.
            const availability = await this.core.availabilityOffline(styleId);
            if (availability.status !== "ready")
                return clusters.map(() => null);
            const groups = resolved.flatMap((rows, i) =>
                rows
                    ? [
                          {
                              ids: rows.map((r) => `${r.libraryID}/${r.key}`),
                              props: clusters[i]!.cites,
                          },
                      ]
                    : [],
            );
            const texts = await this.core.renderCitationGroups(
                [...items.values()],
                groups,
                { styleId, format: "text" },
            );
            const refs = new Map<string, CitationReference>();
            for (const rows of resolved) {
                for (const row of rows ?? []) {
                    const id = `${row.libraryID}/${row.key}`;
                    if (refs.has(id)) continue;
                    const bibliography = await this.core.renderBibliography(
                        [items.get(id)!],
                        { styleId, format: "text" },
                    );
                    const bibliographyHtml = await this.core.renderBibliography(
                        [items.get(id)!],
                        { styleId, format: "html", htmlContainer: "strip" },
                    );
                    const attachments = await db.items
                        .where([
                            "libraryID",
                            "parentItem",
                            "itemType",
                            "trashed",
                        ])
                        .equals([row.libraryID, row.key, "attachment", 0])
                        .toArray();
                    const pdf = attachments.find(
                        (a) =>
                            a.itemType === "attachment" &&
                            a.raw.data.contentType === "application/pdf" &&
                            a.raw.data.linkMode !== "linked_url",
                    );
                    refs.set(id, {
                        libraryID: row.libraryID,
                        key: row.key,
                        citekey: row.citationKey || row.key,
                        bibliography: bibliography[0] || row.title || row.key,
                        bibliographyHtml: bibliographyHtml[0],
                        attachmentKey: pdf?.key,
                    });
                }
            }
            let index = 0;
            return resolved.map((rows, i) =>
                rows
                    ? {
                          text: texts[index++]!,
                          references: rows.map((row, j) => ({
                              ...refs.get(`${row.libraryID}/${row.key}`)!,
                              page:
                                  clusters[i]!.cites[j]!.label === "page"
                                      ? clusters[i]!.cites[j]!.locator?.split(
                                            /[-–,]/,
                                        )[0]?.trim()
                                      : undefined,
                          })),
                      }
                    : null,
            );
        } catch (error) {
            throw ZotFlowError.wrap(
                error,
                ZotFlowErrorCode.RESOURCE_MISSING,
                "CslRenderWorkerService",
                "Could not render Pandoc citations",
            );
        }
    }

    /* --------------------- id-keyed context API ------------------------ */

    async createContext(opts: RenderOptions): Promise<string> {
        const ctx = await this.core.createContext(opts);
        const id = crypto.randomUUID();
        this.contexts.set(id, ctx);
        return id;
    }

    private getContext(id: string): BibliographyContext {
        const ctx = this.contexts.get(id);
        if (!ctx) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "CslRenderWorkerService",
                `Unknown CSL context "${id}" (already disposed?)`,
            );
        }
        return ctx;
    }

    contextRegisterItems(id: string, items: CSLItem[]): void {
        this.getContext(id).registerItems(items);
    }

    contextAddCitation(
        id: string,
        itemIds: string[],
        props?: CiteProps,
    ): string {
        return this.getContext(id).addCitation(itemIds, props);
    }

    contextMakeBibliography(id: string): string[] {
        return this.getContext(id).makeBibliography();
    }

    contextRebuild(id: string): void {
        this.getContext(id).rebuild();
    }

    disposeContext(id: string): void {
        this.contexts.get(id)?.dispose();
        this.contexts.delete(id);
    }

    /* --------------------- style / locale management ------------------- */

    ensureStyle(id: string): Promise<Availability> {
        return this.changed(this.core.ensureStyle(id));
    }

    resolveDeps(id: string): Promise<Availability> {
        return this.changed(this.core.resolveDeps(id));
    }

    listStyles(): Promise<StyleInfo[]> {
        return this.core.listStyles();
    }

    /** Fetch a style by id or URL for preview; nothing is installed yet. */
    previewStyle(input: string): Promise<StylePreview> {
        return this.core.previewStyle(input);
    }

    /** Install a previewed style (dependency chain + default locale included). */
    addStyle(preview: StylePreview): Promise<Availability> {
        return this.changed(this.core.addStyle(preview));
    }

    /** Refetch a downloaded style and its whole dependency chain. */
    updateStyle(id: string): Promise<StyleUpdateReport> {
        return this.changed(this.core.updateStyle(id));
    }

    /** Refetch every downloaded style once (shared parents deduplicated). */
    updateAllStyles(): Promise<UpdateAllReport> {
        return this.changed(this.core.updateAllStyles());
    }

    /** Refetch every downloaded locale. */
    updateAllLocales(): Promise<UpdateAllReport> {
        return this.changed(this.core.updateAllLocales());
    }

    /** When update-all last ran for styles / locales. */
    getUpdateStatus(): Promise<UpdateStatus> {
        return this.core.getUpdateStatus();
    }

    /** Rendered sample for an installed style (Details modal), best-effort. */
    styleSample(id: string): Promise<StyleSample | undefined> {
        return this.core.styleSample(id);
    }

    /** Register a style from the vault styles folder. */
    registerCustomStyle(key: string, xml: string): Promise<Availability> {
        return this.changed(this.core.registerCustomStyle(key, xml));
    }

    // Comlink makes every call async on the main-thread side, so these
    // return promises even though the core operations are synchronous.
    unregisterCustomStyle(key: string): Promise<void> {
        this.core.unregisterCustomStyle(key);
        this.parentHost?.emit("cslChanged");
        return Promise.resolve();
    }

    clearFolderStyles(): Promise<void> {
        this.core.clearFolderStyles();
        this.parentHost?.emit("cslChanged");
        return Promise.resolve();
    }

    removeStyle(id: string): Promise<void> {
        return this.changed(this.core.removeStyle(id));
    }

    registerCustomLocale(lang: string, xml: string): Promise<void> {
        this.core.registerCustomLocale(lang, xml);
        this.parentHost?.emit("cslChanged");
        return Promise.resolve();
    }

    unregisterCustomLocale(lang: string): Promise<void> {
        this.core.unregisterCustomLocale(lang);
        this.parentHost?.emit("cslChanged");
        return Promise.resolve();
    }

    listLocales(): Promise<LocaleInfo[]> {
        return this.core.listLocales();
    }

    /** Fetch a locale by tag for preview; nothing is installed yet. */
    previewLocale(lang: string): Promise<LocalePreview> {
        return this.core.previewLocale(lang);
    }

    /** Install a previewed locale. */
    addLocale(preview: LocalePreview): Promise<void> {
        return this.changed(this.core.addLocale(preview));
    }

    /** Refetch a downloaded locale from its recorded source URL. */
    updateLocale(lang: string): Promise<{ updated: boolean }> {
        return this.changed(this.core.updateLocale(lang));
    }

    ensureLocale(lang: string): Promise<boolean> {
        return this.changed(this.core.ensureLocale(lang));
    }

    removeLocale(lang: string): Promise<void> {
        return this.changed(this.core.removeLocale(lang));
    }

    clearCache(): Promise<void> {
        return this.changed(this.core.clearCache());
    }
}
