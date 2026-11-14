/** Only web protocols are accepted for bibliographic links. */
export function citationUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value.trim());
        return ["https:", "http:"].includes(url.protocol)
            ? url.href
            : undefined;
    } catch {
        return undefined;
    }
}

/** Accept bare DOIs, doi: prefixes and standard DOI resolver URLs. */
export function citationDoi(value: string | undefined): string | undefined {
    if (!value) return undefined;
    let doi = value.trim();
    const resolver = /^https?:\/\/(?:dx\.)?doi\.org\//i;
    if (resolver.test(doi)) {
        try {
            doi = decodeURIComponent(new URL(doi).pathname.slice(1));
        } catch {
            return undefined;
        }
    }
    doi = doi.replace(/^doi:\s*/i, "");
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) return undefined;
    return `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
}
