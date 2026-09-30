import { BASE_FIELD_MAP, ZOTERO_FIELDS } from "types/zotero-base-fields";
import { extractYear } from "utils/date";

import type { AnyIDBZoteroItem } from "types/db-schema";
import type {
    CreatorTemplateContext,
    ItemMetadataContext,
    ZoteroFieldValues,
} from "types/template-context";

/** Any Zotero item `data` object — only `itemType` is required. */
export type ZoteroFieldSource = { itemType: string };

/**
 * Read a field the way Zotero's `getField(field, false, true)` does:
 * a base field (e.g. `title`, `date`, `publicationTitle`) falls back to the
 * type-specific field that stands in for it, so a case's `title` resolves
 * to `caseName` and a book section's `publicationTitle` to `bookTitle`.
 *
 * Returns `undefined` when neither holds a non-empty string.
 */
export function getField<T extends ZoteroFieldSource>(
    data: T,
    field: string,
): string | undefined {
    const record = data as unknown as Record<string, unknown>;
    const direct = record[field];
    if (typeof direct === "string" && direct) return direct;

    const mapped = BASE_FIELD_MAP[data.itemType]?.[field];
    if (!mapped) return undefined;
    const value = record[mapped];
    return typeof value === "string" && value ? value : undefined;
}

/**
 * Every schema field the item has a value for, resolved through
 * `getField()` — so a book section gets both `bookTitle` and
 * `publicationTitle`. Fields without a value are absent.
 */
export function getFieldValues<T extends ZoteroFieldSource>(
    data: T,
): ZoteroFieldValues {
    const values: ZoteroFieldValues = {};
    for (const name of ZOTERO_FIELDS) {
        const value = getField(data, name);
        if (value !== undefined) values[name] = value;
    }
    return values;
}

/** Creators with their role and name parts, plus a display `name`. */
export function getCreators<T extends ZoteroFieldSource>(
    data: T,
): CreatorTemplateContext[] {
    const creators = (data as { creators?: unknown }).creators;
    if (!Array.isArray(creators)) return [];
    return creators.map((c: Record<string, string | undefined>) => ({
        creatorType: c.creatorType,
        firstName: c.firstName,
        lastName: c.lastName,
        name: c.name || `${c.firstName || ""} ${c.lastName || ""}`.trim(),
    }));
}

/**
 * The bibliographic part of a template context, shared by source-note and
 * note-path templates so both expose the same variables.
 */
export function buildItemMetadata(item: AnyIDBZoteroItem): ItemMetadataContext {
    const raw = item.raw;
    const data = { ...(raw?.data ?? {}), itemType: item.itemType };
    const values = getFieldValues(data);
    return {
        ...values,
        // The stored title, which is what the tree view and search show.
        title: item.title || "",
        // Also covers keys parsed out of `extra` (e.g. Better BibTeX).
        citationKey: item.citationKey || "",
        date: values.date ?? null,
        accessDate: values.accessDate ?? null,
        year: extractYear(values.date),
        creators: getCreators(data),
        creatorSummary: raw?.meta?.creatorSummary || "",
    };
}
