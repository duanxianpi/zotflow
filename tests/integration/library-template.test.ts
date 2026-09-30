/**
 * LibraryTemplateService — the Liquid engine that turns a Zotero item into the
 * markdown of a source note.
 *
 * This is what actually lands in the vault, so the emphasis is on the two
 * things a user notices when they break: the frontmatter merge (which decides
 * whether their hand-edited fields survive an update) and the link/editable
 * filters (which decide whether the note is navigable and editable at all).
 *
 * Everything runs for real except `CslRenderWorkerService` — the citeproc
 * engine has its own 25-case suite, so here a recording fake proves the
 * filters hand it the right arguments and place its output correctly.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { LibraryTemplateService } from "worker/services/library-template";
import { DbHelperService } from "worker/services/db-helper";
import { NotePathService } from "worker/services/note-path";
import { ConvertService } from "worker/services/convert";
import { LibraryService } from "worker/services/library";
import { SearchService } from "worker/services/search";
import { ZoteroAPIService } from "worker/services/zotero";
import { DEFAULT_SETTINGS } from "settings/types";
import { db, resetDb, seedItem, seedLibrary } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";

import type { FakeParentHost } from "../fakes/parent-host";
import type { CslRenderWorkerService } from "worker/services/csl-render";
import type { ZotFlowSettings } from "settings/types";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { CiteProps, CSLItem, RenderOptions } from "worker/csl";

const LIB = 1;
const GROUP = 777;
const API_KEY = "TESTKEY";

interface CslCall {
    kind: "citation" | "bibliography";
    items: CSLItem[];
    opts: RenderOptions;
    props?: (CiteProps | undefined)[];
}

let host: FakeParentHost;
let settings: ZotFlowSettings;
let service: LibraryTemplateService;
let cslCalls: CslCall[];

/**
 * Real YAML is not available in the worker fake, and the frontmatter merge is
 * the point of several tests — so the host's flat parser/stringifier is used
 * as-is and templates stay to `key: value` pairs.
 */
async function setup(over: Partial<ZotFlowSettings> = {}) {
    await resetDb();
    await seedLibrary({ id: LIB, type: "user", name: "My Library" });
    await db.keys.put({
        key: API_KEY,
        userID: 42,
        username: "test-user",
        displayName: "Test User",
        access: { user: { library: true, files: true, notes: true, write: true } },
        joinedGroups: [GROUP],
    });

    host = createFakeParentHost({ vaultConfig: { strictLineBreaks: false } });
    settings = {
        ...DEFAULT_SETTINGS,
        zoteroapikey: API_KEY,
        librariesConfig: { [LIB]: { mode: "bidirectional" } },
        cslDefaultStyleId: "apa",
        annotationImageFolder: "ZotFlow/images/",
        ...over,
    };

    cslCalls = [];
    const cslRender = {
        renderCitation: (
            items: CSLItem[],
            opts: RenderOptions,
            props?: (CiteProps | undefined)[],
        ) => {
            cslCalls.push({ kind: "citation", items, opts, props });
            return Promise.resolve(
                `(cite:${items.map((i) => i.id).join("+")})`,
            );
        },
        renderBibliography: (items: CSLItem[], opts: RenderOptions) => {
            cslCalls.push({ kind: "bibliography", items, opts });
            return Promise.resolve(items.map((i) => `bib:${i.id}`));
        },
    } as unknown as CslRenderWorkerService;

    const library = new LibraryService(settings, host);
    const dbHelper = new DbHelperService(
        settings,
        host,
        library,
        new SearchService(),
    );
    const convert = new ConvertService();

    service = new LibraryTemplateService(
        settings,
        host,
        dbHelper,
        new NotePathService(settings, dbHelper),
        convert,
        cslRender,
        new ZoteroAPIService(API_KEY),
    );
}

beforeEach(() => setup());

/** A journal article with enough metadata to drive the default template. */
async function seedArticle(
    key = "PARENT01",
    data: Record<string, unknown> = {},
): Promise<AnyIDBZoteroItem> {
    await seedItem({
        libraryID: LIB,
        key,
        itemType: "journalArticle",
        title: "A Study of Things",
        citationKey: "doe2020",
        version: 7,
        csljson: { id: key, type: "article-journal", title: "A Study of Things" },
        raw: {
            key,
            version: 7,
            library: { type: "user", id: LIB, name: "My Library" },
            meta: {},
            data: {
                key,
                version: 7,
                itemType: "journalArticle",
                title: "A Study of Things",
                creators: [{ firstName: "Jane", lastName: "Doe" }],
                date: "2020-05-04",
                publicationTitle: "Journal of Testing",
                DOI: "10.1000/test",
                abstractNote: "An abstract.",
                tags: [{ tag: "method" }],
                relations: {},
                ...data,
            },
        } as any,
    } as any);
    return (await db.items.get([LIB, key]))!;
}

async function seedAttachment(key = "ATTACH01", parentItem = "PARENT01") {
    await seedItem({
        libraryID: LIB,
        key,
        itemType: "attachment",
        parentItem,
        raw: {
            key,
            library: { type: "user", id: LIB, name: "My Library" },
            meta: {},
            data: {
                key,
                itemType: "attachment",
                parentItem,
                filename: "paper.pdf",
                contentType: "application/pdf",
                tags: [],
            },
        } as any,
    } as any);
}

async function seedAnnotation(
    key = "ANNOTAT1",
    parentItem = "ATTACH01",
    data: Record<string, unknown> = {},
    meta: Record<string, unknown> = {},
) {
    await seedItem({
        libraryID: LIB,
        key,
        itemType: "annotation",
        parentItem,
        raw: {
            key,
            library: { type: "user", id: LIB, name: "My Library" },
            meta,
            data: {
                key,
                itemType: "annotation",
                parentItem,
                // Zotero annotations use a restricted HTML subset — <b>, <i>,
                // <sub>, <sup> — not block markup.
                annotationType: "highlight",
                annotationText: "quoted <b>text</b>",
                annotationComment: "my <i>note</i>",
                annotationColor: "#ffd400",
                annotationPageLabel: "5",
                annotationSortIndex: "00000|000000|00000",
                annotationPosition: JSON.stringify({ pageIndex: 4 }),
                tags: [],
                ...data,
            },
        } as any,
    } as any);
}

/** Render `template` against a seeded article, returning the body only. */
async function render(template: string, item?: AnyIDBZoteroItem) {
    const target = item ?? (await seedArticle());
    const out = await service.renderLibrarySourceNote(target, template, {});
    return out.split("---\n").slice(2).join("---\n");
}

describe("frontmatter", () => {
    test("mandatory identity fields are always written", async () => {
        const item = await seedArticle();
        const out = await service.renderLibrarySourceNote(item, "body", {});

        expect(out).toContain("zotflow-locked: true");
        expect(out).toContain("zotero-key: PARENT01");
        expect(out).toContain("item-version: 7");
        expect(out).toContain("library-id: 1");
    });

    test("a bare template key overwrites what the note had", async () => {
        const item = await seedArticle();
        const out = await service.renderLibrarySourceNote(
            item,
            "---\nstatus: {{ item.itemType }}\n---\nbody",
            { status: "hand-written" },
        );

        expect(out).toContain("status: journalArticle");
        expect(out).not.toContain("hand-written");
    });

    test("a `??` key is written only when the note does not have it", async () => {
        const item = await seedArticle();

        const fresh = await service.renderLibrarySourceNote(
            item,
            "---\n??rating: unrated\n---\nbody",
            {},
        );
        expect(fresh).toContain("rating: unrated");

        // The user has since filled it in; an update must not reset it.
        const existing = await service.renderLibrarySourceNote(
            item,
            "---\n??rating: unrated\n---\nbody",
            { rating: "5 stars" },
        );
        expect(existing).toContain("rating: 5 stars");
        expect(existing).not.toContain("unrated");
    });

    test("the `??` prefix never reaches the file", async () => {
        const item = await seedArticle();
        const out = await service.renderLibrarySourceNote(
            item,
            "---\n??rating: unrated\n---\nbody",
            {},
        );
        expect(out).not.toContain("??");
    });

    test("keys the template does not mention are carried over untouched", async () => {
        const item = await seedArticle();
        const out = await service.renderLibrarySourceNote(item, "body", {
            "my-own-field": "kept",
        });
        expect(out).toContain("my-own-field: kept");
    });

    test("liquid runs inside the frontmatter block", async () => {
        const item = await seedArticle();
        const out = await service.renderLibrarySourceNote(
            item,
            "---\ntitle: {{ item.title }}\n---\nbody",
            {},
        );
        expect(out).toContain("title: A Study of Things");
    });

    test("a CRLF template's frontmatter is still detected", async () => {
        const item = await seedArticle();
        const out = await service.renderLibrarySourceNote(
            item,
            "---\r\nstatus: {{ item.itemType }}\r\n---\r\nbody",
            {},
        );
        expect(out).toContain("status: journalArticle");
        expect(out).toContain("body");
        // The template's CRLF delimiters must be consumed by the frontmatter
        // split, not leak into the body (which would mean detection failed).
        expect(out).not.toContain("---\r\n");
    });

    test("unparseable frontmatter is logged and skipped, not fatal", async () => {
        const item = await seedArticle();
        host.parseYaml = () => Promise.reject(new Error("bad yaml"));

        const out = await service.renderLibrarySourceNote(
            item,
            "---\nbroken: [\n---\nbody text",
            {},
        );

        // The body still renders and the identity fields still land.
        expect(out).toContain("body text");
        expect(out).toContain("zotero-key: PARENT01");
        expect(
            host.logsAt("error").some((l) => /Failed to parse template frontmatter/.test(l.message)),
        ).toBe(true);
    });

    test("a template with no frontmatter block still gets one", async () => {
        const item = await seedArticle();
        const out = await service.renderLibrarySourceNote(item, "just a body", {});

        expect(out.startsWith("---\n")).toBe(true);
        expect(out).toContain("just a body");
    });
});

describe("rendering failures", () => {
    test("a broken template surfaces as a parse error", async () => {
        const item = await seedArticle();
        await expect(
            service.renderLibrarySourceNote(item, "{% for %}", {}),
        ).rejects.toThrow(/Template rendering failed/);
    });
});

describe("link filters", () => {
    test("item_link emits a ZotFlow URL by default", async () => {
        expect(await render("{{ item | item_link }}")).toContain(
            "obsidian://zotflow?type=open-note&libraryID=1&key=PARENT01",
        );
    });

    test("item_link emits a native Zotero URL on request", async () => {
        expect(await render('{{ item | item_link: "zotero" }}')).toContain(
            "zotero://select/library/items/PARENT01",
        );
    });

    test("a group library gets the groups/ URI prefix", async () => {
        await seedLibrary({ id: GROUP, type: "group", name: "Group" });
        await seedItem({
            libraryID: GROUP,
            key: "GROUPITM",
            itemType: "journalArticle",
            raw: {
                key: "GROUPITM",
                library: { type: "group", id: GROUP, name: "Group" },
                meta: {},
                data: { key: "GROUPITM", itemType: "journalArticle", relations: {} },
            } as any,
        } as any);
        const item = (await db.items.get([GROUP, "GROUPITM"]))!;

        expect(await render('{{ item | item_link: "zotero" }}', item)).toContain(
            "zotero://select/groups/777/items/GROUPITM",
        );
    });

    test("attachment_link points at the attachment", async () => {
        await seedAttachment();
        const body = await render(
            "{% for a in item.attachments %}{{ a | attachment_link }}{% endfor %}",
        );
        expect(body).toContain(
            "obsidian://zotflow?type=open-attachment&libraryID=1&key=ATTACH01",
        );
    });

    test("annotation_link in Zotero form opens the parent PDF at the annotation", async () => {
        await seedAttachment();
        await seedAnnotation();
        const body = await render(
            '{% for a in item.attachmentAnnotations %}{{ a | annotation_link: "zotero" }}{% endfor %}',
        );
        expect(body).toContain(
            "zotero://open-pdf/library/items/ATTACH01?annotation=ANNOTAT1",
        );
    });

    test("annotation_link in ZotFlow form opens the built-in reader", async () => {
        await seedAttachment();
        await seedAnnotation();
        const body = await render(
            "{% for a in item.attachmentAnnotations %}{{ a | annotation_link }}{% endfor %}",
        );
        expect(body).toContain(
            "obsidian://zotflow?type=open-annotation&libraryID=1&key=ANNOTAT1",
        );
    });

    test("attachment_link in Zotero form opens the PDF", async () => {
        await seedAttachment();
        const body = await render(
            '{% for a in item.attachments %}{{ a | attachment_link: "zotero" }}{% endfor %}',
        );
        expect(body).toContain("zotero://open-pdf/library/items/ATTACH01");
    });

    test("the link filters render nothing for a missing object", async () => {
        const body = await render(
            "[{{ nothing | item_link }}{{ nothing | attachment_link }}{{ nothing | annotation_link }}]",
        );
        expect(body).toContain("[]");
    });

    test("an unknown target argument falls back to ZotFlow", async () => {
        expect(await render('{{ item | item_link: "nonsense" }}')).toContain(
            "obsidian://zotflow",
        );
    });

    test("process_nav_info encodes an annotation id for the reader", async () => {
        const body = await render('{{ "ANNOTAT1" | process_nav_info }}');
        expect(decodeURIComponent(body.trim())).toBe(
            '{"annotationID":"ANNOTAT1"}',
        );
    });
});

describe("wrap_editable", () => {
    test("wraps content in block markers the editor can mount", async () => {
        const body = await render('{{ "text" | wrap_editable: "NOTE", "K1" }}');
        expect(body).toContain(
            "<!-- ZF_NOTE_BEG_K1 -->\ntext\n<!-- ZF_NOTE_END_K1 -->",
        );
    });

    test("a read-only annotation renders as plain locked text", async () => {
        // External annotations cannot be written back, so wrapping them would
        // offer an edit that silently fails.
        await seedAttachment();
        await seedAnnotation("ANNOTAT1", "ATTACH01", {
            annotationIsExternal: true,
        });

        const body = await render(
            '{% for a in item.attachmentAnnotations %}{{ a.comment | wrap_editable: "ANNO", a.key }}{% endfor %}',
        );
        expect(body).not.toContain("ZF_ANNO_BEG_ANNOTAT1");
        // The content is still there — only the editable wrapper is withheld.
        expect(body).toContain("my *note*");
    });

    test("a writable annotation is wrapped", async () => {
        await seedAttachment();
        await seedAnnotation();

        const body = await render(
            '{% for a in item.attachmentAnnotations %}{{ a.comment | wrap_editable: "ANNO", a.key }}{% endfor %}',
        );
        expect(body).toContain("ZF_ANNO_BEG_ANNOTAT1");
    });

    test("missing type or key leaves the input alone", async () => {
        expect(await render('{{ "text" | wrap_editable: "", "K1" }}')).toContain(
            "text",
        );
        expect(await render('{{ "text" | wrap_editable: "NOTE", "" }}')).not.toContain(
            "ZF_NOTE",
        );
    });
});

describe("html2md filter", () => {
    test("converts a Zotero note body to markdown", async () => {
        await seedItem({
            libraryID: LIB,
            key: "NOTECHLD",
            itemType: "note",
            parentItem: "PARENT01",
            raw: {
                key: "NOTECHLD",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: {
                    key: "NOTECHLD",
                    itemType: "note",
                    parentItem: "PARENT01",
                    note: "<p>Hello <strong>world</strong></p>",
                    tags: [],
                },
            } as any,
        } as any);

        const body = await render(
            "{% for n in item.notes %}{{ n.note | html2md }}{% endfor %}",
        );
        expect(body).toContain("Hello **world**");
    });

    test("empty input yields an empty string", async () => {
        expect((await render('[{{ "" | html2md }}]')).trim()).toBe("[]");
    });
});

describe("item context", () => {
    test("exposes the bibliographic fields", async () => {
        const body = await render(
            "{{ item.title }}|{{ item.year }}|{{ item.publicationTitle }}|{{ item.DOI }}|{{ item.citationKey }}",
        );
        expect(body.trim()).toBe(
            "A Study of Things|2020|Journal of Testing|10.1000/test|doe2020",
        );
    });

    test("every bibliographic field reaches the template", async () => {
        // These are only ever read by user templates, so nothing else in the
        // suite notices if one stops being mapped. One test covers them all
        // rather than eighteen near-identical ones.
        const fields: Record<string, string> = {
            date: "2020-05-04",
            accessDate: "2021-02-03",
            publisher: "Test House",
            place: "Vienna",
            volume: "12",
            issue: "3",
            pages: "45-67",
            series: "Studies in Testing",
            seriesNumber: "IV",
            edition: "2nd",
            url: "https://example.org/paper",
            ISBN: "978-3-16-148410-0",
            ISSN: "1234-5678",
        };

        const item = await seedArticle("PARENT01", fields);
        const body = await render(
            Object.keys(fields)
                .map((k) => `${k}=[{{ item.${k} }}]`)
                .join("\n"),
            item,
        );

        for (const [key, value] of Object.entries(fields)) {
            expect(body).toContain(`${key}=[${value}]`);
        }
    });

    test("base fields resolve through type-specific stand-ins", async () => {
        // A case keeps its title in caseName, its date in dateDecided and its
        // court under the `authority` base field; templates see base names.
        await seedItem({
            libraryID: LIB,
            key: "CASE0001",
            itemType: "case",
            title: "Roe v. Wade",
            raw: {
                key: "CASE0001",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: {
                    key: "CASE0001",
                    itemType: "case",
                    caseName: "Roe v. Wade",
                    court: "Supreme Court",
                    dateDecided: "1973-01-22",
                    docketNumber: "70-18",
                    reporter: "U.S.",
                    tags: [],
                    relations: {},
                },
            } as any,
        } as any);
        const item = (await db.items.get([LIB, "CASE0001"]))!;

        const body = await render(
            "{{ item.title }}|{{ item.year }}|{{ item.authority }}|{{ item.number }}|{{ item.reporter }}|{{ item.caseName }}",
            item,
        );
        expect(body.trim()).toBe(
            "Roe v. Wade|1973|Supreme Court|70-18|U.S.|Roe v. Wade",
        );
    });

    test("a book section's publicationTitle is its bookTitle", async () => {
        await seedItem({
            libraryID: LIB,
            key: "SECTION1",
            itemType: "bookSection",
            raw: {
                key: "SECTION1",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: {
                    key: "SECTION1",
                    itemType: "bookSection",
                    title: "Chapter One",
                    bookTitle: "The Whole Book",
                    tags: [],
                    relations: {},
                },
            } as any,
        } as any);
        const item = (await db.items.get([LIB, "SECTION1"]))!;

        // Both names resolve, as with Zotero's getField().
        expect(
            (
                await render(
                    "{{ item.publicationTitle }}|{{ item.bookTitle }}",
                    item,
                )
            ).trim(),
        ).toBe("The Whole Book|The Whole Book");
    });

    test("every schema field reaches the template", async () => {
        // Not a hand-kept list: anything in the Zotero schema is exposed.
        const item = await seedArticle("PARENT01", {
            extra: "Original date: 1999",
            shortTitle: "Things",
            language: "en",
            journalAbbreviation: "J. Test.",
            callNumber: "QA76",
            archiveLocation: "Box 3",
            PMID: "123456",
        });
        const body = await render(
            "{{ item.extra }}|{{ item.shortTitle }}|{{ item.language }}|{{ item.journalAbbreviation }}|{{ item.callNumber }}|{{ item.archiveLocation }}|{{ item.PMID }}",
            item,
        );
        expect(body.trim()).toBe(
            "Original date: 1999|Things|en|J. Test.|QA76|Box 3|123456",
        );
    });

    test("fields the item lacks are absent, so `if` skips them", async () => {
        const body = await render(
            "{% if item.bookTitle %}yes{% else %}no{% endif %}",
        );
        expect(body.trim()).toBe("no");
    });

    test("tags reach the template", async () => {
        const item = await seedArticle("PARENT01", {
            tags: [{ tag: "alpha" }, { tag: "beta" }],
        });
        const body = await render(
            "{% for t in item.tags %}{{ t.tag }};{% endfor %}",
            item,
        );
        expect(body.trim()).toBe("alpha;beta;");
    });

    test("an item with no tags exposes an empty list", async () => {
        const item = await seedArticle("PARENT01", { tags: undefined });
        const body = await render("[{{ item.tags.size }}]", item);
        expect(body.trim()).toBe("[0]");
    });

    test("creators come from first/last name pairs", async () => {
        expect(await render("{{ item.creators[0].name }}")).toContain("Jane Doe");
    });

    test("creators keep their role and name parts", async () => {
        const item = await seedArticle("PARENT01", {
            creators: [
                { creatorType: "author", firstName: "Jane", lastName: "Doe" },
                { creatorType: "editor", name: "Acme Institute" },
            ],
        });
        const body = await render(
            "{% for c in item.creators %}{{ c.creatorType }}:{{ c.lastName }}:{{ c.name }};{% endfor %}",
            item,
        );
        expect(body.trim()).toBe("author:Doe:Jane Doe;editor::Acme Institute;");
    });

    test("Zotero's creator summary is its own variable", async () => {
        // It used to be read from a misspelt `creatorsSummary`, which the API
        // never sends; when it did apply, it replaced the creators list.
        await seedItem({
            libraryID: LIB,
            key: "PARENT01",
            itemType: "journalArticle",
            raw: {
                key: "PARENT01",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: { creatorSummary: "Doe et al." },
                data: {
                    key: "PARENT01",
                    itemType: "journalArticle",
                    creators: [{ firstName: "Jane", lastName: "Doe" }],
                    relations: {},
                },
            } as any,
        } as any);
        const item = (await db.items.get([LIB, "PARENT01"]))!;

        expect(
            (
                await render(
                    "{{ item.creatorSummary }}|{{ item.creators[0].name }}",
                    item,
                )
            ).trim(),
        ).toBe("Doe et al.|Jane Doe");
    });

    test("itemPaths carries the collection breadcrumbs", async () => {
        expect(await render("{{ item.itemPaths[0] }}")).toContain("My Library/");
    });

    test("child notes, attachments and annotations are collected", async () => {
        await seedAttachment();
        await seedAnnotation();
        await seedItem({
            libraryID: LIB,
            key: "NOTECHLD",
            itemType: "note",
            parentItem: "PARENT01",
            title: "A note",
            raw: {
                key: "NOTECHLD",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: { key: "NOTECHLD", itemType: "note", note: "", tags: [] },
            } as any,
        } as any);

        const body = await render(
            "n={{ item.notes.size }} a={{ item.attachments.size }} aa={{ item.attachmentAnnotations.size }}",
        );
        expect(body.trim()).toBe("n=1 a=1 aa=1");
    });

    test("trashed children are excluded", async () => {
        await seedAttachment();
        await seedItem({
            libraryID: LIB,
            key: "TRASHATT",
            itemType: "attachment",
            parentItem: "PARENT01",
            trashed: 1,
            raw: {
                key: "TRASHATT",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: { key: "TRASHATT", itemType: "attachment", tags: [] },
            } as any,
        } as any);

        expect((await render("{{ item.attachments.size }}")).trim()).toBe("1");
    });

    test("annotation text and comment arrive as markdown", async () => {
        await seedAttachment();
        await seedAnnotation();

        const body = await render(
            "{% for a in item.attachmentAnnotations %}[{{ a.text }}][{{ a.comment }}][{{ a.pageLabel }}][{{ a.color }}]{% endfor %}",
        );
        // The restricted subset maps onto native markdown.
        expect(body).toContain("[quoted **text**][my *note*][5][#ffd400]");
    });

    test("markup outside the allowed subset is escaped, not rendered", async () => {
        // Annotation bodies come from PDFs and other clients; letting arbitrary
        // HTML through would inject it into the user's note.
        await seedAttachment();
        await seedAnnotation("ANNOTAT1", "ATTACH01", {
            annotationComment: '<script>alert(1)</script> and > a quote',
        });

        const body = await render(
            "{% for a in item.attachmentAnnotations %}{{ a.comment }}{% endfor %}",
        );
        expect(body).toContain("\\<script\\>");
        expect(body).not.toContain("<script>");
        // A leading `>` would otherwise start a blockquote.
        expect(body).toContain("\\>");
    });

    test("attachment metadata is exposed", async () => {
        await seedAttachment();
        const body = await render(
            "{% for a in item.attachments %}{{ a.filename }}|{{ a.contentType }}{% endfor %}",
        );
        expect(body).toContain("paper.pdf|application/pdf");
    });

    test("settings are visible to the template with a normalized image folder", async () => {
        // The trailing slash is stripped so templates can write `{{ folder }}/x.png`.
        expect(
            (await render("{{ settings.annotationImageFolder }}")).trim(),
        ).toBe("ZotFlow/images");
    });
});

describe("related items", () => {
    test("a resolvable relation carries its title and note path", async () => {
        await seedItem({
            libraryID: LIB,
            key: "RELATED1",
            itemType: "book",
            title: "The Related Book",
            citationKey: "roe2021",
        });
        const item = await seedArticle("PARENT01", {
            relations: {
                "dc:relation": "http://zotero.org/users/1/items/RELATED1",
            },
        });

        const body = await render(
            "{% for r in item.relatedItems %}{{ r.resolved }}|{{ r.title }}|{{ r.itemType }}|{{ r.citationKey }}|{{ r.notePath }}{% endfor %}",
            item,
        );
        expect(body).toContain("true|The Related Book|book|roe2021|");
        expect(body).toContain(".md");
    });

    test("notePath is the indexed location, not the template's", async () => {
        // The note was created before its citation key changed, so it still
        // lives at the old path. Re-rendering the template would point at
        // `@roe2021`, where no file exists.
        await seedItem({
            libraryID: LIB,
            key: "RELATED1",
            itemType: "book",
            title: "The Related Book",
            citationKey: "roe2021",
        });
        host.keyIndex.set("RELATED1", "Source/Moved/@roe.md");

        const item = await seedArticle("PARENT01", {
            relations: {
                "dc:relation": "http://zotero.org/users/1/items/RELATED1",
            },
        });

        const body = await render(
            "{% for r in item.relatedItems %}{{ r.notePath }}{% endfor %}",
            item,
        );
        expect(body.trim()).toBe("Source/Moved/@roe.md");
        expect(body).not.toContain("roe2021");
    });

    test("notePath falls back to the template when nothing is indexed", async () => {
        await seedItem({
            libraryID: LIB,
            key: "RELATED1",
            itemType: "book",
            title: "The Related Book",
            citationKey: "roe2021",
        });
        // No keyIndex entry: the note does not exist yet.
        const item = await seedArticle("PARENT01", {
            relations: {
                "dc:relation": "http://zotero.org/users/1/items/RELATED1",
            },
        });

        const body = await render(
            "{% for r in item.relatedItems %}{{ r.notePath }}{% endfor %}",
            item,
        );
        expect(body).toContain("roe2021");
        expect(body.trim().endsWith(".md")).toBe(true);
    });

    test("a relation to an item we do not have is reported unresolved", async () => {
        const item = await seedArticle("PARENT01", {
            relations: {
                "dc:relation": "http://zotero.org/users/1/items/MISSING1",
            },
        });

        const body = await render(
            "{% for r in item.relatedItems %}{{ r.key }}={{ r.resolved }}{% endfor %}",
            item,
        );
        expect(body).toContain("MISSING1=false");
    });

    test("several relations are all mapped", async () => {
        await seedItem({ libraryID: LIB, key: "RELATED1", title: "One" });
        await seedItem({ libraryID: LIB, key: "RELATED2", title: "Two" });
        const item = await seedArticle("PARENT01", {
            relations: {
                "dc:relation": [
                    "http://zotero.org/users/1/items/RELATED1",
                    "http://zotero.org/users/1/items/RELATED2",
                ],
            },
        });

        expect(
            (await render("{{ item.relatedItems.size }}", item)).trim(),
        ).toBe("2");
    });

    test("a malformed relation URI is dropped", async () => {
        const item = await seedArticle("PARENT01", {
            relations: { "dc:relation": "not-a-zotero-uri" },
        });
        expect(
            (await render("{{ item.relatedItems.size }}", item)).trim(),
        ).toBe("0");
    });

    test("relations of other kinds are ignored", async () => {
        const item = await seedArticle("PARENT01", {
            relations: {
                "owl:sameAs": "http://zotero.org/users/1/items/RELATED1",
            },
        });
        expect(
            (await render("{{ item.relatedItems.size }}", item)).trim(),
        ).toBe("0");
    });

    test("no relations at all yields an empty list", async () => {
        expect((await render("{{ item.relatedItems.size }}")).trim()).toBe("0");
    });
});

describe("citation and bibliography filters", () => {
    test("an item renders through the configured default style", async () => {
        const body = await render("{{ item | citation }}");

        expect(body).toContain("(cite:PARENT01)");
        expect(cslCalls).toHaveLength(1);
        expect(cslCalls[0]!.kind).toBe("citation");
        expect(cslCalls[0]!.opts.styleId).toBe("apa");
        expect(cslCalls[0]!.props).toBeUndefined();
    });

    test("a positional argument overrides the style", async () => {
        await render('{{ item | citation: "ieee" }}');
        expect(cslCalls[0]!.opts.styleId).toBe("ieee");
    });

    test("keyword arguments set style, locale and format", async () => {
        await render(
            '{{ item | citation: style: "nature", locale: "de-DE", format: "html" }}',
        );
        expect(cslCalls[0]!.opts).toMatchObject({
            styleId: "nature",
            locale: "de-DE",
            format: "html",
        });
    });

    test("a list of items becomes one cluster, not one call each", async () => {
        // citeproc merges and sorts across the whole cluster; looping in the
        // template would defeat that.
        await seedItem({
            libraryID: LIB,
            key: "SECONDIT",
            itemType: "book",
            csljson: { id: "SECONDIT", type: "book" } as any,
        } as any);
        const item = await seedArticle();

        const body = await render(
            "{% assign both = item.relatedItems %}{{ item | citation }}",
            item,
        );
        expect(body).toContain("(cite:PARENT01)");
        expect(cslCalls).toHaveLength(1);
    });

    test("bibliography entries are joined, and the separator is configurable", async () => {
        await render("{{ item | bibliography }}");
        expect(cslCalls[0]!.kind).toBe("bibliography");

        cslCalls = [];
        const body = await render('{{ item | bibliography: join: " / " }}');
        expect(body).toContain("bib:PARENT01");
    });

    test("an unknown output format is rejected by name", async () => {
        await expect(
            render('{{ item | citation: format: "latex" }}'),
        ).rejects.toThrow(/Unknown CSL output format "latex"/);
    });

    test("an unknown keyword argument is rejected", async () => {
        await expect(
            render('{{ item | citation: styel: "apa" }}'),
        ).rejects.toThrow(/Unknown argument "styel"/);
    });

    test("a non-scalar argument value is rejected", async () => {
        await expect(
            render("{{ item | citation: style: item.tags }}"),
        ).rejects.toThrow(/must be a string/);
    });

    test("an empty list is rejected rather than rendering nothing", async () => {
        // Silently producing "" would hide a template mistake.
        await expect(
            render("{% assign none = item.relatedItems %}{{ none | citation }}"),
        ).rejects.toThrow(/citation filter received an empty item list/);
        await expect(
            render(
                "{% assign none = item.relatedItems %}{{ none | bibliography }}",
            ),
        ).rejects.toThrow(/bibliography filter received an empty item list/);
    });

    test("something that is not a context item is rejected with guidance", async () => {
        await expect(render('{{ "just a string" | citation }}')).rejects.toThrow(
            /needs a Zotero item from the template context/,
        );
    });

    test("an item that is not in the DB is a resource error", async () => {
        const item = await seedArticle();
        await db.items.delete([LIB, "PARENT01"]);

        await expect(
            service.renderLibrarySourceNote(item, "{{ item | citation }}", {}),
        ).rejects.toThrow(/Item not found/);
    });

    for (const itemType of ["attachment", "note", "annotation"] as const) {
        test(`a ${itemType} cannot be cited`, async () => {
            const item = await seedArticle();
            await seedItem({
                libraryID: LIB,
                key: "CHILD001",
                itemType,
                parentItem: "PARENT01",
                title: "Child",
            });

            await expect(
                service.renderLibrarySourceNote(
                    item,
                    `{% assign c = item %}{{ item.notes }}{{ item | citation }}`,
                    {},
                ),
            ).resolves.toBeTruthy();

            // Cite the child directly through a preview render.
            const child = (await db.items.get([LIB, "CHILD001"]))!;
            await expect(
                service.renderLibrarySourceNote(child, "{{ item | citation }}", {}),
            ).rejects.toThrow(new RegExp(`is a ${itemType} — only regular items`));
        });
    }
});

describe("citing an annotation", () => {
    beforeEach(async () => {
        await seedAttachment();
        await seedAnnotation();
    });

    test("cites the annotated item with the page as locator", async () => {
        const body = await render(
            "{% for a in item.attachmentAnnotations %}{{ a | citation }}{% endfor %}",
        );

        expect(body).toContain("(cite:PARENT01)");
        expect(cslCalls[0]!.items[0]!.id).toBe("PARENT01");
        expect(cslCalls[0]!.props).toEqual([
            { locator: "5", label: "page" },
        ]);
    });

    test("an annotation with no page label cites without a locator", async () => {
        await seedAnnotation("ANNOTAT2", "ATTACH01", {
            annotationPageLabel: "",
        });

        const body = await render(
            "{% for a in item.attachmentAnnotations %}{% if a.key == 'ANNOTAT2' %}{{ a | citation }}{% endif %}{% endfor %}",
        );
        expect(body).toContain("(cite:PARENT01)");
        expect(cslCalls[0]!.props).toBeUndefined();
    });

    test("an annotation with no parent attachment has nothing to cite", async () => {
        await seedArticle();
        // Citation-template inputs carry their own parentItem; an annotation
        // that arrives without one cannot be traced to a citable item.
        await expect(
            service.previewCitationTemplate(
                {
                    item: { libraryID: LIB, key: "PARENT01" },
                    annotations: [
                        { id: "ANNOTAT9", libraryID: LIB, type: "highlight", pageLabel: "1" },
                    ],
                } as any,
                "{{ annotations[0] | citation }}",
            ),
        ).rejects.toThrow(/no parent attachment/);
    });

    test("an annotation whose attachment row is gone is a resource error", async () => {
        await seedArticle();
        await expect(
            service.previewCitationTemplate(
                {
                    item: { libraryID: LIB, key: "PARENT01" },
                    annotations: [
                        {
                            id: "ANNOTAT9",
                            libraryID: LIB,
                            type: "highlight",
                            pageLabel: "1",
                            parentItem: "GHOSTATT",
                        },
                    ],
                } as any,
                "{{ annotations[0] | citation }}",
            ),
        ).rejects.toThrow(/Attachment not found: 1\/GHOSTATT/);
    });

    test("an annotation on a standalone attachment has nothing to cite", async () => {
        await seedItem({
            libraryID: LIB,
            key: "LONEATT0",
            itemType: "attachment",
            raw: {
                key: "LONEATT0",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: { key: "LONEATT0", itemType: "attachment", tags: [] },
            } as any,
        } as any);
        await seedAnnotation("ANNOTAT3", "LONEATT0");
        const lone = (await db.items.get([LIB, "LONEATT0"]))!;

        await expect(
            service.renderLibrarySourceNote(
                lone,
                "{% for a in item.annotations %}{{ a | citation }}{% endfor %}",
                {},
            ),
        ).rejects.toThrow(/standalone attachment/);
    });
});

describe("CSL-JSON backfill", () => {
    test("an item synced before csljson existed is refetched once", async () => {
        await seedItem({
            libraryID: LIB,
            key: "OLDITEM0",
            itemType: "journalArticle",
            title: "Old Item",
            csljson: undefined,
            raw: {
                key: "OLDITEM0",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: { key: "OLDITEM0", itemType: "journalArticle", relations: {} },
            } as any,
        } as any);
        const item = (await db.items.get([LIB, "OLDITEM0"]))!;

        const { createFakeZoteroServer } = await import("../fakes/zotero-server");
        const server = createFakeZoteroServer({ apiKey: API_KEY, userID: LIB });
        server.install();
        server.library(LIB).addItem({
            key: "OLDITEM0",
            csljson: { id: "OLDITEM0", type: "article-journal" },
        });

        try {
            await service.renderLibrarySourceNote(item, "{{ item | citation }}", {});
        } finally {
            server.restore();
        }

        // Stored, so the next render costs nothing.
        expect((await db.items.get([LIB, "OLDITEM0"]))!.csljson).toMatchObject({
            id: "OLDITEM0",
        });
    });

    test("an unreachable server is reported as a network failure", async () => {
        await seedItem({
            libraryID: LIB,
            key: "OLDITEM0",
            itemType: "journalArticle",
            title: "Old Item",
            csljson: undefined,
            raw: {
                key: "OLDITEM0",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: { key: "OLDITEM0", itemType: "journalArticle", relations: {} },
            } as any,
        } as any);
        const item = (await db.items.get([LIB, "OLDITEM0"]))!;

        const { createFakeZoteroServer } = await import("../fakes/zotero-server");
        const server = createFakeZoteroServer({ apiKey: API_KEY, userID: LIB });
        server.install();
        server.failNext({ networkError: true, pathIncludes: "/items" });

        try {
            await expect(
                service.renderLibrarySourceNote(item, "{{ item | citation }}", {}),
            ).rejects.toThrow(/Couldn't fetch citation data/);
        } finally {
            server.restore();
        }
    });

    test("a server that returns no citation data says so", async () => {
        await seedItem({
            libraryID: LIB,
            key: "OLDITEM0",
            itemType: "journalArticle",
            title: "Old Item",
            csljson: undefined,
            raw: {
                key: "OLDITEM0",
                library: { type: "user", id: LIB, name: "My Library" },
                meta: {},
                data: { key: "OLDITEM0", itemType: "journalArticle", relations: {} },
            } as any,
        } as any);
        const item = (await db.items.get([LIB, "OLDITEM0"]))!;

        const { createFakeZoteroServer } = await import("../fakes/zotero-server");
        const server = createFakeZoteroServer({ apiKey: API_KEY, userID: LIB });
        server.install();
        server.library(LIB).addItem({ key: "OLDITEM0" }); // no csljson

        try {
            await expect(
                service.renderLibrarySourceNote(item, "{{ item | citation }}", {}),
            ).rejects.toThrow(/returned no citation data/);
        } finally {
            server.restore();
        }
    });
});

describe("templates from settings", () => {
    test("getDefaultTemplate reads the configured file", async () => {
        await setup({ librarySourceNoteTemplatePath: "Templates/source.md" });
        host.vault.set("Templates/source.md", "# custom template");

        expect(await service.getDefaultTemplate()).toBe("# custom template");
    });

    test("an unreadable template path falls back to the built-in default", async () => {
        await setup({ librarySourceNoteTemplatePath: "Templates/gone.md" });
        host.readTextFile = () => Promise.reject(new Error("ENOENT"));

        expect(await service.getDefaultTemplate()).toContain("citationKey:");
    });

    test("no configured path means the built-in default", async () => {
        expect(await service.getDefaultTemplate()).toContain("citationKey:");
    });

    test("the built-in default renders against a real item", async () => {
        const item = await seedArticle();
        const out = await service.renderLibrarySourceNote(item, null, {});

        expect(out).toContain("# A Study of Things");
        expect(out).toContain("## Abstract");
        expect(out).toContain("zotero-key: PARENT01");
    });
});

describe("preview", () => {
    test("renders a stored item with a caller's template", async () => {
        await seedArticle();
        expect(
            await service.previewLibrarySourceNote(LIB, "PARENT01", "{{ item.title }}"),
        ).toContain("A Study of Things");
    });

    test("an unknown item is a resource error", async () => {
        await expect(
            service.previewLibrarySourceNote(LIB, "MISSING1", "x"),
        ).rejects.toThrow(/Item not found: 1\/MISSING1/);
    });
});

describe("citation templates", () => {
    const input = () => ({ item: { libraryID: LIB, key: "PARENT01" } }) as any;

    beforeEach(async () => {
        await seedArticle();
    });

    test("pandoc falls back to the built-in form", async () => {
        expect(
            await service.renderCitationTemplate(input(), "Note.md", "pandoc"),
        ).toBe("[@doe2020]");
    });

    test("footnote-ref falls back to the built-in form", async () => {
        expect(
            await service.renderCitationTemplate(
                input(),
                "Note.md",
                "footnote-ref",
            ),
        ).toBe("[^doe2020]");
    });

    test("wikilink uses the note path", async () => {
        const out = await service.renderCitationTemplate(
            input(),
            "Source/A Study.md",
            "wikilink",
        );
        expect(out).toContain("[[Source/A Study.md|Jane Doe (2020)]]");
    });

    test("footnote includes the creator and year", async () => {
        const out = await service.renderCitationTemplate(
            input(),
            "Note.md",
            "footnote",
        );
        expect(out).toContain("[^doe2020]:");
        expect(out).toContain("Jane Doe");
    });

    test("a configured template wins over the fallback", async () => {
        await setup({ citationPandocTemplate: "CUSTOM {{ item.key }}" });
        await seedArticle();

        expect(
            await service.renderCitationTemplate(input(), "Note.md", "pandoc"),
        ).toBe("CUSTOM PARENT01");
    });

    test("annotations are passed through with page labels", async () => {
        const out = await service.renderCitationTemplate(
            {
                item: { libraryID: LIB, key: "PARENT01" },
                annotations: [
                    { id: "ANNOTAT1", libraryID: LIB, type: "highlight", pageLabel: "12" },
                ],
            } as any,
            "Note.md",
            "pandoc",
        );
        expect(out).toBe("[@doe2020, pp. 12]");
    });

    test("an unknown item is a resource error", async () => {
        await expect(
            service.renderCitationTemplate(
                { item: { libraryID: LIB, key: "MISSING1" } } as any,
                "Note.md",
                "pandoc",
            ),
        ).rejects.toThrow(/Item not found/);
    });

    test("getDefaultCitationTemplate reports each format's fallback", async () => {
        expect(service.getDefaultCitationTemplate("pandoc")).toContain("[@");
        expect(service.getDefaultCitationTemplate("wikilink")).toContain("[[");
        expect(service.getDefaultCitationTemplate("footnote-ref")).toContain("[^");
        expect(service.getDefaultCitationTemplate("footnote")).toContain("[^");
    });

    test("getDefaultCitationTemplate reports a configured template", async () => {
        await setup({
            citationPandocTemplate: "P",
            citationWikilinkTemplate: "W",
            citationFootnoteRefTemplate: "FR",
            citationFootnoteTemplate: "F",
        });

        expect(service.getDefaultCitationTemplate("pandoc")).toBe("P");
        expect(service.getDefaultCitationTemplate("wikilink")).toBe("W");
        expect(service.getDefaultCitationTemplate("footnote-ref")).toBe("FR");
        expect(service.getDefaultCitationTemplate("footnote")).toBe("F");
    });

    test("each format honours its own configured template", async () => {
        await setup({
            citationWikilinkTemplate: "W:{{ item.key }}",
            citationFootnoteRefTemplate: "FR:{{ item.key }}",
            citationFootnoteTemplate: "F:{{ item.key }}",
        });
        await seedArticle();

        expect(
            await service.renderCitationTemplate(input(), "N.md", "wikilink"),
        ).toBe("W:PARENT01");
        expect(
            await service.renderCitationTemplate(input(), "N.md", "footnote-ref"),
        ).toBe("FR:PARENT01");
        expect(
            await service.renderCitationTemplate(input(), "N.md", "footnote"),
        ).toBe("F:PARENT01");
    });

    test("previewCitationTemplate exposes annotations too", async () => {
        const out = await service.previewCitationTemplate(
            {
                item: { libraryID: LIB, key: "PARENT01" },
                annotations: [
                    { id: "ANNOTAT1", libraryID: LIB, type: "highlight", pageLabel: "9" },
                ],
            } as any,
            "{{ annotations[0].pageLabel }}",
        );
        expect(out).toBe("9");
    });

    test("previewCitationTemplate resolves the note path itself", async () => {
        const out = await service.previewCitationTemplate(
            input(),
            "{{ notePath }}",
        );
        expect(out).toContain(".md");
    });

    test("previewCitationTemplate prefers the indexed note path", async () => {
        host.keyIndex.set("PARENT01", "Source/Moved/@elsewhere.md");
        const out = await service.previewCitationTemplate(
            input(),
            "{{ notePath }}",
        );
        expect(out).toBe("Source/Moved/@elsewhere.md");
    });

    test("previewCitationTemplate rejects an unknown item", async () => {
        await expect(
            service.previewCitationTemplate(
                { item: { libraryID: LIB, key: "MISSING1" } } as any,
                "x",
            ),
        ).rejects.toThrow(/Item not found/);
    });
});

describe("settings updates", () => {
    test("updateSettings changes the default CSL style for later renders", async () => {
        await render("{{ item | citation }}");
        expect(cslCalls[0]!.opts.styleId).toBe("apa");

        service.updateSettings({ ...settings, cslDefaultStyleId: "ieee" });
        cslCalls = [];

        await render("{{ item | citation }}");
        expect(cslCalls[0]!.opts.styleId).toBe("ieee");
    });
});
