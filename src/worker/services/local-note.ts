import type { IParentProxy } from "bridge/types";
import type { ZotFlowSettings } from "settings/types";
import type { LocalTemplateService } from "./local-template";
import type { NotePathService } from "./note-path";
import type { AnnotationJSON } from "types/zotero-reader";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import { errorMessage, ZotFlowError, ZotFlowErrorCode } from "utils/error";
import { templateFilePath } from "utils/utils";
import {
    workerClearTimeout,
    workerSetTimeout,
    type WorkerTimeout,
} from "worker/timers";
import {
    extractPersistRegions,
    reinsertPersistRegions,
    type PersistExtract,
} from "utils/persist-regions";

// Legacy regex patterns kept for migration fallback
const OZRP_REGEX =
    /%% OZRP-ANNO-BEGIN\s*({[\s\S]*?})\s*%%[\s\S]*?%% OZRP-ANNO-END %%/g;
const ZOTFLOW_REGEX =
    /%% ZOTFLOW_ANNO_(\w+)_BEG\s*([\s\S]*?)\s*%%[\s\S]*?%% ZOTFLOW_ANNO_\1_END %%/g;

/** CRUD service for local vault file notes (PDF/EPUB opened locally). */
export class LocalNoteService {
    private debouncers: Map<string, WorkerTimeout> = new Map();

    // Notes that gained orphaned persist regions since the last Notice
    // (same aggregation pattern as LibraryNoteService).
    private orphanReports: Map<string, string[]> = new Map();
    private orphanNoticeTimer: WorkerTimeout | null = null;

    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
        private templateService: LocalTemplateService,
        private notePathService: NotePathService,
    ) {}

    public updateSettings(settings: ZotFlowSettings) {
        this.settings = settings;
        this.templateService.updateSettings(settings);
        this.notePathService.updateSettings(settings);
    }

    /**
     * Clear all pending debounced operations.
     */
    public dispose() {
        for (const timer of this.debouncers.values()) {
            workerClearTimeout(timer);
        }
        this.debouncers.clear();
        if (this.orphanNoticeTimer !== null) {
            workerClearTimeout(this.orphanNoticeTimer);
            this.orphanNoticeTimer = null;
        }
    }

    /**
     * Record newly orphaned persist regions for a note and schedule a
     * single debounced summary Notice covering the whole update cycle.
     */
    private reportNewOrphans(path: string, orphanIds: string[]) {
        this.parentHost.log(
            "warn",
            `Persist region(s) orphaned in ${path}: ${orphanIds.join(", ")} — content moved to the "Orphaned persist regions" section`,
            "LocalNoteService",
        );
        this.orphanReports.set(path, orphanIds);

        if (this.orphanNoticeTimer !== null) {
            workerClearTimeout(this.orphanNoticeTimer);
        }
        this.orphanNoticeTimer = workerSetTimeout(() => {
            this.orphanNoticeTimer = null;
            const noteCount = this.orphanReports.size;
            this.orphanReports.clear();
            if (noteCount === 0) return;
            this.parentHost.notify(
                "warning",
                `${noteCount} note(s) have orphaned persist regions — content was preserved at the bottom of each note (see log)`,
            );
        }, 2000);
    }

    /**
     * ============================================================
     * Public API
     * ============================================================
     */

    /**
     * Open note (core entry point)
     * Automatically find or create note -> Open file in Obsidian
     */
    async openNote(
        localAttachment: TFileWithoutParentAndVault,
        annotations: AnnotationJSON[] = [],
    ) {
        try {
            const result =
                await this.parentHost.getLinkedLocalSourceNote(localAttachment);

            if (result) {
                this.parentHost.log(
                    "info",
                    `Opening existing note: ${result.path}`,
                    "LocalNoteService",
                );
                await this.parentHost.openFile(result.path, true);
            } else {
                this.parentHost.log(
                    "info",
                    `Note not found, creating new for: ${localAttachment.basename}`,
                    "LocalNoteService",
                );
                const path = await this.performCreate(
                    localAttachment,
                    annotations,
                );
                await this.parentHost.openFile(path, true);
            }
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.FILE_OPEN_FAILED,
                "LocalNoteService",
                `Failed to open note: ${(e as Error).message}`,
            );
        }
    }

    /**
     * Trigger note re-render (for explicit refresh or initial creation).
     */
    async triggerUpdate(
        localAttachment: TFileWithoutParentAndVault,
        annotations: AnnotationJSON[],
        debounce: boolean = false,
    ) {
        // Immediate execution
        if (!debounce) {
            try {
                return await this.ensureNote(localAttachment, annotations);
            } catch (e) {
                throw ZotFlowError.wrap(
                    e,
                    ZotFlowErrorCode.FILE_WRITE_FAILED,
                    "LocalNoteService",
                    `Immediate update failed: ${(e as Error).message}`,
                );
            }
        }

        // Debounced execution
        const debounceId = localAttachment.path;
        if (this.debouncers.has(debounceId)) {
            workerClearTimeout(this.debouncers.get(debounceId));
            this.debouncers.delete(debounceId);
        }

        const run = async () => {
            this.debouncers.delete(debounceId);
            try {
                await this.ensureNote(localAttachment, annotations);
            } catch (e) {
                this.parentHost.log(
                    "error",
                    "Debounced update failed: " + errorMessage(e),
                    "LocalNoteService",
                    e,
                );
            }
        };
        // The body handles its own failures, so the promise is deliberately
        // not awaited by the timer.
        const timer = workerSetTimeout(() => void run(), 2000);

        this.debouncers.set(debounceId, timer);
    }

    /**
     * Save annotation image asset
     */
    async saveBase64Image(image: string, annotationKey: string) {
        try {
            const base64 = image.split(",")[1]!;
            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            const folder = this.settings.annotationImageFolder.replace(
                /\/$/,
                "",
            );
            const path = `${folder}/${annotationKey}.png`;

            await this.parentHost.writeBinaryFile(path, bytes.buffer);
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.FILE_WRITE_FAILED,
                "LocalNoteService",
                `Failed to save image ${annotationKey}: ${(e as Error).message}`,
            );
        }
    }

    /**
     * Clean up orphaned annotation images
     */
    async deleteAnnotationImage(annotationKey: string) {
        try {
            const filename = `${annotationKey}.png`;
            const folder = this.settings.annotationImageFolder.replace(
                /\/$/,
                "",
            );
            const path = `${folder}/${filename}`;

            const exists = await this.parentHost.checkFile(path);
            if (exists.exists) {
                await this.parentHost.deleteFile(path);
            }
        } catch (e) {
            throw ZotFlowError.wrap(
                e,
                ZotFlowErrorCode.FILE_WRITE_FAILED,
                "LocalNoteService",
                `Failed to delete image ${annotationKey}: ${errorMessage(e)}`,
            );
        }
    }

    /**
     * ============================================================
     * Legacy Annotation Parsing (migration support)
     * ============================================================
     */

    /**
     * Parse annotations from inline Obsidian comments in the source note.
     * Supports both OZRP and ZOTFLOW legacy formats.
     * Called from main thread as a fallback when no `.zf.json` file exists.
     */
    async parseLegacyAnnotations(
        localAttachment: TFileWithoutParentAndVault,
    ): Promise<AnnotationJSON[]> {
        const annotations: AnnotationJSON[] = [];

        try {
            const notePath =
                await this.parentHost.getLinkedLocalSourceNote(localAttachment);
            if (!notePath) return annotations;

            const note = await this.parentHost.readTextFile(notePath.path);
            if (!note) return annotations;

            // Reset regex indices
            OZRP_REGEX.lastIndex = 0;
            ZOTFLOW_REGEX.lastIndex = 0;

            // Parse OZRP format (Legacy)
            let match;
            while ((match = OZRP_REGEX.exec(note)) !== null) {
                try {
                    const fullBlock = match[0];
                    const jsonStr = match[1]!;
                    const ann = JSON.parse(jsonStr) as AnnotationJSON;

                    const quoteMatch =
                        /%% OZRP-ANNO-QUOTE-BEGIN %%([\s\S]*?)[>\s]*%% OZRP-ANNO-QUOTE-END %%/.exec(
                            fullBlock,
                        );
                    if (quoteMatch && quoteMatch[1]) {
                        const rawQuote = quoteMatch[1];
                        ann.text = rawQuote
                            .split("\n")
                            .map((line: string) =>
                                line.replace(/^>\s*> ?/, "").trim(),
                            )
                            .filter((l: string) => l !== "")
                            .join("\n");
                    }

                    const commMatch =
                        /%% OZRP-ANNO-COMM-BEGIN %%([\s\S]*?)%% OZRP-ANNO-COMM-END %%/.exec(
                            fullBlock,
                        );
                    if (commMatch && commMatch[1]) {
                        const rawComm = commMatch[1];
                        ann.comment = rawComm
                            .split("\n")
                            .map((line: string) =>
                                line.replace(/^> ?/, "").trim(),
                            )
                            .filter((l: string) => l !== "")
                            .join("\n");
                    }

                    annotations.push(ann);
                } catch (e) {
                    this.parentHost.log(
                        "warn",
                        "Failed to parse OZRP annotation",
                        "LocalNoteService",
                        e,
                    );
                }
            }

            // Parse ZotFlow format
            while ((match = ZOTFLOW_REGEX.exec(note)) !== null) {
                try {
                    const jsonStr = match[2]!;
                    const decodedJsonStr = decodeURIComponent(jsonStr);
                    const ann = JSON.parse(decodedJsonStr) as AnnotationJSON;
                    annotations.push(ann);
                } catch (e) {
                    this.parentHost.log(
                        "warn",
                        "Failed to parse ZotFlow annotation",
                        "LocalNoteService",
                        e,
                    );
                }
            }
        } catch (e) {
            this.parentHost.log(
                "error",
                "Error parsing legacy annotations",
                "LocalNoteService",
                e,
            );
        }

        return annotations;
    }

    /**
     * ============================================================
     * Core Logic (Flow Control)
     * ============================================================
     */

    /**
     * Core logic: Ensure note is ready
     * Responsible for routing logic: Index lookup -> Default path fallback -> Existence check -> Create/Update
     */
    private async ensureNote(
        localAttachment: TFileWithoutParentAndVault,
        annotations: AnnotationJSON[],
    ) {
        const notePath =
            await this.parentHost.getLinkedLocalSourceNote(localAttachment);

        if (notePath) {
            const fileCheck = await this.parentHost.checkFile(notePath.path);

            // Case A: File exists -> Update
            await this.performUpdate(localAttachment, annotations, fileCheck);
        } else {
            // Case B: Linked but missing file -> Re-create or warn?
            // Currently treating as "Create new" logic would be complex due to linking.
            // For now, let's treat it as a broken link and create new at default location.
            this.parentHost.log(
                "info",
                `Linked note for ${localAttachment.basename} missing. Creating new.`,
                "LocalNoteService",
            );
            await this.performCreate(localAttachment, annotations);
        }
    }

    /**
     * ============================================================
     * Execution Helpers
     * ============================================================
     */

    private async performCreate(
        localAttachment: TFileWithoutParentAndVault,
        annotations: AnnotationJSON[],
    ): Promise<string> {
        // Resolve path from template
        let notePath =
            await this.notePathService.resolveLocalNotePath(localAttachment);
        const baseName = notePath.replace(/\.md$/, "");

        // Check duplicate and resolve naming collision
        let fileCheck = await this.parentHost.checkFile(notePath);
        let counter = 1;
        const maxRetries = 100; // Safety break

        while (fileCheck.exists && counter < maxRetries) {
            notePath = `${baseName} (${counter}).md`;
            fileCheck = await this.parentHost.checkFile(notePath);
            counter++;
        }

        if (counter >= maxRetries) {
            throw new ZotFlowError(
                ZotFlowErrorCode.FILE_WRITE_FAILED,
                "LocalNoteService",
                `Failed to find unique filename for ${baseName} after ${maxRetries} attempts.`,
            );
        }

        // Render and Write
        const templateContent = await this.parentHost.readTextFile(
            templateFilePath(
                this.settings.localSourceNoteTemplatePath,
            ),
        );

        const content = await this.templateService.renderLocalNote(
            localAttachment,
            annotations,
            templateContent,
            {},
        );

        // No old content on create, but still validate the render's persist
        // markers (throws on template errors; a no-op splice otherwise).
        const spliced = reinsertPersistRegions(content, {
            regions: [],
            orphanSectionInner: null,
        });

        await this.parentHost.writeTextFile(notePath, spliced.content);
        this.parentHost.log(
            "info",
            `Created note: ${notePath}`,
            "LocalNoteService",
        );

        return notePath;
    }

    private async performUpdate(
        localAttachment: TFileWithoutParentAndVault,
        annotations: AnnotationJSON[],
        fileCheck: Awaited<ReturnType<IParentProxy["checkFile"]>>,
    ) {
        // Persist regions: pull user-owned blocks out of the current file
        // before the full-content overwrite. A parse failure refuses the
        // update — the file stays untouched until the user repairs it.
        const oldContent = await this.parentHost.readTextFile(fileCheck.path);
        if (oldContent === null || oldContent === undefined) {
            throw new ZotFlowError(
                ZotFlowErrorCode.FILE_OPEN_FAILED,
                "LocalNoteService",
                `Could not read ${fileCheck.path} before update — refused to overwrite blindly`,
            );
        }

        let extracted: PersistExtract;
        try {
            extracted = extractPersistRegions(oldContent);
        } catch (e) {
            throw new ZotFlowError(
                ZotFlowErrorCode.PARSE_ERROR,
                "LocalNoteService",
                `Invalid persist markers in ${fileCheck.path}: ${(e as Error).message}. Update refused until the file is fixed.`,
                { cause: e, path: fileCheck.path },
            );
        }

        const templateContent = await this.parentHost.readTextFile(
            templateFilePath(
                this.settings.localSourceNoteTemplatePath,
            ),
        );
        const content = await this.templateService.renderLocalNote(
            localAttachment,
            annotations,
            templateContent,
            fileCheck.frontmatter || {},
        );

        const spliced = reinsertPersistRegions(content, extracted);

        await this.parentHost.writeTextFile(fileCheck.path, spliced.content);

        if (spliced.newOrphans.length > 0) {
            this.reportNewOrphans(
                fileCheck.path,
                spliced.newOrphans.map((o) => o.id),
            );
        }

        this.parentHost.log(
            "info",
            `Updated note: ${fileCheck.path}`,
            "LocalNoteService",
        );
    }
}
