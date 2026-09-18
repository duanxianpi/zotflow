import uFuzzy from "@leeoniya/ufuzzy";
import { parseSearchQuery } from "utils/search-query";

import type {
    ParsedQuery,
    SearchFilter,
    SearchFilterField,
} from "utils/search-query";

/**
 * A normalized, engine-agnostic record fed to the matcher. `id` is an opaque
 * caller-chosen identifier used to map results back to the source object
 * (e.g. `libraryID:key` for items, or the tree entity key).
 */
export interface SearchableRecord {
    id: string;
    /** Primary display string (title / name). Always part of the haystack. */
    name: string;
    creators?: string[];
    tags?: string[];
    /** Collection NAMES the record belongs to (not keys). */
    collections?: string[];
    itemType?: string;
    /** Library NAME the record belongs to. */
    libraryName?: string;
}

/** Separator used when concatenating fields into a single fuzzy haystack. */
const HAYSTACK_SEP = " \u00b7 ";

/** Words supported by uFuzzy's default Latin matcher after diacritic folding. */
const ASCII_FUZZY_TERM_RE = /^[A-Za-z\d']+$/;

/** Unicode words, excluding punctuation that should remain a separator. */
const SEARCH_WORD_RE = /[\p{L}\p{N}\p{M}']+/gu;

/** Normalize common Latin diacritics without changing stored/displayed text. */
function foldForSearch(value: string): string {
    return uFuzzy.latinize(value.normalize("NFC"));
}

/**
 * Keep uFuzzy's fast Latin matcher, but extract other scripts for literal
 * substring matching. uFuzzy's default regexes discard non-Latin words, which
 * otherwise turns a query such as `湖南` into an empty search.
 */
function partitionFreeText(query: ParsedQuery): {
    fuzzy: string;
    literal: string[];
} {
    const fuzzy: string[] = [];
    const literal: string[] = [];

    for (const token of query.freeTokens) {
        const words = foldForSearch(token).match(SEARCH_WORD_RE) ?? [];
        for (const word of words) {
            if (ASCII_FUZZY_TERM_RE.test(word)) {
                fuzzy.push(word);
            } else {
                literal.push(word.toLowerCase());
            }
        }
    }

    return { fuzzy: fuzzy.join(" "), literal };
}

/**
 * Worker-only shared search brain. Owns the single fuzzy engine (uFuzzy) and
 * the filter-evaluation logic so that the tree view and the item search modal
 * rank and filter results identically.
 */
export class SearchService {
    private readonly uf = new uFuzzy({
        intraMode: 1, // tolerate a single typo per term
    });

    /** Parse a raw query string (delegates to the shared, dependency-free parser). */
    parse(raw: string): ParsedQuery {
        return parseSearchQuery(raw);
    }

    /**
     * Filter `records` by the query's structured operators, then fuzzy-rank the
     * survivors by the free-text portion. Returns records in ranked order
     * (best first). When there is no free text, filtered records are returned
     * in their original order.
     */
    matchAndRank(
        query: ParsedQuery,
        records: SearchableRecord[],
        limit?: number,
    ): SearchableRecord[] {
        const filters = query.filters.map((filter) => ({
            ...filter,
            value: foldForSearch(filter.value).toLowerCase(),
        }));
        const filtered = filters.length
            ? records.filter((r) => this.passesFilters(filters, r))
            : records;

        if (!query.free) {
            return limit != null ? filtered.slice(0, limit) : filtered;
        }

        const terms = partitionFreeText(query);
        if (!terms.fuzzy && terms.literal.length === 0) return [];

        const searchable = filtered.map((record) => ({
            record,
            haystack: foldForSearch(this.buildHaystack(record)),
        }));
        const candidates = terms.literal.length
            ? searchable.filter(({ haystack }) => {
                  const normalized = haystack.toLowerCase();
                  return terms.literal.every((term) =>
                      normalized.includes(term),
                  );
              })
            : searchable;

        if (candidates.length === 0) return [];
        if (!terms.fuzzy) {
            const matched = candidates.map(({ record }) => record);
            return limit != null ? matched.slice(0, limit) : matched;
        }

        const haystack = candidates.map((candidate) => candidate.haystack);
        // outOfOrder permutation cap enables cross-field term reordering
        // (e.g. "smith attention" matching a title + a separate author field).
        const [idxs, info, order] = this.uf.search(
            haystack,
            terms.fuzzy,
            4,
        );

        if (!idxs || idxs.length === 0) return [];

        let ranked: SearchableRecord[];
        if (order && info) {
            ranked = order.map((o) => candidates[info.idx[o]!]!.record);
        } else {
            // Ranking was skipped (threshold exceeded) — preserve filter order.
            ranked = idxs.map((i) => candidates[i]!.record);
        }

        return limit != null ? ranked.slice(0, limit) : ranked;
    }

    private buildHaystack(r: SearchableRecord): string {
        const parts: string[] = [r.name];
        if (r.creators?.length) parts.push(r.creators.join(" "));
        if (r.tags?.length) parts.push(r.tags.join(" "));
        return parts.join(HAYSTACK_SEP);
    }

    private passesFilters(
        filters: SearchFilter[],
        r: SearchableRecord,
    ): boolean {
        for (const f of filters) {
            const hit = this.evaluateFilter(f.field, f.value, r);
            if (hit === f.negate) return false;
        }
        return true;
    }

    private evaluateFilter(
        field: SearchFilterField,
        value: string,
        r: SearchableRecord,
    ): boolean {
        const needle = value;
        const includesNeedle = (candidate: string | undefined) =>
            foldForSearch(candidate ?? "").toLowerCase().includes(needle);

        switch (field) {
            case "library":
                return includesNeedle(r.libraryName);
            case "collection":
                return (r.collections ?? []).some((c) =>
                    includesNeedle(c),
                );
            case "tag":
                return (r.tags ?? []).some((t) => includesNeedle(t));
            case "creator":
                return (r.creators ?? []).some((c) => includesNeedle(c));
            case "type":
                return includesNeedle(r.itemType);
            default:
                return false;
        }
    }
}
