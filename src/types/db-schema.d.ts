import {
    ZoteroCollection,
    ZoteroGroup,
    ZoteroItem,
    ZoteroKey,
    ZoteroLibrary,
} from "./zotero";
import { ZoteroItemData, ZoteroItemDataTypeMap } from "./zotero-item";

/** Key-value cache entry for the CSL renderer (styles, locales, index). */
export interface IDBCslCacheEntry {
    key: string;
    value: string;
}

/** Stored Zotero API key with associated group membership. */
export interface IDBZoteroKey extends ZoteroKey {
    joinedGroups: number[]; // Array of Group IDs the key has access to
}

/**
 * Stored Zotero group library metadata. Named separately from `ZoteroGroup`
 * because it is the table's row type, but it adds nothing to it today — the
 * other stored types carry sync bookkeeping the server payload has no room for.
 */
export type IDBZoteroGroup = ZoteroGroup;

/** Stored Zotero library with sync version tracking. */
export interface IDBZoteroLibrary extends ZoteroLibrary {
    collectionVersion?: number; // For collection sync, indicates the global version of the library
    itemVersion?: number; // For item sync, indicates the global version of the library
    /**
     * Set when an object-level 404/412 showed that local versions cannot be
     * trusted; the next sync compares every object with the server.
     */
    needsFullSync?: boolean;

    syncedAt: string; // ISO String of last successful sync
}

/** Stored Zotero collection with sync state and raw API payload. */
export interface IDBZoteroCollection {
    libraryID: number;
    key: string;
    version: number;
    name: string;
    parentCollection: string;
    trashed: 0 | 1; // Whether the collection is trashed

    // Sync State
    syncStatus: "synced" | "created" | "updated" | "deleted" | "conflict";
    syncedAt: string;
    syncError?: string;

    // Raw Payload
    raw: ZoteroCollection;
    serverCopyRaw?: ZoteroCollection;
}

/** An item's sync state as the tree view and counts see it (derived). */
export type ItemSyncStatus = "synced" | "created" | "updated" | "ignore" | "conflict";

/** Internal stored Zotero item with indexed fields and sync state. */
interface _IDBZoteroItem<T extends ZoteroItemData> {
    // Core Zotero Data
    libraryID: number; // Library ID (User or Group ID)
    key: string; // Zotero Item Key (8 chars)

    // Core Indexed Fields
    itemType: T["itemType"]; // 'journalArticle', 'attachment', 'annotation', etc.
    parentItem: string; // Parent Item Key
    trashed: 0 | 1; // Whether the item is trashed

    // Sorting & Versioning
    title: string; // Title (normalized for sorting)
    collections: string[]; // Collection Key Array
    dateAdded: string; // ISO String
    dateModified: string; // ISO String (Zotero Cloud's last modified time)
    version: number; // Zotero Cloud Version (for optimistic locking)

    // Derived Fields for Search
    searchCreators: string[];
    searchTags: string[];

    // Sync State (see src/db/sync/commit.ts)
    /** 1 when `raw` is the server's data at `version`; 0 with unsynced local changes. */
    synced: 0 | 1;
    /** A ZotFlow-only row that never syncs (e.g. annotations extracted from a PDF). */
    localOnly?: boolean;
    /** Bumped by every local write on this device; lets sync notice edits made while it waited. */
    localRevision?: number;
    /**
     * Derived from `synced`, `version`, `localOnly` and the conflict table by
     * `commitKey`; indexed for the tree view and counts. Never written elsewhere.
     */
    syncStatus: ItemSyncStatus;
    syncedAt: string;

    // External Annotation Extraction Tracking
    externalAnnotationExtractionFileMD5?: string;

    // Annotation Image Version Tracking
    annotationImageVersion?: number;

    // Reader View State (persisted so the reader reopens at the same position)
    primaryViewState?: Record<string, unknown>;
    secondaryViewState?: Record<string, unknown>;

    // Citation Key
    citationKey?: string;

    // CSL-JSON payload from the Zotero API (include=data,csljson), consumed
    // by the citation/bibliography template filters. Non-indexed.
    csljson?: Record<string, unknown>;

    // lastAccessedAt
    lastAccessedAt?: string;

    // Raw Payload
    raw: ZoteroItem<T>;
}

/** Stored Zotero item, parameterized by item data type. */
export type IDBZoteroItem<T extends ZoteroItemData> = _IDBZoteroItem<T>;

/** Union of all possible `IDBZoteroItem<T>` instantiations. */
export type AnyIDBZoteroItem = {
    [K in keyof ZoteroItemDataTypeMap]: IDBZoteroItem<ZoteroItemDataTypeMap[K]>;
}[keyof ZoteroItemDataTypeMap];

/** Cached attachment file bytes with metadata for LRU eviction. */
export interface IDBZoteroFile {
    libraryID: number; // Library ID (User or Group ID)
    key: string; // Zotero Item Key (itemType='attachment')
    buffer: ArrayBuffer; // File bytes (stored inline as ArrayBuffer, not Blob — see AttachmentService for the WebKit/iPadOS rationale)
    mimeType: string;
    fileName: string;
    md5: string; // File MD5 (API returned), used to determine if re-download is needed
    lastAccessedAt: string;
    size: number;
}

/* ------------------------------------------------------------------ */
/*  Sync bookkeeping (v7). Written only by src/db/sync/commit.ts.      */
/* ------------------------------------------------------------------ */

/** Zotero API JSON of an item (`item.data`). */
export type ItemDataJSON = Record<string, unknown>;

/**
 * The server's data an unsynced row's local changes started from: the base
 * of the three-way merge, and the base its patch upload is computed against.
 */
export interface IDBSyncCache {
    libraryID: number;
    key: string;
    version: number;
    data: ItemDataJSON;
}

/** An object deleted locally whose DELETE has not reached the server yet. */
export interface IDBSyncDeleteLog {
    libraryID: number;
    key: string;
    itemType: string;
    parentItem: string;
    /** Last known server version (0: the create may never have landed). */
    version: number;
    dateDeleted: string;
    /** The row as it was, to restore it if the user keeps the remote side. */
    snapshot: AnyIDBZoteroItem;
}

/**
 * How a conflict arose:
 * - `changed`: both sides changed the same field;
 * - `local-deleted`: deleted here, changed on the server;
 * - `remote-deleted`: changed here (or holds changed descendants), deleted on the server;
 * - `refused`: the server rejected the write (a 4xx other than 404/412).
 */
export type SyncConflictKind = "changed" | "local-deleted" | "remote-deleted" | "refused";

/** A conflict the user has to resolve. Rows in conflict are not uploaded. */
export interface IDBSyncConflict {
    libraryID: number;
    key: string;
    kind: SyncConflictKind;
    /** The server's data (absent when the server deleted it or has none). */
    remote?: ItemDataJSON;
    /** The server version `remote` is from (0 when there is none). */
    remoteVersion: number;
    /** Fields changed differently on both sides (`changed`). */
    fields: string[];
    /** The remote-deletion group this conflict belongs to (its root key). */
    group?: string;
    /** The server's refusal (`refused`): "code: message". */
    error?: string;
    /**
     * `refused` because its parent item exists nowhere: not on the server,
     * no row here (1.6.6 dropped only the parent's row when it accepted a
     * remote deletion). Keep Local makes a note standalone; anything else
     * can only be discarded.
     */
    orphan?: true;
    createdAt: string;
}

/**
 * One remote deletion of a subtree that held local changes. Members are
 * recorded when the deletion is processed (and when a local change lands
 * under one later); resolving acts on exactly these.
 */
export interface IDBSyncGroup {
    libraryID: number;
    /** The root key: the topmost deleted ancestor. */
    id: string;
    root: string;
    members: string[];
}

/** An object to retry later, with backoff. */
export interface IDBSyncQueueEntry {
    libraryID: number;
    key: string;
    reason: "missing-parent" | "server-error";
    tries: number;
    /** Epoch ms of the last attempt. */
    lastCheck: number;
}

/**
 * A write sent whose outcome is unknown until its response arrives (or a
 * complete download shows whether it landed).
 */
export interface IDBUploadJournal {
    libraryID: number;
    key: string;
    /** A copy of the row's data as sent. */
    sent: ItemDataJSON;
    baseVersion: number;
    /** The row's `localRevision` when it was sent. */
    revision: number;
    sentAt: string;
}
