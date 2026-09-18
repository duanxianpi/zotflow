import { describe, expect, test } from "vitest";

import {
    SearchService,
    type SearchableRecord,
} from "worker/services/search";

const search = new SearchService();

function record(
    id: string,
    overrides: Partial<SearchableRecord> = {},
): SearchableRecord {
    return {
        id,
        name: `Item ${id}`,
        ...overrides,
    };
}

function match(raw: string, records: SearchableRecord[]): SearchableRecord[] {
    return search.matchAndRank(search.parse(raw), records);
}

describe("SearchService diacritic folding", () => {
    test("matches plain and accented free text in both directions", () => {
        const accented = record("accented", { creators: ["Lämmermann"] });
        const plain = record("plain", { creators: ["Lammermann"] });

        expect(match("Lammermann", [accented])).toEqual([accented]);
        expect(match("Lämmermann", [plain])).toEqual([plain]);
    });

    test("normalizes decomposed Unicode before folding", () => {
        const decomposed = record("decomposed", {
            creators: ["La\u0308mmermann"],
        });
        const precomposed = record("precomposed", {
            creators: ["Lämmermann"],
        });

        expect(match("Lammermann", [decomposed])).toEqual([decomposed]);
        expect(match("La\u0308mmermann", [precomposed])).toEqual([
            precomposed,
        ]);
    });

    test.each<[string, Partial<SearchableRecord>]>([
        ["creator:lammermann", { creators: ["Lämmermann"] }],
        ["tag:cafe", { tags: ["Café"] }],
        ["collection:etudes", { collections: ["Études"] }],
        ["library:universite", { libraryName: "Université" }],
    ])("folds structured filter %s", (query, overrides) => {
        const accented = record("accented", overrides);

        expect(match(query, [accented])).toEqual([accented]);
    });

    test("applies folding before evaluating a negated filter", () => {
        const accented = record("accented", { creators: ["Lämmermann"] });
        const other = record("other", { creators: ["Nakamoto"] });

        expect(match("-creator:lammermann", [accented, other])).toEqual([
            other,
        ]);
    });

    test("leaves non-Latin structured filters working", () => {
        const cjk = record("cjk", { tags: ["中文"] });

        expect(match("tag:中文", [cjk])).toEqual([cjk]);
    });
});

describe("SearchService non-Latin free text", () => {
    test("matches a Chinese substring in an item title", () => {
        const cjk = record("cjk", {
            name: "国家电网湖南省电力有限公司",
        });

        expect(match("湖南", [cjk])).toEqual([cjk]);
    });

    test("requires every Chinese term across searchable fields", () => {
        const matching = record("matching", {
            name: "湖南电网工程",
            creators: ["张三"],
            tags: ["施工规范"],
        });
        const missingCreator = record("missing-creator", {
            name: "湖南电网工程",
            creators: ["李四"],
            tags: ["施工规范"],
        });

        expect(match("湖南，张三 规范", [matching, missingCreator])).toEqual([
            matching,
        ]);
    });

    test("combines Chinese filtering with Latin fuzzy matching", () => {
        const matching = record("matching", { name: "电网 Power Systems" });
        const wrongScript = record("wrong-script", {
            name: "Railway Power Systems",
        });
        const wrongLatin = record("wrong-latin", {
            name: "电网 Control Systems",
        });

        expect(
            match("电网 power", [matching, wrongScript, wrongLatin]),
        ).toEqual([matching]);
    });
});
