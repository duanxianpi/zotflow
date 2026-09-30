/**
 * Construction helpers for the worker services that only need the DB and a
 * fake main thread — no network, so no fake Zotero server.
 */
import { DbHelperService } from "worker/services/db-helper";
import { NotePathService } from "worker/services/note-path";
import { LibraryService } from "worker/services/library";
import { SearchService } from "worker/services/search";
import { SearchMatcher } from "worker/services/search-matcher";
import { DisplayTitleService } from "worker/services/display-title";
import { DEFAULT_SETTINGS } from "settings/types";

import { db, resetDb, seedLibrary } from "./db";
import { createFakeParentHost } from "./parent-host";

import type { FakeParentHost } from "./parent-host";
import type { LibrarySyncMode, ZotFlowSettings } from "settings/types";
import type { ZoteroKeyAccess } from "types/zotero";

export const API_KEY = "TESTKEY";
export const USER_ID = 1;

export interface ServiceHarnessOptions {
    settings?: Partial<ZotFlowSettings>;
    /** Libraries to seed and enable. The first is the personal one. */
    libraries?: { id: number; name?: string; mode?: LibrarySyncMode }[];
    access?: ZoteroKeyAccess;
    /** Omit the API key, to exercise the CONFIG_MISSING guard. */
    omitKey?: boolean;
}

export interface ServiceHarness {
    dbHelper: DbHelperService;
    notePath: NotePathService;
    library: LibraryService;
    search: SearchService;
    displayTitle: DisplayTitleService;
    host: FakeParentHost;
    settings: ZotFlowSettings;
}

export async function createServiceHarness(
    options: ServiceHarnessOptions = {},
): Promise<ServiceHarness> {
    const {
        libraries = [{ id: USER_ID, name: "My Library" }],
        access = {
            user: { library: true, files: true, notes: true, write: true },
            groups: { all: { library: true, write: true } },
        },
        omitKey = false,
    } = options;

    await resetDb();

    const [personal, ...groups] = libraries;

    await db.keys.put({
        key: API_KEY,
        userID: personal!.id,
        username: "test-user",
        displayName: "Test User",
        access,
        joinedGroups: groups.map((g) => g.id),
    });

    for (const [index, lib] of libraries.entries()) {
        await seedLibrary({
            id: lib.id,
            type: index === 0 ? "user" : "group",
            name: lib.name ?? `Library ${lib.id}`,
        });
    }

    const librariesConfig: ZotFlowSettings["librariesConfig"] = {};
    for (const lib of libraries) {
        librariesConfig[lib.id] = { mode: lib.mode ?? "bidirectional" };
    }

    const settings: ZotFlowSettings = {
        ...DEFAULT_SETTINGS,
        zoteroapikey: omitKey ? "" : API_KEY,
        librariesConfig,
        ...options.settings,
    };

    const host = createFakeParentHost();
    const library = new LibraryService(settings, host);
    const dbHelper = new DbHelperService(settings, host, library);
    const displayTitle = new DisplayTitleService(settings, host);
    const search = new SearchService(
        new SearchMatcher(),
        dbHelper,
        displayTitle,
    );
    const notePath = new NotePathService(settings, dbHelper);

    return {
        dbHelper,
        notePath,
        library,
        search,
        displayTitle,
        host,
        settings,
    };
}
