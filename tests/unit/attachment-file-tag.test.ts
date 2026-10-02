/**
 * The file-type tag next to an attachment in the tree comes from its content
 * type, not its (template-rendered) name.
 */
import { describe, test, expect } from "vitest";

import { getAttachmentFileTag } from "ui/icons";

describe("getAttachmentFileTag", () => {
    test.each([
        ["application/pdf", "pdf"],
        ["application/epub+zip", "epub"],
        ["text/html", "html"],
        ["text/html; charset=utf-8", "html"],
        ["text/plain", "txt"],
        ["image/png", "png"],
        ["image/jpeg", "jpg"],
        ["application/x-tex", "tex"],
        [
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
        ],
    ])("%s → %s", (contentType, tag) => {
        expect(getAttachmentFileTag(contentType)).toBe(tag);
    });

    test.each([
        undefined,
        "",
        "application/octet-stream",
        "application/vnd.ms-excel.sheet.macroenabled.12",
    ])("nothing short to show for %s", (contentType) => {
        expect(getAttachmentFileTag(contentType)).toBe("");
    });
});
