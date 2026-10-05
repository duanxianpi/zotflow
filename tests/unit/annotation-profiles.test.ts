import { describe, expect, it } from "vitest";
import {
    defaultAnnotationProfile,
    normalizeAnnotationSettings,
    readerProfileConfig,
    resolveAnnotationMeaning,
    groupAnnotations,
    escapeAnnotationLabel,
} from "utils/annotation-profiles";

const profile = {
    id: "research",
    name: "Research",
    palette: [
        { id: "yellow", color: "#ffd400", label: "Methodology" },
        { id: "blue", color: "#2ea8e5", label: "Evidence" },
    ],
};
const settings = () =>
    normalizeAnnotationSettings({
        annotationProfiles: [profile],
        defaultAnnotationProfileId: profile.id,
        annotationCategoryTags: ["Limitations"],
    });

describe("annotation profiles", () => {
    it("defaults to the original palette and disabled behavior, with independent arrays", () => {
        const a = normalizeAnnotationSettings(null);
        const b = normalizeAnnotationSettings({});
        expect(a.annotationProfiles).toEqual([defaultAnnotationProfile()]);
        expect(a.annotationProfiles[0]!.palette.map((e) => e.color)).toEqual([
            "#ffd400",
            "#ff6666",
            "#5fb236",
            "#2ea8e5",
            "#a28ae5",
            "#e56eee",
            "#f19837",
            "#aaaaaa",
        ]);
        expect(
            a.autoTagAnnotations ||
                a.groupSourceNoteAnnotations ||
                a.labeledAnnotationCallouts,
        ).toBe(false);
        a.annotationProfiles[0]!.palette[0]!.label = "Changed";
        expect(b.annotationProfiles[0]!.palette[0]!.label).toBe("");
    });

    it("repairs malformed profiles, duplicate colors/IDs and missing defaults", () => {
        const value = normalizeAnnotationSettings({
            defaultAnnotationProfileId: "gone",
            annotationProfiles: [
                null,
                { id: "empty", name: "Empty", palette: [] },
                {
                    ...profile,
                    palette: [
                        { id: "a", color: "#FFD400", label: " Methodology\n " },
                        { id: "b", color: "#ffd400", label: "Duplicate" },
                        { id: "c", color: "bad", label: "Bad" },
                    ],
                },
                profile,
            ],
        });
        expect(value.annotationProfiles).toHaveLength(2);
        expect(value.annotationProfiles[1]!.palette).toEqual([
            { id: "a", color: "#ffd400", label: "Methodology" },
        ]);
        expect(value.defaultAnnotationProfileId).toBe("zotero-default");
        expect(value.annotationCategoryTags).toEqual(["Methodology"]);
    });

    it("retains category history across renaming, removal and profile deletion", () => {
        const before = settings();
        const changed = normalizeAnnotationSettings({
            ...before,
            annotationProfiles: [
                {
                    ...profile,
                    palette: [{ id: "new", color: "#ffd400", label: "Theory" }],
                },
            ],
        });
        const removed = normalizeAnnotationSettings({
            ...changed,
            annotationProfiles: [],
        });
        expect(removed.annotationCategoryTags).toEqual([
            "Limitations",
            "Methodology",
            "Evidence",
            "Theory",
        ]);
        expect(
            resolveAnnotationMeaning(
                { color: "#ffd400", tags: [{ name: "Methodology" }] },
                removed,
            ),
        ).toMatchObject({
            category: "Methodology",
            resolvedLabel: "Methodology",
            labelSource: "tag",
        });
    });

    it("distinguishes persisted meaning from color and ignores unrelated tags", () => {
        const s = settings();
        expect(
            resolveAnnotationMeaning(
                { color: "#FFD400", tags: [{ name: "todo" }] },
                s,
            ),
        ).toMatchObject({
            paletteLabel: "Methodology",
            category: null,
            labelSource: "color",
        });
        expect(
            resolveAnnotationMeaning({ color: "#123456", tags: [] }, s),
        ).toMatchObject({ resolvedLabel: null, labelSource: "none" });
        const input = {
            color: "#ffd400",
            tags: [
                { name: "Evidence" },
                { name: "Limitations" },
                { name: "todo" },
            ],
        };
        const copy = structuredClone(input);
        expect(resolveAnnotationMeaning(input, s)).toMatchObject({
            categoryTags: ["Limitations", "Evidence"],
            category: "Limitations",
            paletteLabel: "Methodology",
        });
        expect(input).toEqual(copy);
    });

    it("category priority survives palette order and reader profile changes", () => {
        const s = settings();
        const config = readerProfileConfig(s, "zotero-default");
        expect(config.activeProfileId).toBe("zotero-default");
        expect(s.defaultAnnotationProfileId).toBe("research");
        const next = normalizeAnnotationSettings({
            ...s,
            annotationProfiles: [
                { ...profile, palette: [...profile.palette].reverse() },
            ],
        });
        const input = {
            color: "#ffd400",
            tags: [{ name: "Evidence" }, { name: "Methodology" }],
        };
        expect(resolveAnnotationMeaning(input, next).category).toBe(
            "Methodology",
        );
        expect(readerProfileConfig(s, "deleted").activeProfileId).toBe(
            "research",
        );
    });

    it("groups deterministically without reordering caller arrays; Other is last", () => {
        const entries = [
            {
                key: "2",
                parentItem: "B",
                resolvedLabel: "Methodology",
                raw: { sortIndex: "001" },
            },
            { key: "3", parentItem: "A", resolvedLabel: null, raw: {} },
            {
                key: "4",
                parentItem: "A",
                resolvedLabel: "Limitations",
                raw: {},
            },
            {
                key: "1",
                parentItem: "A",
                resolvedLabel: "Methodology",
                raw: { sortIndex: "002" },
            },
        ];
        const copy = structuredClone(entries);
        const groups = groupAnnotations(entries, settings());
        expect(groups.map((g) => g.label)).toEqual([
            "Methodology",
            "Limitations",
            "Other",
        ]);
        expect(groups[0]!.annotations.map((a) => a.key)).toEqual(["1", "2"]);
        expect(entries).toEqual(copy);
        expect(escapeAnnotationLabel("[x] <b>\n# title")).toBe(
            "\\[x\\] \\<b\\> \\# title",
        );
    });
});
