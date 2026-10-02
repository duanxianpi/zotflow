/**
 * One-call setup for a SyncService under test.
 *
 * Wires the real `SyncService`, `ZoteroAPIService`, `LibraryService` and Dexie
 * schema to the fake network and fake main thread. Only the two edges are
 * substituted; everything between them is production code.
 */
import { SyncService } from "worker/services/sync";
import { ZoteroAPIService } from "worker/services/zotero";
import { LibraryService } from "worker/services/library";
import { DEFAULT_SETTINGS } from "settings/types";

import { db, resetDb, seedLibrary } from "./db";
import { createFakeParentHost } from "./parent-host";
import { createFakeZoteroServer } from "./zotero-server";

import type { FakeParentHost, FakeParentHostOptions } from "./parent-host";
import type { FakeZoteroServer } from "./zotero-server";
import type { LibrarySyncMode, ZotFlowSettings } from "settings/types";
import type { ZoteroKeyAccess } from "types/zotero";

export const API_KEY = "TESTKEY";
export const USER_ID = 1;

export interface SyncHarnessOptions {
    /** Sync mode for the personal library. Defaults to bidirectional. */
    mode?: LibrarySyncMode;
    /** Extra group libraries, seeded into both the DB and the key. */
    groups?: { id: number; mode?: LibrarySyncMode; name?: string }[];
    /** Override the key's access block, e.g. to revoke notes permission. */
    access?: ZoteroKeyAccess;
    /** Extra settings overrides. */
    settings?: Partial<ZotFlowSettings>;
    /** Options forwarded to the fake parent host. */
    host?: FakeParentHostOptions;
    /** Seed the personal library row with these versions. */
    versions?: { itemVersion?: number; collectionVersion?: number };
    /** Omit the personal library from `librariesConfig` entirely. */
    omitLibraryConfig?: boolean;
    /** Skip writing the key row, to exercise the AUTH_INVALID path. */
    omitKey?: boolean;
}

export interface SyncHarness {
    sync: SyncService;
    server: FakeZoteroServer;
    host: FakeParentHost;
    settings: ZotFlowSettings;
    library: LibraryService;
    /** Tear down the fetch patch. Safe to call twice. */
    dispose(): void;
}

const DEFAULT_ACCESS: ZoteroKeyAccess = {
    user: { library: true, files: true, notes: true, write: true },
    groups: { all: { library: true, write: true } },
};

export async function createSyncHarness(
    options: SyncHarnessOptions = {},
): Promise<SyncHarness> {
    const {
        mode = "bidirectional",
        groups = [],
        access = DEFAULT_ACCESS,
        versions = {},
        omitLibraryConfig = false,
        omitKey = false,
    } = options;

    await resetDb();

    if (!omitKey) {
        await db.keys.put({
            key: API_KEY,
            userID: USER_ID,
            username: "test-user",
            displayName: "Test User",
            access,
            joinedGroups: groups.map((g) => g.id),
        });
    }

    await seedLibrary({
        id: USER_ID,
        type: "user",
        name: "My Library",
        itemVersion: versions.itemVersion ?? 0,
        collectionVersion: versions.collectionVersion ?? 0,
    });
    for (const g of groups) {
        await seedLibrary({
            id: g.id,
            type: "group",
            name: g.name ?? `Group ${g.id}`,
            itemVersion: 0,
            collectionVersion: 0,
        });
    }

    const librariesConfig: ZotFlowSettings["librariesConfig"] = {};
    if (!omitLibraryConfig) librariesConfig[USER_ID] = { mode };
    for (const g of groups) {
        librariesConfig[g.id] = { mode: g.mode ?? "bidirectional" };
    }

    const settings: ZotFlowSettings = {
        ...DEFAULT_SETTINGS,
        zoteroapikey: API_KEY,
        librariesConfig,
        ...options.settings,
    };

    const host = createFakeParentHost(options.host);
    const server = createFakeZoteroServer({
        apiKey: API_KEY,
        userID: USER_ID,
        joinedGroups: groups.map((g) => g.id),
    });
    server.install();

    const library = new LibraryService(settings, host);
    const sync = new SyncService(
        new ZoteroAPIService(API_KEY),
        settings,
        host,
        library,
        // Backoff waits are real seconds; tests take them instantly.
        { sleep: () => Promise.resolve() },
    );

    let disposed = false;
    return {
        sync,
        server,
        host,
        settings,
        library,
        dispose() {
            if (disposed) return;
            disposed = true;
            server.restore();
        },
    };
}
