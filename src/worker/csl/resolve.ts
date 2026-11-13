import type { ResolvedResources } from "./engine";
import { UnavailableStyleError } from "./errors";
import { LocaleStore, normalizeLocale } from "./locales";
import { StyleRepository } from "./styles";
import type { Availability, RenderOptions } from "./types";

function djb2(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	}
	return h.toString(36);
}

/**
 * Closes the (style -> parent -> locale) chain. All async prefetching happens
 * here, BEFORE any CSL.Engine is constructed, because the engine's sys
 * callbacks must return synchronously.
 */
const FALLBACK_LOCALE = "en-US";

export class StyleResolver {
	constructor(
		private styles: StyleRepository,
		private locales: LocaleStore
	) {}

	/**
	 * Compute the availability of a style without rendering. With
	 * `allowNetwork: false` this never fetches, so missing dependencies are
	 * reported optimistically as "resolvable".
	 */
	async availability(
		id: string,
		opts: { allowNetwork: boolean; locale?: string; xml?: string }
	): Promise<Availability> {
		const chain = await this.styles.resolveChain(id, {
			allowNetwork: opts.allowNetwork,
			xml: opts.xml,
		});
		if (!chain.ok) return chain.failure;

		const lang = normalizeLocale(
			opts.locale ?? chain.defaultLocale ?? FALLBACK_LOCALE
		);
		if (await this.locales.hasOffline(lang)) return { status: "ready" };
		if (!opts.allowNetwork) return { status: "resolvable" };
		if (await this.locales.ensure(lang)) return { status: "ready" };
		return { status: "unresolved-locale", locale: lang };
	}

	/**
	 * Prefetch everything needed to build an engine for these options.
	 * Throws UnavailableStyleError when the chain is not closed — rendering
	 * never silently degrades.
	 */
	async prepare(opts: RenderOptions): Promise<ResolvedResources> {
		const requestedId =
			opts.styleXml !== undefined
				? `(inline:${djb2(opts.styleXml)})`
				: (opts.styleId ?? "").trim();

		if (opts.styleXml === undefined && !requestedId) {
			throw new UnavailableStyleError("(none)", {
				status: "invalid",
				reason: "RenderOptions requires styleId or styleXml",
			});
		}

		const chain = await this.styles.resolveChain(requestedId, {
			allowNetwork: true,
			xml: opts.styleXml,
		});
		if (!chain.ok) {
			throw new UnavailableStyleError(requestedId, chain.failure);
		}

		const lang = normalizeLocale(
			opts.locale ?? chain.defaultLocale ?? FALLBACK_LOCALE
		);
		if (!(await this.locales.ensure(lang))) {
			throw new UnavailableStyleError(requestedId, {
				status: "unresolved-locale",
				locale: lang,
			});
		}

		const styleKey =
			opts.styleXml !== undefined
				? `xml:${djb2(opts.styleXml)}`
				: chain.independentId;

		return {
			styleXml: chain.independentXml,
			lang,
			requestedId,
			engineKey: `${styleKey}|${lang}${opts.format === "html" && opts.htmlVariableSpans ? "|variables" : ""}`,
			htmlVariableSpans: opts.format === "html" && opts.htmlVariableSpans,
			localeLookup: (l: string) => this.locales.getSync(l),
		};
	}
}
