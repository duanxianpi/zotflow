import type { IParentProxy } from "bridge/types";
import type { AnyIDBZoteroItem } from "types/db-schema";

/**
 * What goes with an item row removed for good (a remote deletion applied,
 * or one accepted in a conflict) besides the row itself: the rendered image
 * of an image or ink annotation, `{folder}/{key}.png`.
 *
 * File I/O, so never call this inside a Dexie transaction.
 */
export async function deleteRemovedItemFiles(
    parentHost: IParentProxy,
    annotationImageFolder: string,
    rows: AnyIDBZoteroItem[],
    context: string,
): Promise<void> {
    const folder = annotationImageFolder.replace(/\/$/, "");
    for (const row of rows) {
        if (!hasAnnotationImage(row)) continue;
        const path = `${folder}/${row.key}.png`;
        try {
            const exists = await parentHost.checkFile(path);
            if (exists.exists) {
                await parentHost.deleteFile(path);
                parentHost.log("debug", `Deleted orphaned annotation image: ${path}`, context);
            }
        } catch (e) {
            // Best-effort: a leftover image is harmless.
            parentHost.log("warn", `Failed to delete annotation image ${row.key}`, context, e);
        }
    }
}

function hasAnnotationImage(row: AnyIDBZoteroItem): boolean {
    return row.itemType === "annotation" && ["image", "ink"].includes(String(row.raw?.data?.annotationType));
}
