/**
 * `utils/key-access` — key permissions as the Zotero server applies them.
 * The `access` objects are the ones `/keys/current` returned for one key
 * under different settings on the key page (verified 2026-10-02).
 */
import { describe, test, expect } from "vitest";

import { groupLibraryAccess, userLibraryAccess } from "utils/key-access";

import type { ZoteroKey, ZoteroKeyAccess } from "types/zotero";

function key(access?: ZoteroKeyAccess): ZoteroKey {
    return { key: "K", userID: 1, username: "u", displayName: "", access };
}

const NONE = { library: false, write: false, notes: false };
const READ = { library: true, write: false, notes: true };
const WRITE = { library: true, write: true, notes: true };

describe("groupLibraryAccess", () => {
    test("per-group None with a Read Only default: the default applies", () => {
        const k = key({ groups: { all: { library: true, write: false } } });
        expect(groupLibraryAccess(k, 10)).toEqual(READ);
    });

    test("per-group grants with a None default: only the granted groups", () => {
        const k = key({
            groups: {
                "10": { library: true, write: true },
                "11": { library: true, write: false },
            },
        });
        expect(groupLibraryAccess(k, 10)).toEqual(WRITE);
        expect(groupLibraryAccess(k, 11)).toEqual(READ);
        expect(groupLibraryAccess(k, 12)).toEqual(NONE);
    });

    test("a per-group entry cannot lower the default", () => {
        const k = key({
            groups: {
                all: { library: true, write: true },
                "11": { library: true, write: false },
            },
        });
        expect(groupLibraryAccess(k, 11)).toEqual(WRITE);
        expect(groupLibraryAccess(k, 12)).toEqual(WRITE);
    });

    test("a key without any access has no `access` field", () => {
        expect(groupLibraryAccess(key(), 10)).toEqual(NONE);
    });
});

describe("userLibraryAccess", () => {
    test("no `access` field", () => {
        expect(userLibraryAccess(key())).toEqual(NONE);
    });

    test("notes and write follow the user flags", () => {
        const k = key({
            user: { library: true, files: true, notes: false, write: true },
        });
        expect(userLibraryAccess(k)).toEqual({
            library: true,
            write: true,
            notes: false,
        });
    });
});
