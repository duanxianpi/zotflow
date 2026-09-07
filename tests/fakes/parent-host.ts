/**
 * Recording fake for `IParentProxy` — every call the worker makes back into
 * the main thread.
 *
 * Two kinds of method live on this interface: chatter (`log`, `notify`) and
 * real side effects (`writeTextFile`, `deleteFile`, …). The fake collects the
 * chatter into arrays for assertions and backs the side effects with an
 * in-memory vault, so a test can assert "sync wrote this note and deleted that
 * one" without touching a disk.
 *
 * Anything a test has not opted into throws rather than silently returning a
 * default — a service quietly depending on `readExternalBinaryFile` should
 * fail loudly, not read `undefined`.
 */
import type { IParentProxy, IRequestResponse, VaultConfig } from "bridge/types";
import type { LogLevel } from "services/log-service";
import type { NotificationType } from "services/notification-service";
import type { ITaskInfo } from "types/tasks";
import type { TFileWithoutParentAndVault } from "types/zotflow";

export interface LogRecord {
    level: LogLevel;
    message: string;
    context?: string;
    details?: unknown;
}

export interface NoticeRecord {
    type: NotificationType;
    message: string;
}

export interface EventRecord {
    name:
        | "onAnnotationChanged"
        | "onNoteChangedByEditor"
        | "onNoteChangedByNoteView";
    args: unknown[];
}

export interface FakeParentHost extends IParentProxy {
    /** Every `log()` call, in order. */
    logs: LogRecord[];
    /** Every `notify()` call, in order. */
    notices: NoticeRecord[];
    /** In-memory vault: path → text content. */
    vault: Map<string, string>;
    /** In-memory vault for binary writes. */
    binaryVault: Map<string, ArrayBuffer>;
    /** Frontmatter served by `checkFile`, keyed by path. */
    frontmatter: Map<string, Record<string, unknown>>;
    /** Backing store for `getFileByKey`: zotero key → vault path. */
    keyIndex: Map<string, string>;
    /** Paths passed to `indexFile`, in order. */
    indexed: string[];
    /** Paths passed to `openFile`, in order. */
    opened: string[];
    /** Every `onTaskUpdate` call, in order. */
    taskUpdates: { taskId: string; info: ITaskInfo }[];
    /** Annotation/note change events emitted back to the main thread. */
    events: EventRecord[];

    /** Convenience filter, e.g. `host.logsAt("error")`. */
    logsAt(level: LogLevel): LogRecord[];
    /** Clear all recordings without dropping configured vault contents. */
    clearRecordings(): void;
}

export interface FakeParentHostOptions {
    /** Pre-populate the vault: path → content. */
    files?: Record<string, string>;
    /** Pre-populate frontmatter returned by `checkFile`. */
    frontmatter?: Record<string, Record<string, unknown>>;
    /** Pre-populate the key → path index used by `getFileByKey`. */
    keyIndex?: Record<string, string>;
    /** Value returned by `isAndroidApp()`. Defaults to false. */
    isAndroid?: boolean;
    /** Value returned by `isDesktopApp()`. Defaults to the inverse of `isAndroid`. */
    isDesktop?: boolean;
    /** Value returned by `getVaultConfig()`. Defaults to `{}`. */
    vaultConfig?: VaultConfig;
    /** Handler for `request()`. Unset means any HTTP call throws. */
    request?: (url: unknown) => Promise<IRequestResponse>;
}

function unsupported(name: string): never {
    throw new Error(
        `FakeParentHost.${name}() was called but no behaviour was configured for it. ` +
            `Pass an option to createFakeParentHost() if the code under test needs it.`,
    );
}

/**
 * Minimal flat-YAML support, enough for note frontmatter (`key: value` and
 * `- item` lists). Nested maps are NOT supported — a test needing them should
 * stub `parseYaml` directly rather than grow this.
 */
function parseFlatYaml(text: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let currentListKey: string | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
        if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

        const listMatch = /^\s*-\s+(.*)$/.exec(rawLine);
        if (listMatch && currentListKey) {
            (out[currentListKey] as unknown[]).push(
                coerceScalar(listMatch[1]!.trim()),
            );
            continue;
        }

        const pairMatch = /^([^:]+):\s*(.*)$/.exec(rawLine);
        if (!pairMatch) continue;

        const key = pairMatch[1]!.trim();
        const value = pairMatch[2]!.trim();
        if (value === "") {
            out[key] = [];
            currentListKey = key;
        } else {
            out[key] = coerceScalar(value);
            currentListKey = null;
        }
    }
    return out;
}

function coerceScalar(value: string): unknown {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return value.slice(1, -1);
    }
    return value;
}

function stringifyFlatYaml(obj: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
            lines.push(`${key}:`);
            for (const entry of value) lines.push(`  - ${String(entry)}`);
        } else {
            lines.push(`${key}: ${String(value)}`);
        }
    }
    return lines.join("\n") + "\n";
}

export function createFakeParentHost(
    options: FakeParentHostOptions = {},
): FakeParentHost {
    const logs: LogRecord[] = [];
    const notices: NoticeRecord[] = [];
    const vault = new Map(Object.entries(options.files ?? {}));
    const binaryVault = new Map<string, ArrayBuffer>();
    const frontmatter = new Map(Object.entries(options.frontmatter ?? {}));
    const keyIndex = new Map(Object.entries(options.keyIndex ?? {}));
    const indexed: string[] = [];
    const opened: string[] = [];
    const taskUpdates: { taskId: string; info: ITaskInfo }[] = [];
    const events: EventRecord[] = [];

    const host: FakeParentHost = {
        logs,
        notices,
        vault,
        binaryVault,
        frontmatter,
        keyIndex,
        indexed,
        opened,
        taskUpdates,
        events,

        logsAt: (level) => logs.filter((l) => l.level === level),
        clearRecordings() {
            logs.length = 0;
            notices.length = 0;
            indexed.length = 0;
            opened.length = 0;
            taskUpdates.length = 0;
            events.length = 0;
        },

        notify(type, message) {
            notices.push({ type, message });
        },
        log(level, message, context, details) {
            logs.push({ level, message, context, details });
        },
        // async so an unconfigured call rejects rather than throwing
        // synchronously — the real proxy is always promise-returning.
        async request(request) {
            if (!options.request) return unsupported("request");
            return options.request(request);
        },

        acquireEnhancementSdtResources: async () =>
            unsupported("acquireEnhancementSdtResources"),
        releaseEnhancementResources: async () =>
            unsupported("releaseEnhancementResources"),

        // Platform
        isAndroidApp: async () => options.isAndroid ?? false,
        isDesktopApp: async () =>
            options.isDesktop ?? !(options.isAndroid ?? false),

        // Filesystem
        readTextFile: async (path) => vault.get(path) ?? null,
        writeTextFile: async (path, content) => {
            vault.set(path, content);
        },
        writeBinaryFile: async (path, buffer) => {
            binaryVault.set(path, buffer);
        },
        checkFile: async (path) => ({
            exists: vault.has(path) || binaryVault.has(path),
            path,
            frontmatter: frontmatter.get(path),
        }),
        deleteFile: async (path) => {
            vault.delete(path);
            binaryVault.delete(path);
        },
        readExternalBinaryFile: async () =>
            unsupported("readExternalBinaryFile"),
        statExternalFile: async () => unsupported("statExternalFile"),
        openFile: async (path) => {
            opened.push(path);
        },

        // Index
        getFileByKey: async (key) => keyIndex.get(key) ?? null,
        indexFile: async (path) => {
            indexed.push(path);
        },

        // Utils
        getVaultConfig: async () => options.vaultConfig ?? {},
        parseYaml: async (text) => parseFlatYaml(text),
        stringifyYaml: async (obj) =>
            stringifyFlatYaml(obj as Record<string, unknown>),
        joinPath: async (...segments) =>
            segments
                .filter((s) => s !== "" && s !== undefined && s !== null)
                .join("/")
                .replace(/\/+/g, "/"),
        getLinkedLocalSourceNote:
            async (): Promise<TFileWithoutParentAndVault | null> => null,

        // Tasks
        onTaskUpdate(taskId, info) {
            taskUpdates.push({ taskId, info });
        },

        // Events
        onAnnotationChanged(...args) {
            events.push({ name: "onAnnotationChanged", args });
        },
        onNoteChangedByEditor(...args) {
            events.push({ name: "onNoteChangedByEditor", args });
        },
        onNoteChangedByNoteView(...args) {
            events.push({ name: "onNoteChangedByNoteView", args });
        },
    };

    return host;
}
