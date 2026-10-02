/**
 * NotePathService — turns a Liquid template plus an item into a vault path.
 *
 * The path is what the whole sync writes to, so the tests here care most about
 * the two failure modes that corrupt a vault: a template variable that can
 * produce an illegal filename, and a path that collapses to something other
 * than what the template said.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { MAX_SEGMENT_BYTES } from "worker/services/note-path";
import { db, seedItem, seedCollection, seedLibrary } from "../fakes/db";
import { createServiceHarness, USER_ID } from "../fakes/services";

import type { ServiceHarness } from "../fakes/services";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { TFileWithoutParentAndVault } from "types/zotflow";

let h: ServiceHarness;

beforeEach(async () => {
    h = await createServiceHarness();
});

/** Seed an item and hand back the stored row, ready to resolve. */
async function item(
    over: Partial<AnyIDBZoteroItem> & { key?: string } = {},
): Promise<AnyIDBZoteroItem> {
    const key = over.key ?? "ARTICLE1";
    await seedItem({ libraryID: USER_ID, key, ...over });
    return (await db.items.get([USER_ID, key]))!;
}

/** Build the raw payload NotePathService reads its metadata from. */
function raw(data: Record<string, unknown>) {
    return {
        key: "ARTICLE1",
        version: 1,
        library: { type: "user", id: USER_ID, name: "My Library" },
        data: { key: "ARTICLE1", itemType: "journalArticle", ...data },
    } as any;
}

const localFile = (over: Partial<TFileWithoutParentAndVault> = {}) =>
    ({
        basename: "Some Paper",
        name: "Some Paper.pdf",
        path: "Attachments/2024/Some Paper.pdf",
        extension: "pdf",
        ...over,
    });

describe("template selection", () => {
    test("falls back to the built-in template when nothing is configured", async () => {
        h = await createServiceHarness({
            settings: { librarySourceNotePathTemplate: "" },
        });
        const it = await item({ title: "A Study" });

        expect(await h.notePath.resolveLibraryNotePath(it)).toBe(
            "Source/My Library/@A Study.md",
        );
    });

    test("uses the configured template", async () => {
        h = await createServiceHarness({
            settings: { librarySourceNotePathTemplate: "Refs/{{key}}" },
        });
        const it = await item();

        expect(await h.notePath.resolveLibraryNotePath(it)).toBe(
            "Refs/ARTICLE1.md",
        );
    });

    test("an explicit override beats the configured template", async () => {
        h = await createServiceHarness({
            settings: { librarySourceNotePathTemplate: "Refs/{{key}}" },
        });
        const it = await item({ title: "A Study" });

        expect(
            await h.notePath.resolveLibraryNotePath(it, "Custom/{{title}}"),
        ).toBe("Custom/A Study.md");
    });

    test("a whitespace-only override falls through to the configured template", async () => {
        h = await createServiceHarness({
            settings: { librarySourceNotePathTemplate: "Refs/{{key}}" },
        });
        const it = await item();

        expect(await h.notePath.resolveLibraryNotePath(it, "   ")).toBe(
            "Refs/ARTICLE1.md",
        );
    });

    test("getDefaultPathTemplate reports what each mode is configured with", async () => {
        h = await createServiceHarness({
            settings: {
                librarySourceNotePathTemplate: "Lib/{{key}}",
                localSourceNotePathTemplate: "Local/{{basename}}",
            },
        });
        expect(h.notePath.getDefaultPathTemplate("library")).toBe("Lib/{{key}}");
        expect(h.notePath.getDefaultPathTemplate("local")).toBe(
            "Local/{{basename}}",
        );
    });
});

describe("the citation-key fallback chain", () => {
    const TEMPLATE =
        "Source/@{{citationKey | default: title | default: key}}";

    test("prefers the citation key", async () => {
        const it = await item({ citationKey: "doe2020", title: "A Study" });
        expect(await h.notePath.resolveLibraryNotePath(it, TEMPLATE)).toBe(
            "Source/@doe2020.md",
        );
    });

    test("falls back to the title", async () => {
        const it = await item({ citationKey: "", title: "A Study" });
        expect(await h.notePath.resolveLibraryNotePath(it, TEMPLATE)).toBe(
            "Source/@A Study.md",
        );
    });

    test("falls back to the key when there is no title either", async () => {
        const it = await item({ citationKey: "", title: "" });
        expect(await h.notePath.resolveLibraryNotePath(it, TEMPLATE)).toBe(
            "Source/@ARTICLE1.md",
        );
    });
});

describe("filename sanitization", () => {
    test("characters illegal in a filename are removed from the title", async () => {
        const it = await item({ title: 'A/B\\C:D*E?F"G<H>I|J' });

        expect(await h.notePath.resolveLibraryNotePath(it, "Refs/{{title}}")).toBe(
            "Refs/ABCDEFGHIJ.md",
        );
    });

    test("a title that is only dots cannot become a relative path", async () => {
        const it = await item({ title: ".." });
        expect(await h.notePath.resolveLibraryNotePath(it, "Refs/{{title}}")).toBe(
            "Refs/_.md",
        );
    });

    for (const reserved of ["CON", "nul", "COM1", "lpt9"]) {
        test(`the Windows reserved name "${reserved}" is prefixed`, async () => {
            const it = await item({ title: reserved });
            expect(
                await h.notePath.resolveLibraryNotePath(it, "Refs/{{title}}"),
            ).toBe(`Refs/_${reserved}.md`);
        });
    }

    test("a reserved name with an extension is still prefixed", async () => {
        const it = await item({ title: "aux.txt" });
        expect(await h.notePath.resolveLibraryNotePath(it, "Refs/{{title}}")).toBe(
            "Refs/_aux.txt.md",
        );
    });

    test("non-string values inside a list pass through untouched", async () => {
        // Zotero tags carry a numeric `type` alongside the string.
        const it = await item({
            raw: raw({ tags: [{ tag: "to-read", type: 1 }] }),
        });
        expect(
            await h.notePath.resolveLibraryNotePath(
                it,
                "Refs/{{tags[0].tag}}-{{tags[0].type}}",
            ),
        ).toBe("Refs/to-read-1.md");
    });

    test("date fields keep their separators", async () => {
        // `date` is on the ignore list precisely so templates can slice it.
        const it = await item({ raw: raw({ date: "2024-03-18" }) });
        expect(
            await h.notePath.resolveLibraryNotePath(it, "Refs/{{date}}/{{key}}"),
        ).toBe("Refs/2024-03-18/ARTICLE1.md");
    });

    test("creator names are sanitized like any other segment", async () => {
        const it = await item({
            raw: raw({ creators: [{ firstName: "Jane", lastName: "D/oe" }] }),
        });
        expect(
            await h.notePath.resolveLibraryNotePath(
                it,
                "Refs/{{creators[0].name}}",
            ),
        ).toBe("Refs/Jane Doe.md");
    });
});

describe("path normalization", () => {
    test("repeated and trailing separators collapse", async () => {
        const it = await item();
        expect(
            await h.notePath.resolveLibraryNotePath(it, "a//b///c/{{key}}"),
        ).toBe("a/b/c/ARTICLE1.md");
    });

    test("backslashes are treated as separators", async () => {
        const it = await item();
        expect(
            await h.notePath.resolveLibraryNotePath(it, "a\\b\\{{key}}"),
        ).toBe("a/b/ARTICLE1.md");
    });

    test("blank segments are dropped", async () => {
        const it = await item({ title: "" });
        expect(
            await h.notePath.resolveLibraryNotePath(it, "Refs/{{title}}/{{key}}"),
        ).toBe("Refs/ARTICLE1.md");
    });

    test("the .md extension is always appended exactly once", async () => {
        const it = await item();
        expect(await h.notePath.resolveLibraryNotePath(it, "Refs/{{key}}")).toBe(
            "Refs/ARTICLE1.md",
        );
    });
});

describe("template context", () => {
    test("the library name comes from the DB", async () => {
        await seedLibrary({ id: USER_ID, type: "user", name: "Research" });
        const it = await item();

        expect(
            await h.notePath.resolveLibraryNotePath(it, "{{libraryName}}/{{key}}"),
        ).toBe("Research/ARTICLE1.md");
    });

    test("an unknown library renders as Unknown", async () => {
        await db.libraries.delete(USER_ID);
        const it = await item();

        expect(
            await h.notePath.resolveLibraryNotePath(it, "{{libraryName}}/{{key}}"),
        ).toBe("Unknown/ARTICLE1.md");
    });

    test("the year is extracted from a free-form date", async () => {
        const it = await item({ raw: raw({ date: "Spring 1998" }) });
        expect(
            await h.notePath.resolveLibraryNotePath(it, "{{year}}/{{key}}"),
        ).toBe("1998/ARTICLE1.md");
    });

    test("an unparseable date yields an empty year, which drops the segment", async () => {
        const it = await item({ raw: raw({ date: "no idea" }) });
        expect(
            await h.notePath.resolveLibraryNotePath(it, "{{year}}/{{key}}"),
        ).toBe("ARTICLE1.md");
    });

    test("Zotero's creator summary is exposed alongside creators", async () => {
        const it = await item({
            raw: {
                ...raw({ creators: [{ firstName: "Jane", lastName: "Doe" }] }),
                meta: { creatorSummary: "Doe et al." },
            },
        });
        expect(
            await h.notePath.resolveLibraryNotePath(
                it,
                "Refs/{{creatorSummary}} - {{creators[0].name}}",
            ),
        ).toBe("Refs/Doe et al. - Jane Doe.md");
    });

    test("creators fall back to first/last name pairs", async () => {
        const it = await item({
            raw: raw({
                creators: [
                    { firstName: "Jane", lastName: "Doe" },
                    { name: "Acme Institute" },
                ],
            }),
        });
        expect(
            await h.notePath.resolveLibraryNotePath(
                it,
                "Refs/{{creators[1].name}}",
            ),
        ).toBe("Refs/Acme Institute.md");
    });

    test("bibliographic fields are exposed to the template", async () => {
        const it = await item({
            raw: raw({
                publicationTitle: "Journal of Testing",
                volume: "12",
                pages: "45-67",
            }),
        });
        expect(
            await h.notePath.resolveLibraryNotePath(
                it,
                "{{publicationTitle}}/{{volume}}/{{pages}}/{{key}}",
            ),
        ).toBe("Journal of Testing/12/45-67/ARTICLE1.md");
    });

    test("base fields resolve through type-specific stand-ins", async () => {
        const it = await item({
            itemType: "patent",
            raw: raw({ itemType: "patent", issueDate: "2004-06-01" }),
        });
        expect(
            await h.notePath.resolveLibraryNotePath(it, "{{year}}/{{key}}"),
        ).toBe("2004/ARTICLE1.md");
    });

    test("type-specific fields are exposed and sanitized", async () => {
        const it = await item({
            itemType: "case",
            raw: raw({ itemType: "case", court: "Court A/B" }),
        });
        expect(
            await h.notePath.resolveLibraryNotePath(
                it,
                "{{court}}/{{key}}",
            ),
        ).toBe("Court AB/ARTICLE1.md");
    });

    test("variables are also available under `item`", async () => {
        // Same spelling as source-note and citation templates.
        const it = await item({
            title: "A Study",
            raw: raw({ date: "2020-05-04" }),
        });
        expect(
            await h.notePath.resolveLibraryNotePath(
                it,
                "{{ item.year }}/{{ item.title }} - {{ title }}",
            ),
        ).toBe("2020/A Study - A Study.md");
    });

    test("values under `item` are sanitized like top-level ones", async () => {
        const it = await item({ title: "Either/Or: A Fragment" });
        expect(
            await h.notePath.resolveLibraryNotePath(it, "Refs/{{ item.title }}"),
        ).toBe("Refs/EitherOr A Fragment.md");
    });

    test("itemPaths carries the collection breadcrumbs", async () => {
        await seedCollection({
            libraryID: USER_ID,
            key: "COLL0001",
            name: "Papers",
        });
        const it = await item({ collections: ["COLL0001"] });

        // The trailing slash from getItemPaths collapses during normalization.
        expect(
            await h.notePath.resolveLibraryNotePath(it, "{{itemPaths[0]}}{{key}}"),
        ).toBe("My Library/Papers/ARTICLE1.md");
    });
});

describe("local attachment notes", () => {
    test("falls back to the built-in local template", async () => {
        h = await createServiceHarness({
            settings: { localSourceNotePathTemplate: "" },
        });
        expect(await h.notePath.resolveLocalNotePath(localFile())).toBe(
            "Source/Local/@Some Paper.md",
        );
    });

    test("exposes name, basename and extension", async () => {
        expect(
            await h.notePath.resolveLocalNotePath(
                localFile(),
                "{{extension}}/{{basename}}",
            ),
        ).toBe("pdf/Some Paper.md");
    });

    test("exposes the attachment directory", async () => {
        expect(
            await h.notePath.resolveLocalNotePath(
                localFile(),
                "Notes/{{directory}}/{{basename}}",
            ),
        ).toBe("Notes/Attachments/2024/Some Paper.md");

        // Root-level attachments have no directory, and sanitizePath
        // collapses the empty segment.
        expect(
            await h.notePath.resolveLocalNotePath(
                localFile({ path: "Some Paper.pdf" }),
                "Notes/{{directory}}/{{basename}}",
            ),
        ).toBe("Notes/Some Paper.md");
    });

    test("the source path keeps its separators", async () => {
        // `path` is on the ignore list, so a template can mirror the vault
        // layout of the attachment it belongs to.
        expect(
            await h.notePath.resolveLocalNotePath(localFile(), "Notes/{{path}}"),
        ).toBe("Notes/Attachments/2024/Some Paper.pdf.md");
    });

    test("an illegal basename is sanitized", async () => {
        expect(
            await h.notePath.resolveLocalNotePath(
                localFile({ basename: "Q3: results?" }),
                "Notes/{{basename}}",
            ),
        ).toBe("Notes/Q3 results.md");
    });

    test("control characters are removed from a basename", async () => {
        expect(
            await h.notePath.resolveLocalNotePath(
                localFile({ basename: "Some\u0000\u007f Paper" }),
                "Notes/{{basename}}",
            ),
        ).toBe("Notes/Some Paper.md");
    });

    test("previewLocalNotePath is the same resolution with a caller's template", async () => {
        expect(
            await h.notePath.previewLocalNotePath(localFile(), "P/{{basename}}"),
        ).toBe("P/Some Paper.md");
    });
});

describe("preview by key", () => {
    test("resolves a stored item", async () => {
        await item({ title: "A Study" });
        expect(
            await h.notePath.previewLibraryNotePath(
                USER_ID,
                "ARTICLE1",
                "P/{{title}}",
            ),
        ).toBe("P/A Study.md");
    });

    test("an unknown item is a resource error, not an empty path", async () => {
        await expect(
            h.notePath.previewLibraryNotePath(USER_ID, "MISSING1", "P/{{key}}"),
        ).rejects.toThrow(/Item not found: 1\/MISSING1/);
    });
});

describe("settings updates", () => {
    test("updateSettings changes the template a later call reads", async () => {
        h = await createServiceHarness({
            settings: { librarySourceNotePathTemplate: "Old/{{key}}" },
        });
        const it = await item();
        expect(await h.notePath.resolveLibraryNotePath(it)).toBe(
            "Old/ARTICLE1.md",
        );

        h.notePath.updateSettings({
            ...h.settings,
            librarySourceNotePathTemplate: "New/{{key}}",
        });
        expect(await h.notePath.resolveLibraryNotePath(it)).toBe(
            "New/ARTICLE1.md",
        );
    });
});

describe("long names", () => {
    // File systems allow 255 bytes per name; a note may also get " (99)".
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    const parts = (path: string) => path.slice(0, -".md".length).split("/");

    async function resolveTitle(title: string, template = "Refs/@{{ title }}") {
        h = await createServiceHarness({ settings: { librarySourceNotePathTemplate: template } });
        return h.notePath.resolveLibraryNotePath(await item({ title }));
    }

    test("a long title is cut to MAX_SEGMENT_BYTES, with room for a suffix and .md", async () => {
        const path = await resolveTitle("a".repeat(300));
        const [folder, name] = parts(path);

        expect(folder).toBe("Refs");
        expect(name).toBe(`@${"a".repeat(MAX_SEGMENT_BYTES - 1)}`);
        expect(bytes(`${name} (99).md`)).toBeLessThanOrEqual(255);
    });

    test("the limit counts bytes: a CJK title is cut at a third of the characters", async () => {
        const title = "注意力机制".repeat(40); // 200 characters, 600 bytes
        const name = parts(await resolveTitle(title))[1]!;

        expect(bytes(name)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
        expect(bytes(name)).toBeGreaterThan(MAX_SEGMENT_BYTES - 3);
        expect(title.startsWith(name.slice(1))).toBe(true);
        expect(name).not.toContain("�");
    });

    test("a cut never splits an emoji", async () => {
        const family = "👨‍👩‍👧"; // one character, 18 bytes
        const name = parts(await resolveTitle(`${"a".repeat(195)}${family}${"b".repeat(20)}`))[1]!;

        expect(name).toBe(`@${"a".repeat(195)}`);
    });

    test("trailing spaces and dots left by the cut are dropped", async () => {
        const name = parts(await resolveTitle(`${"a".repeat(197)}. ${"b".repeat(50)}`))[1]!;

        expect(name).toBe(`@${"a".repeat(197)}`);
    });

    test("folder segments are capped too", async () => {
        const path = await resolveTitle("f".repeat(300), "{{ title }}/note");

        expect(path).toBe(`${"f".repeat(MAX_SEGMENT_BYTES)}/note.md`);
    });

    test("the fixture's long, punctuated title fits", async () => {
        const title =
            'An extremely long report title used to check truncation, wrapping, file name limits and sanitization: slashes / back\\slashes, colons: question marks? asterisks* quotes "double" pipes | and angle <brackets> — repeated until it is well over two hundred characters long';
        const name = parts(await resolveTitle(title))[1]!;

        expect(bytes(`${name} (99).md`)).toBeLessThanOrEqual(255);
        expect(name.startsWith("@An extremely long report title")).toBe(true);
    });

    test("a name within the limit is left as it is", async () => {
        expect(await resolveTitle("a".repeat(MAX_SEGMENT_BYTES - 1))).toBe(`Refs/@${"a".repeat(MAX_SEGMENT_BYTES - 1)}.md`);
    });
});
