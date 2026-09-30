import { ZoteroItemData, ZoteroItemDataTypeMap } from "./zotero-item";

/** Permission structure returned by the Zotero API key verification endpoint. */
export interface ZoteroKeyAccess {
    user?: {
        library: boolean;
        files: boolean;
        notes: boolean;
        write: boolean;
    };
    groups?: {
        [groupId: string]: {
            library: boolean;
            write: boolean;
        };
    };
}

/** Zotero API key identity and access permissions. */
export interface ZoteroKey {
    key: string;
    userID: number;
    username: string;
    displayName: string;
    access: ZoteroKeyAccess;
}

/** Zotero group library metadata. */
export interface ZoteroGroup {
    id: number;
    version: number;
    name: string;
    owner: number;
    type: string;
    description: string;
    url: string;
    libraryEditing: string;
    libraryReading: string;
    fileEditing: string;
}

/** Minimal library identifier (id, type, name). */
export interface ZoteroLibrary {
    id: number;
    type: "user" | "group";
    name: string;
}

/** Full Zotero collection response from the API. */
export interface ZoteroCollection {
    key: string;
    version: number;
    library: {
        type: string;
        id: number;
        name: string;
        links: { [key: string]: { href: string; type: string } };
    };
    links: { [key: string]: { href: string; type: string } };
    meta: {
        numItems: number;
        numCollections: number;
        createdByUser?: {
            id: number;
            username: string;
            name: string;
            links: { [key: string]: { href: string; type: string } };
        };
    };
    data: {
        key: string;
        version: number;
        name: string;
        parentCollection: false | string;
        relations: { [key: string]: string | string[] };
        deleted: boolean;
    };
}

/** Generic Zotero item response envelope, parameterized by item data type. */
export interface ZoteroItem<T extends ZoteroItemData> {
    key: string;
    version: number;
    library: {
        type: "user" | "group";
        id: number;
        name: string;
        links: { [key: string]: { href: string; type: string } };
    };
    links: { [key: string]: { href: string; type: string } };
    meta: {
        numChildren: number;
        createdByUser?: {
            id: number;
            username: string;
            name: string;
            links: { [key: string]: { href: string; type: string } };
        };
        creatorSummary?: string;
    };
    data: T;
    /** CSL-JSON payload, present when fetched with include=data,csljson. */
    csljson?: Record<string, unknown>;
}

/** Union of all possible `ZoteroItem<T>` instantiations. */
export type AnyZoteroItem = {
    [K in keyof ZoteroItemDataTypeMap]: ZoteroItem<ZoteroItemDataTypeMap[K]>;
}[keyof ZoteroItemDataTypeMap];

declare module "./zotero-item" {
    interface AttachmentData {
        linkMode: "imported_file" | "linked_file" | "imported_url" | "linked_url";
        contentType: string;
        filename: string;
        md5?: string;
        path?: string; // Absolute OS path (linked_file only)
    }

    interface NoteData {
        note: string;
    }

    interface AnnotationData {
        annotationIsExternal?: boolean;
        annotationAuthorName?: string;
        annotationType: string;
        annotationText: string | null;
        annotationComment: string;
        annotationColor: string;
        annotationPageLabel: string;
        annotationSortIndex: string;
        annotationPosition: string;
    }
}
