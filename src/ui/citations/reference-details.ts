import { citationDoi, citationUrl } from "utils/citation-links";
import type { CitationReference } from "types/pandoc-citation";

/** Decorate semantic CSL variables, preserving its wording and title casing. */
export function decorateReferenceDetails(
    container: HTMLElement,
    reference: CitationReference,
    openUrl: (url: string) => void,
): void {
    const doi = citationDoi(reference.doi);
    const url = citationUrl(reference.url);
    const link = (text: string, href: string) => {
        const anchor = container.doc.win.createEl("a", {
            cls: "zotflow-citation-reference-link",
            text,
            href,
            attr: { target: "_blank", rel: "noopener noreferrer" },
        });
        anchor.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openUrl(href);
        });
        return anchor;
    };
    let linked = false;
    for (const [variable, href] of [
        ["DOI", doi],
        ["URL", url],
    ] as const) {
        if (!href) continue;
        for (const marker of Array.from(
            container.querySelectorAll(`[data-csl-variable="${variable}"]`),
        )) {
            marker.replaceWith(link(marker.textContent || href, href));
            linked = true;
        }
    }
    // Some CSL styles omit identifiers. Still make the item's DOI, or its URL
    // when no DOI is available, reachable without duplicating an inline link.
    const fallback = doi ?? url;
    if (!linked && fallback) {
        container
            .createDiv({ cls: "zotflow-citation-links" })
            .appendChild(link(fallback, fallback));
    }
}
