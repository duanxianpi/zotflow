import * as Comlink from "comlink";
import {
    requestUrl,
    App,
    TFile,
    normalizePath,
    MarkdownView,
    parseYaml,
    stringifyYaml,
    Platform,
} from "obsidian";
import {
    saveTextFile,
    saveBinaryFile,
    readTextFile,
    checkFile,
    deleteFile,
    getLinkedLocalSourceNote,
} from "utils/file";
import type { ExternalFileStat, VaultConfig } from "bridge/types";
import { services } from "services/services";
import { errorMessage as describeError } from "utils/error";

import type { IParentProxy, IRequestResponse } from "./types";
import type { RequestUrlParam } from "obsidian";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import type { NotificationType } from "services/notification-service";
import type { LogLevel } from "services/log-service";
import type { ITaskInfo } from "types/tasks";

/** Main-thread API exposed to the Worker via Comlink for filesystem, network, logging, and UI operations. */
export class ParentHost implements IParentProxy {
    constructor(private app: App) {}

    async acquireEnhancementSdtResources() {
        return services.enhancementPack.acquireSdtResources();
    }
    async releaseEnhancementResources(leaseId: string) {
        services.enhancementPack.release(leaseId);
    }

    public notify(type: NotificationType, message: string) {
        services.notificationService.notify(type, message);
    }

    public log(
        level: LogLevel,
        message: string,
        context?: string,
        details?: unknown,
    ) {
        services.logService.log(level, message, context, details);
    }

    public async request(request: RequestUrlParam): Promise<IRequestResponse> {
        try {
            const response = await requestUrl(request);
            const buffer = response.arrayBuffer;
            return Comlink.transfer(
                {
                    status: response.status,
                    headers: response.headers,
                    arrayBuffer: buffer,
                },
                [buffer],
            );
        } catch (error) {
            const reason = describeError(error);
            services.logService.error(`Fetch failed: ${reason}`, "ParentHost");
            throw new Error(`Network Error: ${reason}`);
        }
    }

    public async isAndroidApp(): Promise<boolean> {
        return Platform.isAndroidApp;
    }

    public async isDesktopApp(): Promise<boolean> {
        return Platform.isDesktopApp;
    }

    public async readTextFile(path: string): Promise<string | null> {
        return readTextFile(this.app, path);
    }

    public async writeTextFile(path: string, content: string): Promise<void> {
        await saveTextFile(this.app, path, content);
    }

    public async writeBinaryFile(
        path: string,
        buffer: ArrayBuffer,
    ): Promise<void> {
        await saveBinaryFile(this.app, path, buffer);
    }

    public async checkFile(path: string): Promise<{
        exists: boolean;
        path: string;
        frontmatter?: Record<string, unknown>;
    }> {
        return checkFile(this.app, path);
    }

    public async openFile(path: string, newLeaf: boolean): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) {
            const leaves = this.app.workspace.getLeavesOfType("markdown");
            for (const leaf of leaves) {
                const view = leaf.view as MarkdownView;
                if (view.file && view.file.path === file.path) {
                    this.app.workspace.setActiveLeaf(leaf);
                    return;
                }
            }
            await this.app.workspace.getLeaf(newLeaf).openFile(file);
        }
    }

    public async getFileByKey(key: string): Promise<string | null> {
        await services.indexService.initializePromise;
        const file = services.indexService.getFileByKey(key);
        return file ? file.path : null;
    }

    public async indexFile(path: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) {
            services.indexService.indexFile(file);
        }
    }

    public async deleteFile(path: string): Promise<void> {
        await deleteFile(this.app, path);
    }

    public async readExternalBinaryFile(
        absolutePath: string,
    ): Promise<ArrayBuffer> {
        // Node's fs rather than FileSystemAdapter, which prepends the vault
        // path and so cannot open the absolute OS paths linked attachments
        // use. That confines the whole feature to desktop, where Node exists.
        if (!Platform.isDesktop) {
            throw new Error(
                `Cannot read a file outside the vault on mobile: ${absolutePath}`,
            );
        }
        if (!Platform.isDesktopApp) {
            throw new Error("External files require the Obsidian desktop app");
        }
        try {
            // `require`, not `import()`: the plugin ships as CommonJS, and a
            // native dynamic import in Electron's renderer resolves against
            // the page URL rather than Node's resolver, so it cannot find a
            // builtin. `typeof import(...)` is type-only and erases.
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
            const { promises: fs } = require("fs") as typeof import("fs");
            const nodeBuffer = await fs.readFile(absolutePath);
            const arrayBuffer = nodeBuffer.buffer.slice(
                nodeBuffer.byteOffset,
                nodeBuffer.byteOffset + nodeBuffer.byteLength,
            );
            return Comlink.transfer(arrayBuffer, [arrayBuffer]);
        } catch (e) {
            throw new Error(
                `Failed to read external file: ${describeError(e)}`,
            );
        }
    }

    public async statExternalFile(
        absolutePath: string,
    ): Promise<ExternalFileStat> {
        if (!Platform.isDesktop) {
            throw new Error(
                `Cannot stat a file outside the vault on mobile: ${absolutePath}`,
            );
        }
        if (!Platform.isDesktopApp) {
            throw new Error("External files require the Obsidian desktop app");
        }
        try {
            // Same CommonJS constraint as `readExternalBinaryFile`.
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- see readExternalBinaryFile
            const { promises: fs } = require("fs") as typeof import("fs");
            const stat = await fs.stat(absolutePath);
            if (!stat.isFile()) {
                throw new Error("Path does not identify a file");
            }
            return { mtime: stat.mtimeMs, size: stat.size };
        } catch (e) {
            throw new Error(
                `Failed to stat external file: ${describeError(e)}`,
            );
        }
    }

    public async joinPath(...segments: string[]): Promise<string> {
        // Only ever joins an OS path for a linked attachment, so it shares
        // `readExternalBinaryFile`'s desktop-only constraint.
        if (!Platform.isDesktop) {
            throw new Error("Cannot resolve an OS path on mobile");
        }
        if (!Platform.isDesktopApp) {
            throw new Error("OS paths require the Obsidian desktop app");
        }
        // Same CommonJS constraint as `readExternalBinaryFile`.
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- see readExternalBinaryFile
        const path = require("path") as typeof import("path");
        return path.join(...segments);
    }

    public async getVaultConfig(): Promise<VaultConfig> {
        return { ...this.app.vault.config };
    }

    public async parseYaml(text: string): Promise<Record<string, unknown>> {
        // Obsidian types this `any`; frontmatter is always a mapping.
        return parseYaml(text) as Record<string, unknown>;
    }

    public async stringifyYaml(obj: unknown): Promise<string> {
        return stringifyYaml(obj);
    }

    public async getLinkedLocalSourceNote(
        file: TFileWithoutParentAndVault,
    ): Promise<TFileWithoutParentAndVault | null> {
        return getLinkedLocalSourceNote(this.app, file);
    }

    public onTaskUpdate(taskId: string, info: ITaskInfo): void {
        services.taskMonitor.onTaskUpdate(taskId, info);
    }

    public onAnnotationChanged(
        libraryID: number,
        annotationKey: string,
        parentItemKey: string,
    ): void {
        services.taskMonitor.annotationChanged.emit(
            libraryID,
            annotationKey,
            parentItemKey,
        );
    }

    public onNoteChangedByEditor(
        libraryID: number,
        noteKey: string,
        parentItemKey: string,
    ): void {
        services.taskMonitor.noteChangedByEditor.emit(
            libraryID,
            noteKey,
            parentItemKey,
        );
    }

    public onNoteChangedByNoteView(
        libraryID: number,
        noteKey: string,
        parentItemKey: string,
    ): void {
        services.taskMonitor.noteChangedByNoteView.emit(
            libraryID,
            noteKey,
            parentItemKey,
        );
    }
}
