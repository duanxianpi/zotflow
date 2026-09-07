import type { PackLease } from "enhancement-pack/types";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import type { NotificationType } from "services/notification-service";
import type { LogLevel } from "services/log-service";

import type { ITaskInfo } from "types/tasks";
import type { RequestUrlParam } from "obsidian";

/** Shape of an HTTP response proxied from main thread to worker. */
export interface IRequestResponse {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
}

/** Metadata used to identify one snapshot of an external OS file. */
export interface ExternalFileStat {
    mtime: number;
    size: number;
}

/** Contract for all operations the worker can invoke on the main thread. */
/** The subset of Obsidian's undocumented vault config ZotFlow reads. */
export interface VaultConfig {
    strictLineBreaks?: boolean;
}

export interface IParentProxy {
    acquireEnhancementSdtResources(): Promise<PackLease>;
    releaseEnhancementResources(leaseId: string): Promise<void>;
    notify(type: NotificationType, message: string): void;
    log(
        level: LogLevel,
        message: string,
        context?: string,
        details?: unknown,
    ): void;
    request(request: RequestUrlParam): Promise<IRequestResponse>;

    // Platform
    isAndroidApp(): Promise<boolean>;
    isDesktopApp(): Promise<boolean>;

    // Filesystem
    readTextFile(path: string): Promise<string | null>;
    writeTextFile(path: string, content: string): Promise<void>;
    writeBinaryFile(path: string, buffer: ArrayBuffer): Promise<void>;
    checkFile(path: string): Promise<{
        exists: boolean;
        path: string;
        frontmatter?: Record<string, unknown>;
    }>;
    deleteFile(path: string): Promise<void>;
    readExternalBinaryFile(absolutePath: string): Promise<ArrayBuffer>;
    statExternalFile(absolutePath: string): Promise<ExternalFileStat>;
    openFile(path: string, newLeaf: boolean): Promise<void>;

    // Index
    getFileByKey(key: string): Promise<string | null>;
    indexFile(path: string): Promise<void>;

    // Utils
    getVaultConfig(): Promise<VaultConfig>;
    parseYaml(text: string): Promise<Record<string, unknown>>;
    stringifyYaml(obj: unknown): Promise<string>;
    joinPath(...segments: string[]): Promise<string>;
    getLinkedLocalSourceNote(
        file: TFileWithoutParentAndVault,
    ): Promise<TFileWithoutParentAndVault | null>;

    // Tasks
    onTaskUpdate(taskId: string, info: ITaskInfo): void;

    // Events
    onAnnotationChanged(
        libraryID: number,
        annotationKey: string,
        parentItemKey: string,
    ): void;

    onNoteChangedByEditor(
        libraryID: number,
        noteKey: string,
        parentItemKey: string,
    ): void;

    onNoteChangedByNoteView(
        libraryID: number,
        noteKey: string,
        parentItemKey: string,
    ): void;
}
