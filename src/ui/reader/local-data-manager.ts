import { TFile } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { readTextFile, saveTextFile, checkFile } from "utils/file";
import { getLocalSidecarPath } from "utils/utils";

import type { AnnotationJSON } from "types/zotero-reader";

/** Shape of the `.zf.json` sidecar file. */
interface ZotFlowSidecarData {
    version: number;
    annotations: AnnotationJSON[];
}

/** Current sidecar file format version. */
const SIDECAR_VERSION = 1;

/**
 * Manages all per-attachment data for local vault files opened in the reader:
 * annotations (in-memory cache + direct .zf.json file I/O).
 *
 * Annotation data is stored in a sidecar `.zf.json` file co-located with
 * the attachment (e.g., `Papers/myPaper.pdf` → `Papers/myPaper.zf.json`).
 */
export class LocalDataManager {
    private annotationCache: Map<string, AnnotationJSON> = new Map();

    constructor(private localAttachmentFile: TFile) {}

    /* ================================================================ */
    /*  Annotations                                                    */
    /* ================================================================ */

    /**
     * Load annotations for this attachment.
     *
     * Priority:
     * 1. Read from sidecar `.zf.json` (new format, direct main-thread I/O)
     * 2. Fall back to worker-side legacy parsing of inline comments
     *    — if found, auto-migrate to `.zf.json`
     */
    async loadAnnotations(): Promise<AnnotationJSON[]> {
        try {
            // Try sidecar JSON first (direct main-thread read)
            const jsonPath = this.getJsonPath();
            const fileResult = await checkFile(services.app, jsonPath);

            if (fileResult.exists) {
                const content = await readTextFile(services.app, jsonPath);
                if (content) {
                    const parsed: unknown = JSON.parse(content);
                    const annotations = this.extractAnnotations(
                        parsed,
                        jsonPath,
                    );
                    if (annotations) {
                        this.rebuildCache(annotations);
                        return this.getAllAnnotations();
                    }
                }
            }

            // Fallback: ask worker to parse legacy inline annotations
            const localAttachment = this.getLocalAttachmentDescriptor();
            const legacyAnnotations =
                await workerBridge.localNote.parseLegacyAnnotations(
                    localAttachment,
                );

            if (legacyAnnotations.length > 0) {
                // Auto-migrate: save to .zf.json on main thread
                services.logService.info(
                    `Migrating ${legacyAnnotations.length} legacy annotations to .zf.json for ${this.localAttachmentFile.basename}`,
                    "LocalDataManager",
                );
                await this.writeJsonFile(legacyAnnotations);
            }

            this.rebuildCache(legacyAnnotations);
            return this.getAllAnnotations();
        } catch (error) {
            services.logService.error(
                "Failed to load annotations",
                "LocalDataManager",
                error,
            );
            services.notificationService.notify(
                "error",
                "Could not load annotations.",
            );
            return [];
        }
    }

    /** Get all cached annotations. */
    getAllAnnotations(): AnnotationJSON[] {
        return Array.from(this.annotationCache.values());
    }

    /** Get a single cached annotation by ID. */
    getAnnotation(id: string): AnnotationJSON | undefined {
        return this.annotationCache.get(id);
    }

    /** Save/update an annotation and persist to .zf.json. */
    async saveAnnotation(annotation: AnnotationJSON) {
        this.annotationCache.set(annotation.id, annotation);
        await this.persistAnnotations();
    }

    /** Delete an annotation and persist to .zf.json. */
    async deleteAnnotation(annotationId: string) {
        this.annotationCache.delete(annotationId);
        await this.persistAnnotations();
    }

    /* ================================================================ */
    /*  Private helpers                                                */
    /* ================================================================ */

    /**
     * Derive the sidecar JSON path from the attachment file.
     * Honors the `localSidecarFolder` setting; defaults to next-to-attachment.
     */
    private getJsonPath(): string {
        return getLocalSidecarPath(
            this.localAttachmentFile.path,
            services.settings.localSidecarFolder,
        );
    }

    private getLocalAttachmentDescriptor() {
        return {
            path: this.localAttachmentFile.path,
            name: this.localAttachmentFile.name,
            extension: this.localAttachmentFile.extension,
            basename: this.localAttachmentFile.basename,
        };
    }

    /** Replace the in-memory cache with the given annotations. */
    private rebuildCache(annotations: AnnotationJSON[]) {
        this.annotationCache.clear();
        for (const anno of annotations) {
            this.annotationCache.set(anno.id, anno);
        }
    }

    /**
     * Persist annotation cache to the sidecar `.zf.json` file,
     * then trigger a note re-render via the worker.
     */
    private async persistAnnotations() {
        const allAnnotations = this.getAllAnnotations();
        const localAttachment = this.getLocalAttachmentDescriptor();

        try {
            await this.writeJsonFile(allAnnotations);
        } catch (err) {
            services.logService.error(
                "Failed to save annotations",
                "LocalDataManager",
                err,
            );
        }

        // Also update the source note (via worker, since it uses LiquidJS templates)
        workerBridge.localNote
            .triggerUpdate(localAttachment, allAnnotations)
            .catch((err) => {
                services.logService.error(
                    "Failed to update source note",
                    "LocalDataManager",
                    err,
                );
            });
    }

    /** Write structured sidecar data to the .zf.json file. */
    private async writeJsonFile(annotations: AnnotationJSON[]) {
        const jsonPath = this.getJsonPath();

        // Strip 'image' fields (base64 data)
        const cleanedAnnotations = annotations.map((anno) => {
            const { image, ...rest } = anno;
            return rest;
        });

        const data: ZotFlowSidecarData = {
            version: SIDECAR_VERSION,
            annotations: cleanedAnnotations,
        };

        let content = JSON.stringify(data, null, 2);

        // Compact numeric arrays (e.g. paths, rects) to take less space
        content = content.replace(/\[[\s\d.,-]+\]/g, (match) =>
            match.replace(/\s+/g, " "),
        );

        await saveTextFile(services.app, jsonPath, content);
    }

    /**
     * Extract annotations from parsed JSON.
     * Supports the structured envelope `{ version, annotations }` format.
     * Returns null if the shape is unrecognized.
     */
    private extractAnnotations(
        parsed: unknown,
        jsonPath: string,
    ): AnnotationJSON[] | null {
        // Structured envelope format: { version, annotations }
        if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            "annotations" in parsed
        ) {
            const data = parsed as ZotFlowSidecarData;
            if (Array.isArray(data.annotations)) {
                return data.annotations;
            }
        }

        services.logService.warn(
            `Unrecognized .zf.json format: ${jsonPath}`,
            "LocalDataManager",
        );
        return null;
    }
}
