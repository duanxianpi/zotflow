/**
 * Get note path
 */
export function getNotePath({
    citationKey,
    title,
    key,
    sourceNoteFolder,
    libraryName,
}: {
    citationKey?: string;
    title?: string;
    key: string;
    sourceNoteFolder: string;
    libraryName: string;
}): string {
    const illegalRe = /[\/?<>\\:*|"]/g;
    const controlRe = /[\x00-\x1f\x80-\x9f]/g;
    const reservedRe = /^\.+$/;
    const windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

    let filename = `@${citationKey || title || key}`;
    filename = filename
        .replace(illegalRe, "")
        .replace(controlRe, "")
        .replace(reservedRe, "")
        .replace(windowsReservedRe, "");

    const folder = sourceNoteFolder.replace(/\/$/, "");
    const extension = "md";

    let path = `${folder}/${libraryName}/${filename}.${extension}`;
    return path.replace(/\/+/g, "/");
}

/**
 * Derive the `.zf.json` sidecar path for a local attachment.
 *
 * If `sidecarFolder` is empty, the sidecar lives next to the attachment
 * (e.g. `Papers/myPaper.pdf` → `Papers/myPaper.zf.json`).
 *
 * If `sidecarFolder` is set, the original directory structure is mirrored
 * underneath it to avoid basename collisions
 * (e.g. with `sidecarFolder = ".zotflow/sidecars"`,
 * `Papers/myPaper.pdf` → `.zotflow/sidecars/Papers/myPaper.zf.json`).
 */
export function getLocalSidecarPath(
    filePath: string,
    sidecarFolder: string,
): string {
    const lastSlash = filePath.lastIndexOf("/");
    const dir = lastSlash !== -1 ? filePath.substring(0, lastSlash) : "";
    const fileName =
        lastSlash !== -1 ? filePath.substring(lastSlash + 1) : filePath;

    const lastDot = fileName.lastIndexOf(".");
    const basename = lastDot !== -1 ? fileName.substring(0, lastDot) : fileName;

    const folder = sidecarFolder.replace(/^\/+|\/+$/g, "");
    const dirPart = dir ? `${dir}/` : "";
    const folderPart = folder ? `${folder}/` : "";

    const result = `${folderPart}${dirPart}${basename}.zf.json`;
    return result.replace(/\/+/g, "/");
}
