/**
 * Keeps an async suggest list on its newest query.
 *
 * Obsidian's `SuggestModal` and `EditorSuggest` start a lookup on every
 * keystroke and show each async result as it arrives, without checking that
 * its query is still the current one. Typing fast, a slow search for `type`
 * can land after the completions for `type:jo` and replace them.
 *
 * ```ts
 * private readonly latest = new LatestOnly();
 * getSuggestions(query: string) {
 *     return this.latest.run(this.lookup(query));
 * }
 * ```
 *
 * A result overtaken by a newer `run` never settles, so the list never sees
 * it. That holds nothing up: neither list waits for one lookup before starting
 * the next. (Resolving with `[]` instead would show "no results".)
 */
export class LatestOnly {
    private latest = 0;

    async run<T>(work: Promise<T>): Promise<T> {
        const id = ++this.latest;
        const result = await work;
        if (id !== this.latest) return new Promise<T>(() => {});
        return result;
    }
}
