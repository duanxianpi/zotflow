import type { ZoteroKey } from "types/zotero";

/** What an API key grants on one library. */
export interface LibraryAccess {
    library: boolean;
    write: boolean;
    notes: boolean;
}

const NO_ACCESS: LibraryAccess = { library: false, write: false, notes: false };

/** The key's access to its owner's personal library. */
export function userLibraryAccess(key: ZoteroKey): LibraryAccess {
    const u = key.access?.user;
    if (!u?.library) return NO_ACCESS;
    return { library: true, write: !!u.write, notes: !!u.notes };
}

/**
 * The key's access to a group library.
 *
 * The Zotero server only records granted permissions: a group set to "None"
 * (or "Read Only") on the key page simply has no (write) entry, and the
 * default group permission (`all`) still applies to it. A group's access is
 * therefore its own entry OR `all`, never one replacing the other
 * (dataserver `Zotero_Permissions::canAccess` / `canWrite`). `all` is
 * further limited by the user's own role in the group, which the key JSON
 * does not show. Notes follow library access in groups.
 */
export function groupLibraryAccess(
    key: ZoteroKey,
    groupID: number,
): LibraryAccess {
    const groups = key.access?.groups;
    const specific = groups?.[groupID];
    const all = groups?.all;
    const library = !!(specific?.library || all?.library);
    if (!library) return NO_ACCESS;
    const write = !!(specific?.write || all?.write);
    return { library, write, notes: library };
}
