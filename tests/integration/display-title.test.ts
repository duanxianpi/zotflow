/**
 * Display titles — the user's template for how items are named in the tree
 * view and the item search modals, with the Zotero title as the fallback.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import {
    DISPLAY_TITLE_APPLY_DELAY,
    DisplayTitleService,
} from "worker/services/display-title";
import { SearchMatcher } from "worker/services/search-matcher";
import { TreeViewService } from "worker/services/tree-view";
import { DEFAULT_SETTINGS } from "settings/types";
import { db, seedItem } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";
import { createServiceHarness, USER_ID } from "../fakes/services";

import type { AnyIDBZoteroItem } from "types/db-schema";
import type { ServiceHarness } from "../fakes/services";

const TEMPLATE =
    "{{ item.creators[0].lastName }} ({{ item.year }}) {{ item.title }}";

/** Seed a journal article and hand back the stored row. */
async function article(
    key = "ARTICLE1",
    over: Partial<AnyIDBZoteroItem> = {},
    data: Record<string, unknown> = {},
): Promise<AnyIDBZoteroItem> {
    await seedItem({
        libraryID: USER_ID,
        key,
        title: "Attention Is All You Need",
        citationKey: "vaswani2017",
        raw: {
            key,
            version: 1,
            library: { type: "user", id: USER_ID, name: "My Library" },
            meta: {},
            data: {
                key,
                version: 1,
                itemType: "journalArticle",
                title: "Attention Is All You Need",
                creators: [
                    {
                        creatorType: "author",
                        firstName: "Ashish",
                        lastName: "Vaswani",
                    },
                ],
                date: "2017-06-12",
                tags: [],
                relations: {},
                ...data,
            },
        } as any,
        ...over,
    });
    return (await db.items.get([USER_ID, key]))!;
}

function service(template: string, host = createFakeParentHost()) {
    return new DisplayTitleService(settingsWith(template), host);
}

function settingsWith(template: string) {
    return { ...DEFAULT_SETTINGS, itemDisplayTitleTemplate: template };
}

// Fake timers only around the synchronous debounce steps: fake-indexeddb
// schedules its own work on timers, so DB calls run with real ones.
afterEach(() => {
    vi.useRealTimers();
});

describe("DisplayTitleService", () => {
    beforeEach(async () => {
        await createServiceHarness();
    });

    test("with no template, the Zotero title is shown", async () => {
        const item = await article();
        expect(service("").get(item)).toBe("Attention Is All You Need");
    });

    test("renders the template against the item variables", async () => {
        const item = await article();
        expect(service(TEMPLATE).get(item)).toBe(
            "Vaswani (2017) Attention Is All You Need",
        );
    });

    test("base-mapped fields are available, as in source-note templates", async () => {
        const item = await article(
            "CASE0001",
            { itemType: "case", title: "Roe v. Wade" },
            {
                itemType: "case",
                caseName: "Roe v. Wade",
                court: "SCOTUS",
                title: undefined,
            },
        );
        expect(
            service("{{ item.authority }}: {{ item.title }}").get(item),
        ).toBe("SCOTUS: Roe v. Wade");
    });

    test("whitespace left by tags collapses to one line", async () => {
        const item = await article();
        expect(
            service(
                "{% if item.citationKey %}\n  @{{ item.citationKey }}\n{% endif %}  {{ item.year }}",
            ).get(item),
        ).toBe("@vaswani2017 2017");
    });

    test("an empty render falls back to the Zotero title", async () => {
        const item = await article();
        expect(service("{{ item.doesNotExist }}").get(item)).toBe(
            "Attention Is All You Need",
        );
    });

    test("an invalid template falls back and is reported once", async () => {
        const host = createFakeParentHost();
        const item = await article();
        expect(service("{{ item.title", host).get(item)).toBe(
            "Attention Is All You Need",
        );
        expect(host.logsAt("warn")).toHaveLength(1);
    });

    test("a render failure falls back and is reported once", async () => {
        const host = createFakeParentHost();
        const titles = service("{% include 'missing' %}", host);
        const first = await article("ARTICLE1");
        const second = await article("ARTICLE2");

        expect(titles.get(first)).toBe("Attention Is All You Need");
        expect(titles.get(second)).toBe("Attention Is All You Need");
        expect(host.logsAt("warn")).toHaveLength(1);
    });

    test("notes and annotations keep their own names", async () => {
        const note = await article("NOTE0001", {
            itemType: "note",
            title: "Reading notes",
        });
        const annotation = await article("ANNOT001", {
            itemType: "annotation",
            title: "highlighted text",
        });
        expect(service(TEMPLATE).get(note)).toBe("Reading notes");
        expect(service(TEMPLATE).get(annotation)).toBe("highlighted text");
    });

    test("attachments are titled by the template, with their file properties", async () => {
        const attachment = await article(
            "ATTACH01",
            { itemType: "attachment", title: "Full Text PDF" },
            {
                itemType: "attachment",
                title: "Full Text PDF",
                creators: undefined,
                filename: "Vaswani - 2017.pdf",
                contentType: "application/pdf",
                linkMode: "imported_file",
            },
        );
        const titles = service(
            '{% if item.itemType == "attachment" %}{{ item.title }} [{{ item.filename }}, {{ item.contentType }}, {{ item.linkMode }}]{% else %}{{ item.title }}{% endif %}',
        );
        expect(titles.get(attachment)).toBe(
            "Full Text PDF [Vaswani - 2017.pdf, application/pdf, imported_file]",
        );
    });

    test("a template written for regular items leaves attachments their own names", async () => {
        // It would otherwise title every attachment "Vaswani (2017) Full Text PDF" or " - ".
        const attachment = await article("ATTACH01", { itemType: "attachment", title: "Full Text PDF" }, { itemType: "attachment" });
        expect(service(TEMPLATE).get(attachment)).toBe("Full Text PDF");
        // Mentioning the type without naming attachments is not enough either.
        expect(service('{% if item.itemType == "book" %}B{% endif %}{{ item.title }}x').get(attachment)).toBe("Full Text PDF");
    });

    test("a local edit (same version) is re-rendered", async () => {
        const titles = service("{{ item.title }} {{ item.tags | size }}");
        const item = await article();
        expect(titles.get(item)).toBe("Attention Is All You Need 0");

        const tagged = structuredClone(item);
        (tagged.raw.data as { tags: unknown[] }).tags = [{ tag: "x" }];
        tagged.localRevision = (item.localRevision ?? 0) + 1;
        expect(titles.get(tagged)).toBe("Attention Is All You Need 1");
    });

    test("a regular item has no attachment file properties", async () => {
        const item = await article();
        expect(service("{{ item.filename }}|{{ item.title }}").get(item)).toBe(
            "|Attention Is All You Need",
        );
    });

    test("a new item version is re-rendered", async () => {
        const titles = service("{{ item.title }}");
        const item = await article();
        expect(titles.get(item)).toBe("Attention Is All You Need");

        const edited = { ...item, version: 2, title: "Edited" };
        expect(titles.get(edited)).toBe("Edited");
    });

    test("a new template takes effect only after the delay", async () => {
        const item = await article();
        const titles = service("{{ item.year }}");

        vi.useFakeTimers();
        titles.updateSettings(settingsWith("@{{ item.citationKey }}"));
        vi.advanceTimersByTime(DISPLAY_TITLE_APPLY_DELAY - 1);
        expect(titles.get(item)).toBe("2017");

        vi.advanceTimersByTime(1);
        expect(titles.get(item)).toBe("@vaswani2017");
    });

    test("each edit restarts the delay", async () => {
        const item = await article();
        const titles = service("{{ item.year }}");

        vi.useFakeTimers();
        titles.updateSettings(settingsWith("@"));
        vi.advanceTimersByTime(DISPLAY_TITLE_APPLY_DELAY - 1);
        titles.updateSettings(settingsWith("@{{ item.citationKey }}"));
        vi.advanceTimersByTime(DISPLAY_TITLE_APPLY_DELAY - 1);
        expect(titles.get(item)).toBe("2017");

        vi.advanceTimersByTime(1);
        expect(titles.get(item)).toBe("@vaswani2017");
    });

    test("applying notifies listeners and the main thread once", async () => {
        const host = createFakeParentHost();
        const titles = service("{{ item.year }}", host);
        const listener = vi.fn();
        titles.onChange(listener);

        vi.useFakeTimers();
        titles.updateSettings(settingsWith("a"));
        titles.updateSettings(settingsWith("ab"));
        vi.advanceTimersByTime(DISPLAY_TITLE_APPLY_DELAY);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(host.events.map((e) => e.name)).toEqual(["treeChanged"]);
    });

    test("typing back to the template in effect cancels the change", async () => {
        const host = createFakeParentHost();
        const titles = service("{{ item.year }}", host);

        vi.useFakeTimers();
        titles.updateSettings(settingsWith("{{ item.year }}x"));
        titles.updateSettings(settingsWith("{{ item.year }}"));
        vi.advanceTimersByTime(DISPLAY_TITLE_APPLY_DELAY);

        expect(host.events).toEqual([]);
    });

    test("unchanged settings schedule nothing", () => {
        const host = createFakeParentHost();
        const titles = service(TEMPLATE, host);

        vi.useFakeTimers();
        titles.updateSettings(settingsWith(TEMPLATE));
        vi.advanceTimersByTime(DISPLAY_TITLE_APPLY_DELAY);

        expect(host.events).toEqual([]);
    });

    test("dispose drops a pending change", async () => {
        const host = createFakeParentHost();
        const item = await article();
        const titles = service("{{ item.year }}", host);

        vi.useFakeTimers();
        titles.updateSettings(settingsWith("@{{ item.citationKey }}"));
        titles.dispose();
        vi.advanceTimersByTime(DISPLAY_TITLE_APPLY_DELAY);

        expect(titles.get(item)).toBe("2017");
        expect(host.events).toEqual([]);
    });

    test("getTitles resolves titles by library and key", async () => {
        await article();
        expect(
            await service("@{{ item.citationKey }}").getTitles([
                { libraryID: USER_ID, key: "ARTICLE1" },
                { libraryID: USER_ID, key: "MISSING1" },
            ]),
        ).toEqual({ [`${USER_ID}:ARTICLE1`]: "@vaswani2017" });
    });

    test("search names keep the Zotero title when the display hides it", async () => {
        const item = await article();
        expect(service("@{{ item.citationKey }}").searchNames(item)).toEqual({
            name: "@vaswani2017",
            aliases: ["Attention Is All You Need"],
        });
        expect(service(TEMPLATE).searchNames(item)).toEqual({
            name: "Vaswani (2017) Attention Is All You Need",
        });
    });
});

describe("preview", () => {
    beforeEach(async () => {
        await createServiceHarness();
    });

    const preview = (template: string, key = "ARTICLE1") =>
        service("").preview(USER_ID, key, template);

    test("renders like the tree does", async () => {
        const item = await article();
        expect(await preview(TEMPLATE)).toEqual({
            ok: true,
            output: service(TEMPLATE).get(item),
            hints: [],
        });
    });

    test("an empty template shows the Zotero title", async () => {
        await article();
        const result = await preview("  ");
        expect(result).toMatchObject({ ok: true, output: "Attention Is All You Need" });
        expect(result.hints).toEqual([expect.stringMatching(/template is empty/)]);
    });

    test("a syntax error is positioned, leading whitespace included", async () => {
        await article();
        expect(await preview("\n{{ item.title")).toMatchObject({
            ok: false,
            error: { phase: "parse", line: 2, col: 1 },
        });
    });

    test("a render error is reported instead of the fallback", async () => {
        await article();
        expect(await preview("{{ item.title }} {% render 'missing' %}")).toMatchObject({
            ok: false,
            error: { phase: "render", line: 1 },
        });
    });

    test("a note keeps its own name, and says so", async () => {
        await article("NOTE0001", { itemType: "note", title: "Reading notes" }, { itemType: "note" });
        const result = await preview(TEMPLATE, "NOTE0001");
        expect(result).toMatchObject({ ok: true, output: "Reading notes" });
        expect(result.hints).toEqual([expect.stringMatching(/Notes and annotations/)]);
    });

    test("a syntax error is reported even where the template does not apply", async () => {
        await article("NOTE0001", { itemType: "note", title: "Reading notes" }, { itemType: "note" });
        expect(await preview("{{ item.title", "NOTE0001")).toMatchObject({ ok: false });
    });

    test("an attachment keeps its file name unless the template handles attachments", async () => {
        await article("ATTACH01", { itemType: "attachment", title: "Full Text PDF" }, { itemType: "attachment" });
        const result = await preview(TEMPLATE, "ATTACH01");
        expect(result).toMatchObject({ ok: true, output: "Full Text PDF" });
        expect(result.hints).toEqual([expect.stringMatching(/Attachments keep/)]);

        const handled = await preview(
            '{% if item.itemType == "attachment" %}File{% else %}{{ item.title }}{% endif %}',
            "ATTACH01",
        );
        expect(handled).toEqual({ ok: true, output: "File", hints: [] });
    });

    test("an empty render shows the Zotero title, and says so", async () => {
        await article();
        const result = await preview("{{ item.doesNotExist }}");
        expect(result).toMatchObject({ ok: true, output: "Attention Is All You Need" });
        expect(result.hints).toEqual([expect.stringMatching(/renders empty/)]);
    });

    test("line breaks inside the title are pointed out", async () => {
        await article();
        const result = await preview("{{ item.year }}\n{{ item.title }}");
        expect(result).toMatchObject({ ok: true, output: "2017 Attention Is All You Need" });
        expect(result.hints).toEqual([expect.stringMatching(/Line breaks/)]);
    });

    test("whitespace only around the title is not a line break", async () => {
        await article();
        expect((await preview("\n{{ item.title }}\n")).hints).toEqual([]);
    });

    test("an unknown item is a resource error", async () => {
        await expect(preview(TEMPLATE, "MISSING1")).rejects.toThrow(/Item not found/);
    });
});

describe("variable list", () => {
    beforeEach(async () => {
        await createServiceHarness();
    });

    test("lists the item's variables, with no ZotFlow filters", async () => {
        await article();
        const vars = await service("").describe(USER_ID, "ARTICLE1");
        expect(vars.groups[0]!.variables.find((v) => v.name === "title")).toMatchObject({
            path: "item.title",
            value: "Attention Is All You Need",
        });
        expect(vars.filters).toEqual([]);
    });
});

describe("item search", () => {
    let h: ServiceHarness;

    beforeEach(async () => {
        h = await createServiceHarness({
            settings: { itemDisplayTitleTemplate: "@{{ item.citationKey }}" },
        });
        await article();
    });

    test("matches text that only the display title contains", async () => {
        const hits = await h.search.searchItems("vaswani2017", 10);
        expect(hits.map((i) => i.key)).toEqual(["ARTICLE1"]);
    });

    test("still matches the Zotero title", async () => {
        const hits = await h.search.searchItems("attention", 10);
        expect(hits.map((i) => i.key)).toEqual(["ARTICLE1"]);
    });
});

describe("tree view", () => {
    let h: ServiceHarness;

    function tree() {
        return new TreeViewService(
            h.settings,
            h.host,
            h.library,
            new SearchMatcher(),
            h.displayTitle,
        );
    }

    beforeEach(async () => {
        h = await createServiceHarness({
            settings: { itemDisplayTitleTemplate: TEMPLATE },
        });
        await article();
    });

    test("item entities are named by the display title", async () => {
        const payload = await tree().getOptimizedTree();
        expect(payload.entities.ARTICLE1?.name).toBe(
            "Vaswani (2017) Attention Is All You Need",
        );
    });

    test("attachments, top-level and child, are named by the display title; child notes are not", async () => {
        // A fresh service applies the template at once.
        const names = new DisplayTitleService(
            settingsWith(
                '{% if item.itemType == "attachment" %}File: {{ item.filename }}{% else %}{{ item.title }}{% endif %}',
            ),
            h.host,
        );
        await article(
            "CHILDPDF",
            { itemType: "attachment", title: "Full Text PDF", parentItem: "ARTICLE1" },
            { itemType: "attachment", parentItem: "ARTICLE1", filename: "child.pdf", contentType: "application/pdf" },
        );
        await article(
            "TOPPDF01",
            { itemType: "attachment", title: "Lecture Notes" },
            { itemType: "attachment", filename: "lecture.pdf", contentType: "application/pdf" },
        );
        await article(
            "CHILDNOT",
            { itemType: "note", title: "Reading notes", parentItem: "ARTICLE1" },
            { itemType: "note", parentItem: "ARTICLE1", note: "<p>Reading notes</p>" },
        );
        const view = new TreeViewService(h.settings, h.host, h.library, new SearchMatcher(), names);

        const { entities } = await view.getOptimizedTree();

        expect(entities.CHILDPDF?.name).toBe("File: child.pdf");
        expect(entities.TOPPDF01?.name).toBe("File: lecture.pdf");
        // Its content type is where the tree's icon and file tag come from.
        expect(entities.TOPPDF01?.contentType).toBe("application/pdf");
        expect(entities.TOPPDF01?.citationKey).toBeUndefined();
        expect(entities.CHILDPDF?.contentType).toBe("application/pdf");
        expect(entities.CHILDNOT?.name).toBe("Reading notes");
    });

    test("an edit that keeps the tree's shape patches one entity and its search record", async () => {
        const view = tree();
        await view.getOptimizedTree();
        const { mutateItem } = await import("db/mutate");
        await mutateItem(USER_ID, "ARTICLE1", (d) => {
            (d as { title: string }).title = "Retitled";
            d.tags = [{ tag: "new-tag" }];
        });

        const patch = await view.patchEntities(USER_ID, ["ARTICLE1"]);

        expect(patch?.ARTICLE1).toMatchObject({ name: "Vaswani (2017) Retitled", tags: ["new-tag"], syncStatus: "updated" });
        // The cached tree and the search index follow without a rebuild.
        expect((await view.getOptimizedTree()).entities.ARTICLE1?.name).toBe("Vaswani (2017) Retitled");
        expect((await view.searchTree("retitled")).matchedKeys).toEqual(["ARTICLE1"]);
    });

    test("a patch for an item the tree does not hold asks for a rebuild", async () => {
        const view = tree();
        expect(await view.patchEntities(USER_ID, ["ARTICLE1"])).toBeNull();
        await view.getOptimizedTree();
        expect(await view.patchEntities(USER_ID, ["NOSUCH01"])).toBeNull();
    });

    test("a new template rebuilds the cached tree", async () => {
        const view = tree();
        await view.getOptimizedTree();

        vi.useFakeTimers();
        h.displayTitle.updateSettings(settingsWith("{{ item.year }}"));
        vi.advanceTimersByTime(DISPLAY_TITLE_APPLY_DELAY);
        vi.useRealTimers();

        const payload = await view.getOptimizedTree();
        expect(payload.entities.ARTICLE1?.name).toBe("2017");
    });
});
