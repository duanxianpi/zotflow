/**
 * Get the icon for a given attachment content type.
 * @param contentType The content type of the attachment.
 * @returns The icon name for the attachment.
 */
export function getAttachmentFileIcon(contentType?: string) {
    switch (contentType) {
        case "application/pdf":
            return "file-text";
        case "application/epub+zip":
            return "book";
        case "text/html":
            return "globe";
        default:
            return "paperclip";
    }
}

/** Short labels for content types whose subtype does not read as one. */
const FILE_TAGS: Record<string, string> = {
    "application/epub+zip": "epub",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "docx",
    "text/plain": "txt",
    "text/markdown": "md",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
};

/**
 * The file-type tag shown next to an attachment in the tree, from its
 * content type ("pdf", "epub", "html", …). Never from its name: the shown
 * name follows the display title template and need not contain a file
 * extension. Empty when there is nothing short to show.
 */
export function getAttachmentFileTag(contentType?: string): string {
    if (!contentType) return "";
    const type = contentType.split(";")[0]!.trim().toLowerCase();
    const known = FILE_TAGS[type];
    if (known) return known;
    const subtype = type.split("/")[1]?.replace(/^x-/, "") ?? "";
    return /^[a-z0-9]{1,5}$/.test(subtype) ? subtype : "";
}

/**
 * Get the icon for a given Zotero item type.
 * @param type The type of the Zotero item.
 * @returns The icon name for the Zotero item.
 */
export function getItemTypeIcon(type: string): string {
    const map: Record<string, string> = {
        annotation: "highlighter",
        artwork: "palette",
        attachment: "paperclip",
        audioRecording: "file-audio",
        bill: "scroll-text",
        blogPost: "rss",
        book: "book",
        bookSection: "book-open",
        case: "gavel",
        computerProgram: "code",
        conferencePaper: "book-open-text",
        dataset: "database",
        dictionaryEntry: "book-a",
        document: "file",
        email: "mail",
        encyclopediaArticle: "library",
        film: "film",
        forumPost: "message-square",
        hearing: "mic",
        instantMessage: "message-circle",
        interview: "mic-2",
        journalArticle: "file-text",
        letter: "mail-open",
        magazineArticle: "newspaper",
        manuscript: "feather",
        map: "map",
        newspaperArticle: "newspaper",
        note: "sticky-note",
        patent: "lightbulb",
        podcast: "podcast",
        preprint: "file-clock",
        presentation: "presentation",
        radioBroadcast: "radio",
        report: "file-chart-column",
        standard: "ruler",
        statute: "scale",
        thesis: "graduation-cap",
        tvBroadcast: "tv",
        videoRecording: "video",
        webpage: "panel-top",
        default: "file",
    };
    return map[type] || map.default!;
}
