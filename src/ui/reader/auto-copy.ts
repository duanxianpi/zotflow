import { services } from "services/services";
import { stripAnnotationForPayload } from "ui/editor/citation-helper";

import type { AnnotationJSON } from "types/zotero-reader";

/** Context required to resolve embed/citation strings for a single annotation. */
export interface AutoCopyContext {
    /** Path of the source note backing this attachment, if one exists. */
    sourceNotePath?: string;
    /** Parent Zotero item key (for cloud attachments). Undefined for local files. */
    parentItemKey?: string;
    /** Library ID (for cloud attachments). Undefined for local files. */
    libraryID?: number;
}

/**
 * Returns true when the annotation was just created (not edited).
 */
export function isNewlyCreated(annotation: AnnotationJSON): boolean {
    const created = annotation.dateCreated ?? annotation.dateAdded;
    return !!created && created === annotation.dateModified;
}

/**
 * Copy an embed link, plain text, or formatted citation to the system clipboard
 * for a freshly-created annotation, based on the `autoCopyAnnotation` setting.
 *
 * Never throws — clipboard failures are logged + surfaced as a warning notification.
 */
export async function copyAnnotationOnCreate(
    annotation: AnnotationJSON,
    ctx: AutoCopyContext,
): Promise<void> {
    const mode = services.settings.autoCopyAnnotation;
    if (!mode || mode === "off") return;

    try {
        if (mode === "embed") {
            if (!ctx.sourceNotePath) return;
            await navigator.clipboard.writeText(
                `![[${ctx.sourceNotePath}#^${annotation.id}]]`,
            );
            return;
        }

        if (mode === "text") {
            const text = annotation.text?.trim();
            if (!text) return;
            await navigator.clipboard.writeText(text);
            return;
        }

        if (mode === "citation") {
            // Citation mode requires a parent item. For local files without one,
            // fall back to embed if a source note exists.
            if (ctx.libraryID === undefined || !ctx.parentItemKey) {
                if (ctx.sourceNotePath) {
                    await navigator.clipboard.writeText(
                        `![[${ctx.sourceNotePath}#^${annotation.id}]]`,
                    );
                }
                return;
            }

            const result = await services.citationService.resolve(
                {
                    libraryID: ctx.libraryID,
                    key: ctx.parentItemKey,
                    annotations: [stripAnnotationForPayload(annotation)],
                },
                services.settings.defaultCitationFormat,
            );
            if (!result) return;
            let text = result.citation;
            if (result.footnoteDef) {
                text += "\n" + result.footnoteDef;
            }
            await navigator.clipboard.writeText(text);
        }
    } catch (e) {
        services.logService.error(
            "Failed to auto-copy annotation",
            "AutoCopyAnnotation",
            e,
        );
        services.notificationService.notify(
            "warning",
            "Failed to copy annotation to clipboard",
        );
    }
}
