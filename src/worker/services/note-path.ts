import { Liquid } from "liquidjs";
import type { ZotFlowSettings } from "settings/types";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import { db } from "db/db";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import { buildItemMetadata } from "utils/zotero-fields";
import { renderLiquid } from "./liquid-support";
import type { DbHelperService } from "./db-helper";

const FALLBACK_ZOTERO_TEMPLATE =
    "Source/{{libraryName}}/@{{citationKey | default: title | default: key}}";

const FALLBACK_LOCAL_TEMPLATE = "Source/Local/@{{basename}}";

/** Sanitize a single path segment (filename or folder name). */
function sanitizeSegment(segment: string): string {
    const illegalRe = /[/?<>\\:*|"]/g;
    const controlRe = /\p{Cc}/gu;
    const reservedRe = /^\.+$/;
    const windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

    let s = segment.replace(illegalRe, "").replace(controlRe, "").trim();

    if (reservedRe.test(s)) s = "_";
    if (windowsReservedRe.test(s)) s = `_${s}`;

    return s;
}

/** Keys should not be sanitized (e.g., date fields, path fields). */
const IGNORE_KEYS: ReadonlySet<string> = new Set([
    "date",
    "dateAdded",
    "dateModified",
    "accessDate",
    "path",
    "directory",
    "itemPaths",
]);

/** Sanitize all string values in a template context object, skipping ignored fields. */
function sanitizeContext(
    ctx: Record<string, unknown>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ctx)) {
        if (typeof value === "string") {
            result[key] = IGNORE_KEYS.has(key) ? value : sanitizeSegment(value);
        } else if (
            Array.isArray(value) &&
            value.length > 0 &&
            typeof value[0] === "object"
        ) {
            result[key] = value.map((item: Record<string, unknown>) => {
                const cleaned: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(item)) {
                    cleaned[k] =
                        typeof v === "string"
                            ? IGNORE_KEYS.has(k)
                                ? v
                                : sanitizeSegment(v)
                            : v;
                }
                return cleaned;
            });
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Longest path segment, in UTF-8 bytes. File systems allow 255 bytes per
 * name; this leaves room for `.md` and the ` (n)` a note gets when its path
 * is taken.
 */
export const MAX_SEGMENT_BYTES = 200;

const utf8 = new TextEncoder();

/** `Intl.Segmenter`, typed here: the project's TS lib predates it. */
type GraphemeSegmenter = {
    segment(text: string): Iterable<{ segment: string }>;
};
const SegmenterCtor = (
    Intl as unknown as {
        Segmenter?: new (
            locale: undefined,
            options: { granularity: "grapheme" },
        ) => GraphemeSegmenter;
    }
).Segmenter;
const graphemes = SegmenterCtor
    ? new SegmenterCtor(undefined, { granularity: "grapheme" })
    : null;

/** User-perceived characters, so a cut never splits an emoji or accent. */
function characters(text: string): string[] {
    return graphemes
        ? Array.from(graphemes.segment(text), (s) => s.segment)
        : Array.from(text);
}

/**
 * Cut a segment to MAX_SEGMENT_BYTES at a character boundary. Measured in
 * bytes, since that is what the limit counts (a CJK character is three).
 * Trailing spaces and dots left by the cut are dropped (Windows rejects them).
 */
function capSegment(segment: string): string {
    if (utf8.encode(segment).length <= MAX_SEGMENT_BYTES) return segment;
    let out = "";
    let bytes = 0;
    for (const c of characters(segment)) {
        const n = utf8.encode(c).length;
        if (bytes + n > MAX_SEGMENT_BYTES) break;
        out += c;
        bytes += n;
    }
    return out.replace(/[\s.]+$/u, "") || "_";
}

/**
 * Normalize a rendered path: collapse slashes, strip empties, cap each
 * segment's length, append `.md`.
 */
function sanitizePath(rawPath: string): string {
    const normalized = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
    const segments = normalized
        .split("/")
        .filter((s) => s.trim().length > 0)
        .map(capSegment);
    return `${segments.join("/")}.md`;
}

/** Resolves configurable note file paths via LiquidJS templates. */
export class NotePathService {
    private engine: Liquid;

    constructor(
        private settings: ZotFlowSettings,
        private dbHelper: DbHelperService,
    ) {
        this.engine = new Liquid({ greedy: false });
    }

    updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
    }

    /** Resolve the vault path for a library (Zotero) item source note. */
    async resolveLibraryNotePath(
        item: AnyIDBZoteroItem,
        templateOverride?: string,
    ): Promise<string> {
        const template =
            templateOverride?.trim() ||
            this.settings.librarySourceNotePathTemplate.trim() ||
            FALLBACK_ZOTERO_TEMPLATE;

        const library = await db.libraries.get(item.libraryID);
        const libraryName = library?.name || "Unknown";

        const itemPaths = await this.dbHelper
            .getItemPaths([
                {
                    libraryID: item.libraryID,
                    key: item.key,
                    collections: item.collections,
                },
            ])
            .then((paths) => paths[`${item.libraryID}:${item.key}`] || []);

        const context = {
            ...buildItemMetadata(item),

            // Identity
            key: item.key,
            version: item.version,
            libraryID: item.libraryID,
            itemType: item.itemType,
            itemPaths: itemPaths,

            dateAdded: item.dateAdded,
            dateModified: item.dateModified,
            tags: item.raw?.data?.tags || [],

            // Derived
            libraryName,
        };

        // The same variables also sit under `item`, so `{{ item.title }}`
        // works here as it does in source-note and citation templates.
        const scope = sanitizeContext(context);
        const rendered = await renderLiquid(this.engine, template, {
            ...scope,
            item: scope,
        });
        return sanitizePath(rendered);
    }

    /** Resolve the vault path for a local attachment source note. */
    async resolveLocalNotePath(
        localAttachment: TFileWithoutParentAndVault,
        templateOverride?: string,
    ): Promise<string> {
        const template =
            templateOverride?.trim() ||
            this.settings.localSourceNotePathTemplate.trim() ||
            FALLBACK_LOCAL_TEMPLATE;

        const lastSlash = localAttachment.path.lastIndexOf("/");
        const directory =
            lastSlash !== -1
                ? localAttachment.path.substring(0, lastSlash)
                : "";

        const context = {
            basename: localAttachment.basename,
            name: localAttachment.name,
            path: localAttachment.path,
            directory,
            extension: localAttachment.extension,
        };

        const rendered = await renderLiquid(
            this.engine,
            template,
            sanitizeContext(context),
        );
        return sanitizePath(rendered);
    }

    /** Preview the resolved path for a library item with a custom path template. */
    async previewLibraryNotePath(
        libraryID: number,
        key: string,
        pathTemplate: string,
    ): Promise<string> {
        const item = await db.items.get([libraryID, key]);
        if (!item) {
            throw new ZotFlowError(
                ZotFlowErrorCode.RESOURCE_MISSING,
                "NotePathService",
                `Item not found: ${libraryID}/${key}`,
            );
        }
        return this.resolveLibraryNotePath(item, pathTemplate);
    }

    /** Preview the resolved path for a local file with a custom path template. */
    async previewLocalNotePath(
        file: TFileWithoutParentAndVault,
        pathTemplate: string,
    ): Promise<string> {
        return this.resolveLocalNotePath(file, pathTemplate);
    }

    /** Return the current path template string from settings. */
    getDefaultPathTemplate(mode: "library" | "local"): string {
        return mode === "library"
            ? this.settings.librarySourceNotePathTemplate
            : this.settings.localSourceNotePathTemplate;
    }
}
