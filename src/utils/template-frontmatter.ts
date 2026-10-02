/**
 * Merge rendered template frontmatter into an existing source note.
 *
 * A template key prefixed with `??` supplies a default: the prefix is removed
 * and the value is written only when the existing note does not already have
 * that key. Bare keys keep the historical overwrite-on-render behaviour.
 */
export function mergeTemplateFrontmatter(
    original: Record<string, unknown>,
    renderedTemplate: Record<string, unknown>,
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...original };

    for (const [rawKey, value] of Object.entries(renderedTemplate)) {
        const preserveExisting = rawKey.startsWith("??");
        const key = preserveExisting ? rawKey.slice(2) : rawKey;
        if (!key) continue;

        if (!preserveExisting || !(key in merged)) {
            merged[key] = value;
        }
    }

    return merged;
}

/**
 * Frontmatter with the plugin's mandatory fields first, in the given order,
 * then everything else in its existing order. A mandatory key found among
 * the rest (an older note had it further down) is moved, not duplicated.
 */
export function withMandatoryFirst(
    mandatory: Record<string, unknown>,
    rest: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...mandatory };
    for (const [key, value] of Object.entries(rest)) {
        if (!(key in mandatory)) out[key] = value;
    }
    return out;
}
