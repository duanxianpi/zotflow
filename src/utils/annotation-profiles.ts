/** Plain data shared by settings, the reader bridge and worker templates. */
export interface AnnotationPaletteEntry {
    id: string;
    color: string;
    label: string;
}

export interface AnnotationProfile {
    id: string;
    name: string;
    palette: AnnotationPaletteEntry[];
}

export interface AnnotationProfileSettings {
    annotationProfiles: AnnotationProfile[];
    defaultAnnotationProfileId: string;
    autoTagAnnotations: boolean;
    annotationCategoryTags: string[];
    groupSourceNoteAnnotations: boolean;
    labeledAnnotationCallouts: boolean;
}

export interface AnnotationProfileConfig {
    profiles: AnnotationProfile[];
    activeProfileId: string;
    autoTag: boolean;
}

export const DEFAULT_ANNOTATION_PROFILE_ID = "zotero-default";
const ZOTERO_COLORS = [
    "#ffd400",
    "#ff6666",
    "#5fb236",
    "#2ea8e5",
    "#a28ae5",
    "#e56eee",
    "#f19837",
    "#aaaaaa",
];

export function defaultAnnotationProfile(): AnnotationProfile {
    return {
        id: DEFAULT_ANNOTATION_PROFILE_ID,
        name: "Zotero default",
        palette: ZOTERO_COLORS.map((color) => ({
            id: color.slice(1),
            color,
            label: "",
        })),
    };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
const singleLine = (value: unknown): string =>
    typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim() : "";

/** Validate data.json at the boundary, retaining historical category names. */
export function normalizeAnnotationSettings(
    input: unknown,
): AnnotationProfileSettings {
    const source = isRecord(input) ? input : {};
    const profiles = [defaultAnnotationProfile()];
    const ids = new Set([DEFAULT_ANNOTATION_PROFILE_ID]);
    for (const value of Array.isArray(source.annotationProfiles)
        ? source.annotationProfiles
        : []) {
        if (!isRecord(value)) continue;
        const id = singleLine(value.id);
        const name = singleLine(value.name);
        if (!id || !name || ids.has(id)) continue;
        const palette: AnnotationPaletteEntry[] = [];
        const colors = new Set<string>();
        const entryIds = new Set<string>();
        for (const entry of Array.isArray(value.palette) ? value.palette : []) {
            if (!isRecord(entry)) continue;
            const color = singleLine(entry.color).toLowerCase();
            const entryId = singleLine(entry.id) || color;
            if (
                !/^#[0-9a-f]{6}$/.test(color) ||
                colors.has(color) ||
                entryIds.has(entryId)
            )
                continue;
            colors.add(color);
            entryIds.add(entryId);
            palette.push({
                id: entryId,
                color,
                label: singleLine(entry.label),
            });
        }
        if (!palette.length) continue;
        profiles.push({ id, name, palette });
        ids.add(id);
    }
    const categories = new Set<string>();
    for (const tag of Array.isArray(source.annotationCategoryTags)
        ? source.annotationCategoryTags
        : []) {
        const name = singleLine(tag);
        if (name) categories.add(name);
    }
    for (const profile of profiles) {
        for (const entry of profile.palette) {
            if (entry.label) categories.add(entry.label);
        }
    }
    const defaultId = singleLine(source.defaultAnnotationProfileId);
    return {
        annotationProfiles: profiles,
        defaultAnnotationProfileId: ids.has(defaultId)
            ? defaultId
            : DEFAULT_ANNOTATION_PROFILE_ID,
        annotationCategoryTags: [...categories],
        autoTagAnnotations: source.autoTagAnnotations === true,
        groupSourceNoteAnnotations: source.groupSourceNoteAnnotations === true,
        labeledAnnotationCallouts: source.labeledAnnotationCallouts === true,
    };
}

export function readerProfileConfig(
    settings: AnnotationProfileSettings,
    activeId?: string,
): AnnotationProfileConfig {
    const normalized = normalizeAnnotationSettings(settings);
    return {
        profiles: normalized.annotationProfiles,
        activeProfileId: normalized.annotationProfiles.some(
            (p) => p.id === activeId,
        )
            ? activeId!
            : normalized.defaultAnnotationProfileId,
        autoTag: normalized.autoTagAnnotations,
    };
}

export interface AnnotationMeaning {
    paletteLabel: string | null;
    categoryTags: string[];
    category: string | null;
    resolvedLabel: string | null;
    labelSource: "tag" | "color" | "none";
}

/** Tags determine stable meaning; color only supplies a display fallback. */
export function resolveAnnotationMeaning(
    annotation: { color?: string; tags?: Array<{ name: string }> },
    settings: AnnotationProfileSettings,
): AnnotationMeaning {
    const profile = settings.annotationProfiles.find(
        (p) => p.id === settings.defaultAnnotationProfileId,
    );
    const paletteLabel =
        profile?.palette.find(
            (p) => p.color === annotation.color?.toLowerCase(),
        )?.label || null;
    const names = new Set((annotation.tags ?? []).map((t) => t.name));
    const categoryTags = settings.annotationCategoryTags.filter((tag) =>
        names.has(tag),
    );
    const category = categoryTags[0] ?? null;
    return {
        paletteLabel,
        categoryTags,
        category,
        resolvedLabel: category || paletteLabel,
        labelSource: category ? "tag" : paletteLabel ? "color" : "none",
    };
}

export interface AnnotationGroup<T> {
    label: string;
    annotations: T[];
}

/** Sorting a copy leaves legacy template arrays and annotation storage untouched. */
export function groupAnnotations<
    T extends {
        key: string;
        parentItem?: string;
        resolvedLabel: string | null;
        raw: { sortIndex?: string };
    },
>(annotations: T[], settings: AnnotationProfileSettings): AnnotationGroup<T>[] {
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const ordered = [...annotations].sort(
        (a, b) =>
            compare(a.parentItem ?? "", b.parentItem ?? "") ||
            compare(a.raw.sortIndex ?? "", b.raw.sortIndex ?? "") ||
            compare(a.key, b.key),
    );
    const groups = new Map<string, T[]>();
    for (const annotation of ordered) {
        const label = annotation.resolvedLabel || "Other";
        const group = groups.get(label) ?? [];
        group.push(annotation);
        groups.set(label, group);
    }
    const profile = settings.annotationProfiles.find(
        (p) => p.id === settings.defaultAnnotationProfileId,
    );
    const labels = new Set([
        ...(profile?.palette.map((e) => e.label).filter(Boolean) ?? []),
        ...settings.annotationCategoryTags,
        ...groups.keys(),
    ]);
    labels.delete("Other");
    labels.add("Other");
    return [...labels].flatMap((label) => {
        const group = groups.get(label);
        return group ? [{ label, annotations: group }] : [];
    });
}

/** Labels are plain text, never Markdown syntax or HTML. */
export function escapeAnnotationLabel(value: string | null | undefined): string {
    return (value ?? "")
        .replace(/[\r\n]+/g, " ")
        .replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}
