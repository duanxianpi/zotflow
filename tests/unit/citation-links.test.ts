import { expect, test } from "vitest";
import { citationDoi, citationUrl } from "utils/citation-links";

test.each([
    ["10.1234/example", "https://doi.org/10.1234/example"],
    ["doi: 10.1234/example", "https://doi.org/10.1234/example"],
    [
        "http://dx.doi.org/10.1234/example?tracking=1",
        "https://doi.org/10.1234/example",
    ],
    ["https://doi.org/10.1234/a%23b", "https://doi.org/10.1234/a%23b"],
    ["10.1234/a?b#c", "https://doi.org/10.1234/a%3Fb%23c"],
])("normalizes DOI %s", (value, expected) => {
    expect(citationDoi(value)).toBe(expected);
});

test.each([
    undefined,
    "",
    "not a DOI",
    "javascript:alert(1)",
    "10.12/no",
    "10.1234/has a space",
])("ignores invalid DOI %s", (value) => {
    expect(citationDoi(value)).toBeUndefined();
});

test("accepts only HTTP(S) reference URLs", () => {
    expect(citationUrl("https://example.org/a b")).toBe(
        "https://example.org/a%20b",
    );
    expect(citationUrl("http://example.org/")).toBe("http://example.org/");
    for (const value of [
        undefined,
        "",
        "javascript:alert(1)",
        "file:///private",
        "data:text/html,test",
        "https://",
    ])
        expect(citationUrl(value)).toBeUndefined();
});
