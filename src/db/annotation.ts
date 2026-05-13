import { db } from "db/db";
import type { IDBZoteroItem } from "types/db-schema";
import type {
    AnnotationData,
    AttachmentData,
    ZoteroItemDataTypeMap,
} from "types/zotero-item";
import type { AnnotationJSON } from "types/zotero-reader";

/**
 * Convert reader-compatible annotation JSON into a Zotero annotation item.
 *
 * @param json The reader annotation data
 * @returns A partial Zotero annotation item
 */
export function annotationItemFromJSON(
    json: AnnotationJSON,
): Partial<ZoteroItemDataTypeMap["annotation"]> {
    const item: any = {
        itemType: "annotation",
    };

    item.key = json.id;
    item.annotationType = json.type;
    item.annotationAuthorName = json.authorName || "";
    if (json.type === "highlight" || json.type === "underline") {
        item.annotationText = json.text;
    }
    item.annotationComment = json.comment;
    item.annotationColor = json.color;
    item.annotationPageLabel = json.pageLabel;
    item.annotationSortIndex = json.sortIndex;
    item.annotationIsExternal = json.isExternal;

    item.annotationPosition = JSON.stringify(Object.assign({}, json.position));
    item.tags = (json.tags || []).map((t) => ({ tag: t.name }));

    return item;
}

/**
 * Get all annotations for a given item from the local database.
 *
 * @param libraryID The ID of the Zotero library (user or group ID).
 * @param itemKey The key of the parent item (e.g., journal article) to fetch annotations for.
 * @returns A promise that resolves to an array of annotation items.
 */
export async function getAnnotationJson(
    item: IDBZoteroItem<AttachmentData>,
    apiKey: string,
    filter?: (annotation: IDBZoteroItem<AnnotationData>) => boolean,
): Promise<AnnotationJSON[]> {
    // Get current user from settings/DB

    if (item.itemType !== "attachment") {
        return [];
    }

    const currentUserKey = await db.keys.get(apiKey);
    const currentUser = currentUserKey
        ? {
              id: currentUserKey.userID,
              username: currentUserKey.username,
              displayName: currentUserKey.displayName,
          }
        : null;

    // Get Library Info
    const library = await db.libraries.get(item.libraryID);
    const isGroup = library?.type === "group";

    // Get User info (for creator/modifier)
    // lastModifiedByUser is not readily available in standard Zotero item API response
    // We will assume it's createdByUser if not present.

    // Tag Colors from Settings
    const tagColors = new Map();

    // Zotero Annotations
    let annotations = (await db.items
        .where({
            libraryID: item.libraryID,
            parentItem: item.key,
            itemType: "annotation",
        })
        .toArray()) as IDBZoteroItem<AnnotationData>[];

    if (filter) {
        annotations = annotations.filter(filter);
    }

    // External Annotations
    const annotationJson: AnnotationJSON[] = [];
    for (const annotation of annotations) {
        const o: any = {};
        o.libraryID = annotation.libraryID;
        o.id = annotation.key;
        o.type = annotation.raw.data.annotationType;
        o.isExternal = annotation.raw.data.annotationIsExternal || false; // Default to false

        const isAuthor =
            !annotation.raw.meta.createdByUser?.id ||
            annotation.raw.meta.createdByUser?.id === currentUser?.id;
        const isReadOnly = false; // Defaulting to false

        if (annotation.raw.data.annotationAuthorName) {
            o.authorName = annotation.raw.data.annotationAuthorName;
            if (isGroup) {
                // Not sure what is lastModifiedByUser
            }
        } else if (
            !o.isExternal &&
            isGroup &&
            annotation.raw.meta.createdByUser
        ) {
            o.authorName =
                annotation.raw.meta.createdByUser.username ||
                annotation.raw.meta.createdByUser.name;
            o.isAuthorNameAuthoritative = true;
        }

        o.readOnly = isReadOnly || o.isExternal || !isAuthor;

        if (o.type === "highlight" || o.type === "underline") {
            o.text = annotation.raw.data.annotationText;
        }

        o.comment = annotation.raw.data.annotationComment;
        o.pageLabel = annotation.raw.data.annotationPageLabel;
        o.color = annotation.raw.data.annotationColor;
        o.sortIndex = annotation.raw.data.annotationSortIndex;
        o.position = JSON.parse(annotation.raw.data.annotationPosition);

        // Add tags
        const tags = annotation.raw.data.tags || [];

        const processedTags = tags.map((t) => {
            const obj: any = {
                name: t.tag,
            };
            /*
                if (tagColors.has(t.tag)) {
                    obj.color = tagColors.get(t.tag).color;
                    obj.position = tagColors.get(t.tag).position;
                }
                */
            return obj;
        });

        processedTags.sort((a, b) => {
            if (!a.color && !b.color) {
                return a.name.localeCompare(b.name, undefined, {
                    sensitivity: "accent",
                });
            }
            if (!a.color && !b.color) {
                return -1;
            }
            if (!a.color && b.color) {
                return 1;
            }
            return a.position - b.position;
        });

        processedTags.forEach((t) => delete t.position);
        o.tags = processedTags;

        o.dateAdded = annotation.dateAdded;
        o.dateCreated = annotation.dateAdded;
        o.dateModified = annotation.dateModified;
        annotationJson.push(o);
    }

    // Sort by document position (sortIndex is zero-padded: pageIndex|yOffset|xOffset)
    annotationJson.sort((a, b) =>
        (a.sortIndex ?? "").localeCompare(b.sortIndex ?? ""),
    );

    return annotationJson;
}
