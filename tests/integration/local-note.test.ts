/**
 * LocalNoteService and LocalTemplateService — the source notes for files the
 * user opened straight from the vault, with no Zotero item behind them.
 *
 * These mirror the library-side services almost statement for statement:
 * the same debounce map, the same orphan aggregation, the same
 * extract-render-splice update. That parallel is the reason to test them
 * separately rather than assume the library suite covers the behaviour — a
 * second copy of an invariant is a second place for it to drift.
 *
 * LocalTemplateService runs for real here; it is small enough that faking it
 * would hide more than it isolates.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { LocalNoteService } from "worker/services/local-note";
import { LocalTemplateService } from "worker/services/local-template";
import { NotePathService } from "worker/services/note-path";
import { DbHelperService } from "worker/services/db-helper";
import { LibraryService } from "worker/services/library";
import { DEFAULT_SETTINGS } from "settings/types";
import { resetDb } from "../fakes/db";
import { createFakeParentHost } from "../fakes/parent-host";

import type { FakeParentHost } from "../fakes/parent-host";
import type { ZotFlowSettings } from "settings/types";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import type { AnnotationJSON } from "types/zotero-reader";
import { previewOutput } from "../fakes/preview";

const DEBOUNCE_DELAY = 2000;

let host: FakeParentHost;
let settings: ZotFlowSettings;
let service: LocalNoteService;
let templates: LocalTemplateService;

/** The attachment the note is about. */
const pdf = (over: Partial<TFileWithoutParentAndVault> = {}) =>
    ({
        basename: "Some Paper",
        name: "Some Paper.pdf",
        path: "Attachments/Some Paper.pdf",
        extension: "pdf",
        ...over,
    });

const annotation = (over: Partial<AnnotationJSON> = {}): AnnotationJSON =>
    ({
        id: "ANNOTAT1",
        type: "highlight",
        text: "quoted <b>text</b>",
        comment: "my <i>note</i>",
        color: "#ffd400",
        pageLabel: "5",
        sortIndex: "00001",
        tags: [],
        ...over,
    }) as AnnotationJSON;

async function setup(over: Partial<ZotFlowSettings> = {}) {
    await resetDb();
    host = createFakeParentHost({ vaultConfig: { strictLineBreaks: false } });
    settings = {
        ...DEFAULT_SETTINGS,
        localSourceNotePathTemplate: "Local/@{{basename}}",
        annotationImageFolder: "ZotFlow/images",
        localSidecarFolder: "",
        ...over,
    };

    const library = new LibraryService(settings, host);
    const dbHelper = new DbHelperService(settings, host, library);
    templates = new LocalTemplateService(settings, host);
    service = new LocalNoteService(
        settings,
        host,
        templates,
        new NotePathService(settings, dbHelper),
    );
}

beforeEach(() => setup());
afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** Register a note file as the one linked to `attachment`. */
function linkNote(
    attachment: TFileWithoutParentAndVault,
    path: string,
    content: string,
    frontmatter: Record<string, unknown> = {},
) {
    host.vault.set(path, content);
    host.frontmatter.set(path, frontmatter);
    host.getLinkedLocalSourceNote = (file: TFileWithoutParentAndVault) =>
        Promise.resolve(
            file.path === attachment.path
                ? ({ path } as TFileWithoutParentAndVault)
                : null,
        );
}

/* ================================================================ */
/*  LocalTemplateService                                            */
/* ================================================================ */

describe("local template rendering", () => {
    test("the built-in template renders against a file with annotations", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [annotation()],
            null,
            {},
        );

        expect(out).toContain("zotflow-locked: true");
        expect(out).toContain("zotflow-local-attachment: [[Attachments/Some Paper.pdf]]");
    });

    test("the attachment link is always rewritten, even if the note had one", async () => {
        // It is the only thing tying the note back to its file.
        const out = await templates.renderLocalNote(pdf(), [], null, {
            "zotflow-local-attachment": "[[stale/path.pdf]]",
        });

        expect(out).toContain(
            "zotflow-local-attachment: [[Attachments/Some Paper.pdf]]",
        );
        expect(out).not.toContain("stale/path.pdf");
    });

    test("the mandatory fields come first", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [],
            "---\ntitle: {{ title }}\n---\nbody",
            { rating: 5, "zotflow-local-attachment": "[[stale/path.pdf]]", "zotflow-locked": true },
        );

        const keys = out
            .split("---")[1]!
            .split("\n")
            .filter((l) => /^[\w-]+:/.test(l))
            .map((l) => l.slice(0, l.indexOf(":")));
        expect(keys).toEqual(["zotflow-locked", "zotflow-local-attachment", "rating", "title"]);
    });

    test("template frontmatter overwrites what the note had", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [],
            "---\nstatus: fresh\n---\nbody",
            { status: "hand-written" },
        );

        expect(out).toContain("status: fresh");
        expect(out).not.toContain("hand-written");
    });

    test("a `??` key is written only when the note does not have it", async () => {
        const fresh = await templates.renderLocalNote(
            pdf(),
            [],
            "---\n??rating: unrated\n---\nbody",
            {},
        );
        expect(fresh).toContain("rating: unrated");

        const existing = await templates.renderLocalNote(
            pdf(),
            [],
            "---\n??rating: unrated\n---\nbody",
            { rating: "5 stars" },
        );
        expect(existing).toContain("rating: 5 stars");
        expect(existing).not.toContain("unrated");
    });

    test("the `??` prefix never reaches a local source note", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [],
            "---\n??rating: unrated\n---\nbody",
            {},
        );

        expect(out).not.toContain("??");
    });

    test("a CRLF template's frontmatter is still detected", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [],
            "---\r\nstatus: fresh\r\n---\r\nbody",
            { status: "hand-written" },
        );

        expect(out).toContain("status: fresh");
        expect(out).not.toContain("hand-written");
        // The template's CRLF delimiters must be consumed by the frontmatter
        // split, not leak into the body (which would mean detection failed).
        expect(out).not.toContain("---\r\n");
    });

    test("keys the template does not mention are carried over", async () => {
        const out = await templates.renderLocalNote(pdf(), [], "body", {
            "my-own-field": "kept",
        });
        expect(out).toContain("my-own-field: kept");
    });

    test("unparseable frontmatter is logged and skipped, not fatal", async () => {
        host.parseYaml = () => Promise.reject(new Error("bad yaml"));

        const out = await templates.renderLocalNote(
            pdf(),
            [],
            "---\nbroken: [\n---\nbody text",
            {},
        );

        expect(out).toContain("body text");
        expect(out).toContain("zotflow-locked: true");
        expect(
            host.logsAt("error").some((l) => /Failed to parse template frontmatter/.test(l.message)),
        ).toBe(true);
    });

    test("a broken template surfaces as a render error", async () => {
        await expect(
            templates.renderLocalNote(pdf(), [], "{% for %}", {}),
        ).rejects.toThrow(/Failed to render note template/);
    });

    test("the file's own fields are exposed", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [],
            "{{ item.basename }}|{{ item.name }}|{{ item.extension }}|{{ item.path }}",
            {},
        );
        expect(out).toContain(
            "Some Paper|Some Paper.pdf|pdf|Attachments/Some Paper.pdf",
        );
    });

    test("annotations are sorted by their position in the document", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [
                annotation({ id: "THIRD001", sortIndex: "00003" }),
                annotation({ id: "FIRST001", sortIndex: "00001" }),
                annotation({ id: "SECOND01", sortIndex: "00002" }),
            ],
            "{% for a in item.annotations %}{{ a.key }},{% endfor %}",
            {},
        );
        expect(out).toContain("FIRST001,SECOND01,THIRD001,");
    });

    test("annotations with no sort index do not crash the sort", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [
                annotation({ id: "NOSORT01", sortIndex: undefined }),
                annotation({ id: "SORTED01", sortIndex: "00001" }),
            ],
            "{{ item.annotations.size }}",
            {},
        );
        expect(out).toContain("2");
    });

    test("annotation markup is converted, and anything outside the subset escaped", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [
                annotation({
                    text: "quoted <b>text</b>",
                    comment: "<script>alert(1)</script> and > a quote",
                }),
            ],
            "{% for a in item.annotations %}[{{ a.text }}][{{ a.comment }}]{% endfor %}",
            {},
        );

        expect(out).toContain("[quoted **text**]");
        expect(out).toContain("\\<script\\>");
        expect(out).not.toContain("<script>");
    });

    test("external annotations are read-only", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [annotation({ isExternal: true })],
            "{% for a in item.annotations %}{{ a.readOnly }}{% endfor %}",
            {},
        );
        expect(out).toContain("true");
    });

    test("wrap_editable withholds markers for a read-only annotation", async () => {
        // Annotations extracted from the PDF itself cannot be written back.
        const out = await templates.renderLocalNote(
            pdf(),
            [annotation({ isExternal: true })],
            '{% for a in item.annotations %}{{ a.comment | wrap_editable: "ANNO", a.key }}{% endfor %}',
            {},
        );

        expect(out).not.toContain("ZF_ANNO_BEG_ANNOTAT1");
        expect(out).toContain("my *note*");
    });

    test("wrap_editable wraps a writable annotation", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [annotation()],
            '{% for a in item.annotations %}{{ a.comment | wrap_editable: "ANNO", a.key }}{% endfor %}',
            {},
        );
        expect(out).toContain("ZF_ANNO_BEG_ANNOTAT1");
    });

    test("process_nav_info encodes an annotation id for the reader", async () => {
        const out = await templates.renderLocalNote(
            pdf(),
            [],
            '{{ "ANNOTAT1" | process_nav_info }}',
            {},
        );
        expect(decodeURIComponent(out)).toContain('{"annotationID":"ANNOTAT1"}');
    });

    test("the image folder loses its trailing slash for templates", async () => {
        await setup({ annotationImageFolder: "ZotFlow/images/" });

        const out = await templates.renderLocalNote(
            pdf(),
            [],
            "{{ settings.annotationImageFolder }}",
            {},
        );
        expect(out).toContain("ZotFlow/images");
        expect(out).not.toContain("ZotFlow/images/\n");
    });
});

describe("sidecar annotations", () => {
    test("preview loads annotations from the co-located sidecar", async () => {
        host.vault.set(
            "Attachments/Some Paper.zf.json",
            JSON.stringify({ annotations: [annotation({ id: "FROMSIDE" })] }),
        );

        const out = await previewOutput(
            templates.previewLocalNote(
                pdf(),
                "{% for a in item.annotations %}{{ a.key }}{% endfor %}",
            ),
        );
        expect(out).toContain("FROMSIDE");
    });

    test("a sidecar folder setting relocates the lookup", async () => {
        await setup({ localSidecarFolder: "Sidecars" });
        host.vault.set(
            "Sidecars/Attachments/Some Paper.zf.json",
            JSON.stringify({ annotations: [annotation({ id: "FROMSIDE" })] }),
        );

        const out = await previewOutput(
            templates.previewLocalNote(
                pdf(),
                "{% for a in item.annotations %}{{ a.key }}{% endfor %}",
            ),
        );
        expect(out).toContain("FROMSIDE");
    });

    test("no sidecar means no annotations, not an error", async () => {
        await expect(
            previewOutput(templates.previewLocalNote(pdf(), "{{ item.annotations.size }}")),
        ).resolves.toContain("0");
    });

    test("a corrupt sidecar degrades to no annotations", async () => {
        // Better an empty note than a render that refuses to run.
        host.vault.set("Attachments/Some Paper.zf.json", "{ not json");

        await expect(
            previewOutput(templates.previewLocalNote(pdf(), "{{ item.annotations.size }}")),
        ).resolves.toContain("0");
    });

    test("a sidecar without an annotations array is tolerated", async () => {
        host.vault.set(
            "Attachments/Some Paper.zf.json",
            JSON.stringify({ somethingElse: true }),
        );

        await expect(
            previewOutput(templates.previewLocalNote(pdf(), "{{ item.annotations.size }}")),
        ).resolves.toContain("0");
    });
});

describe("preview results", () => {
    test("an error in the body is positioned in the whole template", async () => {
        expect(
            await templates.previewLocalNote(pdf(), "---\na: 1\n---\n\n{% if %}"),
        ).toMatchObject({ ok: false, error: { phase: "parse", line: 5 } });
    });

    test("a mandatory key in the template is pointed out", async () => {
        const result = await templates.previewLocalNote(
            pdf(),
            "---\nzotflow-locked: false\n---\nbody",
        );
        expect(result).toMatchObject({ ok: true });
        expect(result.hints).toEqual([
            'ZotFlow writes "zotflow-locked" itself; the template\'s value is not used.',
        ]);
    });

    test("an empty template previews the built-in default", async () => {
        const result = await templates.previewLocalNote(pdf(), "");
        expect(result.ok && result.output).toContain("# Some Paper");
        expect(result.hints[0]).toMatch(/built-in default/);
    });
});

describe("variable list", () => {
    test("lists the file and its sidecar annotations", async () => {
        host.vault.set(
            "Attachments/Some Paper.zf.json",
            JSON.stringify({ annotations: [annotation({ id: "FROMSIDE" })] }),
        );
        const vars = await templates.describeLocalNote(pdf());
        const item = vars.groups[0]!.variables.find((v) => v.name === "item")!;
        const annotations = item.children!.find((v) => v.name === "annotations");
        expect(annotations).toMatchObject({ count: 1 });
    });
});

describe("built-in template", () => {
    test("getBuiltInTemplate is the default local template", async () => {
        expect(templates.getBuiltInTemplate()).toContain("zotflow-local-attachment");
    });
});

/* ================================================================ */
/*  LocalNoteService                                                */
/* ================================================================ */

describe("creating a local note", () => {
    test("an unlinked file gets a note at the template path", async () => {
        host.getLinkedLocalSourceNote = () => Promise.resolve(null);

        await service.openNote(pdf(), [annotation()]);

        expect(host.vault.has("Local/@Some Paper.md")).toBe(true);
        expect(host.opened).toEqual(["Local/@Some Paper.md"]);
    });

    test("an existing file at the path is stepped around", async () => {
        host.getLinkedLocalSourceNote = () => Promise.resolve(null);
        host.vault.set("Local/@Some Paper.md", "someone else's note");

        await service.openNote(pdf(), []);

        expect(host.vault.get("Local/@Some Paper.md")).toBe(
            "someone else's note",
        );
        expect(host.vault.has("Local/@Some Paper (1).md")).toBe(true);
        expect(host.opened).toEqual(["Local/@Some Paper (1).md"]);
    });

    test("collisions keep counting up", async () => {
        host.getLinkedLocalSourceNote = () => Promise.resolve(null);
        host.vault.set("Local/@Some Paper.md", "a");
        host.vault.set("Local/@Some Paper (1).md", "b");

        await service.openNote(pdf(), []);

        expect(host.vault.has("Local/@Some Paper (2).md")).toBe(true);
    });

    test("a hundred collisions is treated as a problem", async () => {
        host.getLinkedLocalSourceNote = () => Promise.resolve(null);
        host.vault.set("Local/@Some Paper.md", "x");
        for (let i = 1; i < 101; i++) {
            host.vault.set(`Local/@Some Paper (${i}).md`, "x");
        }

        await expect(service.openNote(pdf(), [])).rejects.toThrow(
            /unique filename/,
        );
    });

    test("an already-linked note is opened, not recreated", async () => {
        const file = pdf();
        linkNote(file, "Local/Existing.md", "existing body");

        await service.openNote(file, []);

        expect(host.opened).toEqual(["Local/Existing.md"]);
        expect(host.vault.get("Local/Existing.md")).toBe("existing body");
    });
});

describe("updating a local note", () => {
    const BEG = "<!-- ZF_PERSIST_BEG_summary -->";
    const END = "<!-- ZF_PERSIST_END_summary -->";

    test("the note is re-rendered with the new annotations", async () => {
        const file = pdf();
        linkNote(file, "Local/Existing.md", "---\n---\nold body\n");

        await service.triggerUpdate(
            file,
            [annotation({ comment: "brand new" })],
            false,
        );

        const out = host.vault.get("Local/Existing.md")!;
        expect(out).not.toContain("old body");
        expect(out).toContain("brand new");
    });

    test("user content in a persist region survives the re-render", async () => {
        // A template that declares the region, so the render puts an empty one
        // where the user's content has to land.
        await setup({ localSourceNoteTemplatePath: "Templates/local.md" });
        host.vault.set(
            "Templates/local.md",
            `---\n---\nfresh\n${BEG}\n\n${END}\n`,
        );

        const file = pdf();
        linkNote(
            file,
            "Local/Existing.md",
            `---\n---\nold\n${BEG}\nmy own notes\n${END}\n`,
        );

        await service.triggerUpdate(file, [], false);

        const out = host.vault.get("Local/Existing.md")!;
        expect(out).toContain("fresh");
        expect(out).toContain(`${BEG}\nmy own notes\n${END}`);
    });

    test("a dropped region is preserved and reported", async () => {
        const file = pdf();
        linkNote(
            file,
            "Local/Existing.md",
            `---\n---\n${BEG}\nsalvage me\n${END}\n`,
        );

        await service.triggerUpdate(file, [], false);

        expect(host.vault.get("Local/Existing.md")).toContain("salvage me");
        expect(
            host.logsAt("warn").some((l) => /orphaned in Local\/Existing\.md/.test(l.message)),
        ).toBe(true);
    });

    test("orphan notices are batched into one summary", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const a = pdf({ path: "Attachments/A.pdf", basename: "A" });
        const b = pdf({ path: "Attachments/B.pdf", basename: "B" });
        host.vault.set("Local/A.md", `---\n---\n${BEG}\nkeep\n${END}\n`);
        host.vault.set("Local/B.md", `---\n---\n${BEG}\nkeep\n${END}\n`);
        host.getLinkedLocalSourceNote = (f: TFileWithoutParentAndVault) =>
            Promise.resolve({
                path: f.basename === "A" ? "Local/A.md" : "Local/B.md",
            } as TFileWithoutParentAndVault);

        await service.triggerUpdate(a, [], false);
        await service.triggerUpdate(b, [], false);

        expect(host.notices).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY);

        expect(host.notices).toEqual([
            {
                type: "warning",
                message:
                    "2 note(s) have orphaned persist regions — content was preserved at the bottom of each note (see log)",
            },
        ]);
    });

    test("markers that do not parse refuse the update", async () => {
        const file = pdf();
        linkNote(file, "Local/Existing.md", `---\n---\n${BEG}\nunclosed\n`);

        await expect(
            service.triggerUpdate(file, [], false),
        ).rejects.toThrow(/Invalid persist markers/);
        expect(host.vault.get("Local/Existing.md")).toContain("unclosed");
    });

    test("a file that cannot be read is never overwritten blindly", async () => {
        const file = pdf();
        linkNote(file, "Local/Existing.md", "precious content");
        host.readTextFile = () => Promise.resolve(null);

        await expect(
            service.triggerUpdate(file, [], false),
        ).rejects.toThrow(/refused to overwrite blindly/);
    });

    test("the existing frontmatter is carried into the render", async () => {
        const file = pdf();
        linkNote(file, "Local/Existing.md", "---\n---\nbody", {
            rating: "5 stars",
        });

        await service.triggerUpdate(file, [], false);

        expect(host.vault.get("Local/Existing.md")).toContain(
            "rating: 5 stars",
        );
    });
});

describe("local note debouncing", () => {
    test("immediate mode surfaces failures", async () => {
        const file = pdf();
        linkNote(file, "Local/Existing.md", "body");
        host.writeTextFile = () => Promise.reject(new Error("disk full"));

        await expect(
            service.triggerUpdate(file, [], false),
        ).rejects.toThrow(/Immediate update failed/);
    });

    test("debounced mode logs instead of throwing", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const file = pdf();
        linkNote(file, "Local/Existing.md", "body");
        host.writeTextFile = () => Promise.reject(new Error("disk full"));

        const logged = new Promise<void>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/unbound-method -- the fake's methods are closures
            const original = host.log;
            host.log = (level, message, context, details) => {
                original(level, message, context, details);
                if (/Debounced update failed/.test(message)) resolve();
            };
        });

        await service.triggerUpdate(file, [], true);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_DELAY);
        await logged;
    });

    test("repeated requests for one file collapse into one timer", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const file = pdf();
        linkNote(file, "Local/Existing.md", "body");

        await service.triggerUpdate(file, [], true);
        await service.triggerUpdate(file, [], true);
        await service.triggerUpdate(file, [], true);

        expect(vi.getTimerCount()).toBe(1);
    });

    test("different files debounce independently", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        host.getLinkedLocalSourceNote = () => Promise.resolve(null);

        await service.triggerUpdate(pdf({ path: "a.pdf" }), [], true);
        await service.triggerUpdate(pdf({ path: "b.pdf" }), [], true);

        expect(vi.getTimerCount()).toBe(2);
    });

    test("dispose cancels work that has not fired", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const file = pdf();
        linkNote(file, "Local/Existing.md", "body");

        await service.triggerUpdate(file, [], true);
        service.dispose();

        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("legacy annotation migration", () => {
    test("an OZRP block is recovered with its quote and comment", async () => {
        const file = pdf();
        const payload = JSON.stringify({ id: "OLDANNO1", type: "highlight" });
        linkNote(
            file,
            "Local/Existing.md",
            [
                `%% OZRP-ANNO-BEGIN ${payload} %%`,
                "%% OZRP-ANNO-QUOTE-BEGIN %%",
                "> > quoted line one",
                "> > quoted line two",
                "%% OZRP-ANNO-QUOTE-END %%",
                "%% OZRP-ANNO-COMM-BEGIN %%",
                "> my comment",
                "%% OZRP-ANNO-COMM-END %%",
                "%% OZRP-ANNO-END %%",
            ].join("\n"),
        );

        const found = await service.parseLegacyAnnotations(file);

        expect(found).toHaveLength(1);
        expect(found[0]!.id).toBe("OLDANNO1");
        expect(found[0]!.text).toBe("quoted line one\nquoted line two");
        expect(found[0]!.comment).toBe("my comment");
    });

    test("a ZotFlow block is URL-decoded and parsed", async () => {
        const file = pdf();
        const payload = encodeURIComponent(
            JSON.stringify({ id: "ZFANNO01", type: "underline" }),
        );
        linkNote(
            file,
            "Local/Existing.md",
            [
                `%% ZOTFLOW_ANNO_ZFANNO01_BEG ${payload} %%`,
                "body",
                "%% ZOTFLOW_ANNO_ZFANNO01_END %%",
            ].join("\n"),
        );

        const found = await service.parseLegacyAnnotations(file);

        expect(found).toHaveLength(1);
        expect(found[0]!.id).toBe("ZFANNO01");
        expect(found[0]!.type).toBe("underline");
    });

    test("both formats can appear in one note", async () => {
        const file = pdf();
        const ozrp = JSON.stringify({ id: "OLDANNO1" });
        const zf = encodeURIComponent(JSON.stringify({ id: "ZFANNO01" }));
        linkNote(
            file,
            "Local/Existing.md",
            [
                `%% OZRP-ANNO-BEGIN ${ozrp} %%`,
                "%% OZRP-ANNO-END %%",
                `%% ZOTFLOW_ANNO_ZFANNO01_BEG ${zf} %%`,
                "%% ZOTFLOW_ANNO_ZFANNO01_END %%",
            ].join("\n"),
        );

        expect((await service.parseLegacyAnnotations(file)).map((a) => a.id)).toEqual(
            ["OLDANNO1", "ZFANNO01"],
        );
    });

    test("a malformed block is skipped, the rest still recovered", async () => {
        // Migration must salvage what it can rather than abandon the note.
        const file = pdf();
        const good = JSON.stringify({ id: "GOODANNO" });
        linkNote(
            file,
            "Local/Existing.md",
            [
                "%% OZRP-ANNO-BEGIN {not json} %%",
                "%% OZRP-ANNO-END %%",
                `%% OZRP-ANNO-BEGIN ${good} %%`,
                "%% OZRP-ANNO-END %%",
            ].join("\n"),
        );

        expect((await service.parseLegacyAnnotations(file)).map((a) => a.id)).toEqual(
            ["GOODANNO"],
        );
        expect(
            host.logsAt("warn").some((l) => /Failed to parse OZRP/.test(l.message)),
        ).toBe(true);
    });

    test("running twice returns the same annotations", async () => {
        // The module-level regexes are stateful; a stale lastIndex would make
        // the second pass silently skip blocks.
        const file = pdf();
        const payload = JSON.stringify({ id: "OLDANNO1" });
        linkNote(
            file,
            "Local/Existing.md",
            `%% OZRP-ANNO-BEGIN ${payload} %%\n%% OZRP-ANNO-END %%`,
        );

        const first = await service.parseLegacyAnnotations(file);
        const second = await service.parseLegacyAnnotations(file);

        expect(second).toEqual(first);
        expect(second).toHaveLength(1);
    });

    test("no linked note means nothing to migrate", async () => {
        host.getLinkedLocalSourceNote = () => Promise.resolve(null);
        expect(await service.parseLegacyAnnotations(pdf())).toEqual([]);
    });

    test("an unreadable note yields nothing rather than throwing", async () => {
        const file = pdf();
        linkNote(file, "Local/Existing.md", "body");
        host.readTextFile = () => Promise.reject(new Error("ENOENT"));

        expect(await service.parseLegacyAnnotations(file)).toEqual([]);
        expect(
            host.logsAt("error").some((l) => /Error parsing legacy annotations/.test(l.message)),
        ).toBe(true);
    });

    test("a note with no legacy blocks yields nothing", async () => {
        const file = pdf();
        linkNote(file, "Local/Existing.md", "just an ordinary note");
        expect(await service.parseLegacyAnnotations(file)).toEqual([]);
    });
});

describe("local annotation images", () => {
    test("a base64 payload is written as png", async () => {
        await service.saveBase64Image("data:image/png;base64,aGk=", "ANNOTAT1");

        const written = host.binaryVault.get("ZotFlow/images/ANNOTAT1.png")!;
        expect(new TextDecoder().decode(written)).toBe("hi");
    });

    test("a malformed payload is reported", async () => {
        await expect(
            service.saveBase64Image("not-a-data-url", "ANNOTAT1"),
        ).rejects.toThrow();
    });

    test("deleting removes an existing image", async () => {
        host.vault.set("ZotFlow/images/ANNOTAT1.png", "bytes");

        await service.deleteAnnotationImage("ANNOTAT1");

        expect(host.vault.has("ZotFlow/images/ANNOTAT1.png")).toBe(false);
    });

    test("deleting one that is not there is a no-op", async () => {
        await expect(
            service.deleteAnnotationImage("NOSUCHAN"),
        ).resolves.toBeUndefined();
    });
});
