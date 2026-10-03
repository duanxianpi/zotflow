/**
 * Tests for src/db/sync/reconcile.ts.
 *
 * The cases under "Zotero:" are ported from Zotero's own suites
 * (test/tests/dataObjectUtilitiesTest.js and the `_reconcileChanges` /
 * `_reconcileChangesWithoutCache` cases of test/tests/syncLocalTest.js),
 * Copyright © Center for History and New Media, George Mason University,
 * AGPL-3.0. Cases for searches, collections, `lastRead` and ISBN hyphenation
 * are left out with the behaviour they test.
 */
import { describe, test, expect } from "vitest";

import {
    applyChanges,
    diff,
    noteText,
    patch,
    reconcile2,
    reconcile3,
    sameContent,
} from "db/sync/reconcile";

import type { Change } from "db/sync/reconcile";

const ignoreFields = ["dateAdded", "dateModified"];

/** Same members in any order (chai's `sameDeepMembers`). */
function expectSameMembers(actual: unknown[], expected: unknown[]) {
    expect(actual).toHaveLength(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
}

describe("Zotero: patch()", () => {
    test("should omit 'collections' if it doesn't exist", () => {
        expect(patch({ collections: ["AAAAAAAA"] }, {})).not.toHaveProperty("collections");
    });

    test("should blank out deleted properties", () => {
        const obj = patch({ title: "Test", place: "" }, {});
        expect(obj).toHaveProperty("title", "");
        expect(obj).not.toHaveProperty("place");
    });

    test("shouldn't include tags in different order that haven't changed", () => {
        const obj = patch(
            { title: "Old Title", tags: [{ tag: "A" }, { tag: "B" }] },
            { title: "New Title", tags: [{ tag: "B" }, { tag: "A" }] },
        );
        expect(obj).not.toHaveProperty("tags");
    });

    test("shouldn't include relations that haven't changed", () => {
        const rel = { "mendeleyDB:documentUUID": "6b97abe6-8e23-4471-b963-234cf26808b9" };
        expect(patch({ title: "Old Title", relations: rel }, { title: "New Title", relations: { ...rel } })).not.toHaveProperty(
            "relations",
        );
    });

    test("shouldn't include relations that only switched from string to array", () => {
        const id = "6b97abe6-8e23-4471-b963-234cf26808b9";
        const obj = patch(
            { title: "Old Title", relations: { "mendeleyDB:documentUUID": id } },
            { title: "New Title", relations: { "mendeleyDB:documentUUID": [id] } },
        );
        expect(obj).not.toHaveProperty("relations");
    });
});

describe("patch(): ZotFlow uses", () => {
    test("an unchanged object patches to its identity and timestamp", () => {
        const base = { key: "K", version: 3, title: "T", tags: [{ tag: "a" }], dateModified: "x" };
        expect(patch(base, { ...base, dateModified: "y" })).toEqual({ key: "K", version: 3, dateModified: "y" });
    });

    test("trashing sends deleted, restoring clears it", () => {
        expect(patch({ note: "n" }, { note: "n", deleted: true })).toEqual({ deleted: true });
        expect(patch({ note: "n", deleted: true }, { note: "n" })).toEqual({ deleted: false });
    });
});

describe("Zotero: diff()", () => {
    test("should not show empty strings as different", () => {
        expect(diff({ title: "" }, { title: "" })).toHaveLength(0);
    });

    test("should not show empty string and undefined as different", () => {
        expect(diff({ title: "" }, { place: "" })).toHaveLength(0);
    });

    test("should not show identical creators as different", () => {
        expect(
            diff(
                { creators: [{ name: "Center for History and New Media", creatorType: "author" }] },
                { creators: [{ creatorType: "author", name: "Center for History and New Media" }] },
            ),
        ).toHaveLength(0);
    });

    test("should not show an empty creators array and a missing one as different", () => {
        expect(diff({ creators: [] }, {})).toHaveLength(0);
        expect(diff({}, { creators: [] })).toHaveLength(0);
    });

    test("notes: should ignore sanitization changes", () => {
        expect(diff({ note: "<p> </p>" }, { note: "<p>&nbsp;</p>" })).toHaveLength(0);
    });

    test("should not show an empty relations object and a missing one as different", () => {
        expect(diff({ relations: {} }, {})).toHaveLength(0);
        expect(diff({}, { relations: {} })).toHaveLength(0);
    });

    test("should not show manual tags with or without 'type' property as different", () => {
        expect(diff({ tags: [{ tag: "Foo" }] }, { tags: [{ tag: "Foo", type: 0 }] })).toHaveLength(0);
    });

    test("should show tags of different types as different", () => {
        expectSameMembers(diff({ tags: [{ tag: "Foo" }] }, { tags: [{ tag: "Foo", type: 1 }] }), [
            { field: "tags", op: "member-remove", value: { tag: "Foo" } },
            { field: "tags", op: "member-add", value: { tag: "Foo", type: 1 } },
        ]);
    });
});

describe("Zotero: applyChanges()", () => {
    test("should set added/modified field values", () => {
        const json = applyChanges({ title: "A" }, [
            { field: "title", op: "add", value: "B" },
            { field: "date", op: "modify", value: "2015-05-19" },
        ]);
        expect(json.title).toBe("B");
        expect(json.date).toBe("2015-05-19");
    });

    test("should add a collection", () => {
        const json = applyChanges({ collections: ["AAAAAAAA"] }, [
            { field: "collections", op: "member-add", value: "BBBBBBBB" },
        ]);
        expectSameMembers(json.collections as string[], ["AAAAAAAA", "BBBBBBBB"]);
    });

    test("should not duplicate an existing collection", () => {
        const json = applyChanges({ collections: ["AAAAAAAA"] }, [
            { field: "collections", op: "member-add", value: "AAAAAAAA" },
        ]);
        expect(json.collections).toEqual(["AAAAAAAA"]);
    });

    test("should remove a collection", () => {
        const json = applyChanges({ collections: ["AAAAAAAA"] }, [
            { field: "collections", op: "member-remove", value: "AAAAAAAA" },
        ]);
        expect(json.collections).toHaveLength(0);
    });

    const addA: Change = { field: "relations", op: "property-member-add", value: { key: "a", value: "A" } };
    const removeA = (value: string): Change => ({
        field: "relations",
        op: "property-member-remove",
        value: { key: "a", value },
    });

    test("should add a predicate and object to an empty relations object", () => {
        expect(applyChanges({ relations: {} }, [addA]).relations).toEqual({ a: ["A"] });
    });

    test("should add a predicate and object to a missing relations object", () => {
        expect(applyChanges({}, [addA]).relations).toEqual({ a: ["A"] });
    });

    test("should add an object to an existing predicate string", () => {
        const json = applyChanges({ relations: { a: "A1" } }, [
            { field: "relations", op: "property-member-add", value: { key: "a", value: "A2" } },
        ]);
        expect(json.relations).toEqual({ a: ["A1", "A2"] });
    });

    test("should add an object to an existing predicate array", () => {
        const json = applyChanges({ relations: { a: ["A1"] } }, [
            { field: "relations", op: "property-member-add", value: { key: "a", value: "A2" } },
        ]);
        expect(json.relations).toEqual({ a: ["A1", "A2"] });
    });

    test("should ignore a removal for an missing relations object", () => {
        expect(applyChanges({}, [removeA("A")])).not.toHaveProperty("relations");
    });

    test("should ignore a removal for a missing relations predicate", () => {
        expect(applyChanges({ relations: {} }, [removeA("A")]).relations).toEqual({});
    });

    test("should ignore a removal for a missing object", () => {
        expect(applyChanges({ relations: { a: ["A1"] } }, [removeA("A2")]).relations).toEqual({ a: ["A1"] });
    });

    test("should remove a predicate and object string from a relations object", () => {
        expect(applyChanges({ relations: { a: "A" } }, [removeA("A")]).relations).toEqual({});
    });

    test("should remove a predicate and object array from a relations object", () => {
        expect(applyChanges({ relations: { a: ["A"] } }, [removeA("A")]).relations).toEqual({});
    });

    test("should remove an object from an existing predicate array", () => {
        expect(applyChanges({ relations: { a: ["A1", "A2"] } }, [removeA("A2")]).relations).toEqual({ a: ["A1"] });
    });

    test("should add a tag", () => {
        const json = applyChanges({ tags: [{ tag: "A" }] }, [{ field: "tags", op: "member-add", value: { tag: "B" } }]);
        expectSameMembers(json.tags as unknown[], [{ tag: "A" }, { tag: "B" }]);
    });

    test("should not duplicate an existing tag", () => {
        const json = applyChanges({ tags: [{ tag: "A" }] }, [{ field: "tags", op: "member-add", value: { tag: "A" } }]);
        expect(json.tags).toEqual([{ tag: "A" }]);
    });

    test("should remove a tag", () => {
        const json = applyChanges({ tags: [{ tag: "A" }] }, [{ field: "tags", op: "member-remove", value: { tag: "A" } }]);
        expect(json.tags).toHaveLength(0);
    });

    test("leaves its input alone", () => {
        const json = { tags: [{ tag: "A" }], title: "t" };
        applyChanges(json, [
            { field: "tags", op: "member-remove", value: { tag: "A" } },
            { field: "title", op: "delete" },
        ]);
        expect(json).toEqual({ tags: [{ tag: "A" }], title: "t" });
    });
});

describe("Zotero: reconcile3() (_reconcileChanges, items)", () => {
    test("should ignore non-conflicting local changes and return remote changes", () => {
        const cacheJSON = {
            key: "AAAAAAAA",
            version: 1234,
            itemType: "book",
            title: "Title 1",
            creators: [{ firstName: "First1", lastName: "Last1", creatorType: "author" }],
            url: "http://zotero.org/",
            publicationTitle: "Publisher",
            extra: "Extra",
            dateModified: "2015-05-14 12:34:56",
            collections: ["AAAAAAAA", "DDDDDDDD", "EEEEEEEE"],
            relations: { a: "A", c: ["C1", "C2"], d: "D", e: ["E"], f: "F1", g: ["G1", "G2", "G3"], h: "H", i: ["I"] },
            tags: [{ tag: "A" }, { tag: "D" }, { tag: "E" }],
        };
        const json1 = {
            key: "AAAAAAAA",
            version: 1234,
            itemType: "book",
            title: "Title 2",
            creators: [
                { firstName: "First1", lastName: "Last1", creatorType: "author" },
                { firstName: "First2", lastName: "Last2", creatorType: "editor" },
            ],
            url: "https://www.zotero.org/",
            place: "Place",
            dateModified: "2015-05-14 14:12:34",
            collections: ["BBBBBBBB", "DDDDDDDD", "FFFFFFFF"],
            relations: { a: "A", b: "B", f: "F2", g: ["G1", "G2", "G6"], h: "H", i: ["I"] },
            tags: [{ tag: "B" }, { tag: "D" }, { tag: "F", type: 1 }, { tag: "G" }, { tag: "H", type: 1 }],
        };
        const json2 = {
            key: "AAAAAAAA",
            version: 1235,
            itemType: "book",
            title: "Title 1",
            creators: [
                { firstName: "First1", lastName: "Last1", creatorType: "author" },
                { firstName: "First2", lastName: "Last2", creatorType: "editor" },
            ],
            url: "https://www.zotero.org/",
            publicationTitle: "Publisher",
            date: "2015-05-15",
            dateModified: "2015-05-14 13:45:12",
            collections: ["AAAAAAAA", "CCCCCCCC", "FFFFFFFF"],
            relations: { a: "A", d: "D", e: ["E"], f: "F1", g: ["G1", "G4", "G6"] },
            tags: [{ tag: "A" }, { tag: "C" }, { tag: "F", type: 1 }, { tag: "G", type: 1 }, { tag: "H" }],
        };
        const result = reconcile3(cacheJSON, json1, json2, ignoreFields);
        expectSameMembers(result.changes, [
            { field: "date", op: "add", value: "2015-05-15" },
            { field: "collections", op: "member-add", value: "CCCCCCCC" },
            { field: "collections", op: "member-remove", value: "DDDDDDDD" },
            { field: "relations", op: "property-member-remove", value: { key: "g", value: "G2" } },
            { field: "relations", op: "property-member-add", value: { key: "g", value: "G4" } },
            { field: "relations", op: "property-member-remove", value: { key: "h", value: "H" } },
            { field: "relations", op: "property-member-remove", value: { key: "i", value: "I" } },
            { field: "tags", op: "member-add", value: { tag: "C" } },
            { field: "tags", op: "member-remove", value: { tag: "D" } },
            { field: "tags", op: "member-remove", value: { tag: "H", type: 1 } },
            { field: "tags", op: "member-add", value: { tag: "H" } },
        ]);
        expect(result.conflicts).toHaveLength(0);
    });

    test("should return empty arrays when no remote changes to apply", () => {
        const cacheJSON = {
            key: "AAAAAAAA",
            version: 1234,
            itemType: "book",
            title: "Title 1",
            url: "http://zotero.org/",
            publicationTitle: "Publisher",
            extra: "Extra",
            dateModified: "2015-05-14 12:34:56",
            collections: ["AAAAAAAA", "DDDDDDDD", "EEEEEEEE"],
            tags: [{ tag: "A" }, { tag: "D" }, { tag: "E" }],
        };
        const json1 = {
            key: "AAAAAAAA",
            version: 1234,
            itemType: "book",
            title: "Title 2",
            url: "https://www.zotero.org/",
            place: "Place",
            dateModified: "2015-05-14 14:12:34",
            collections: ["BBBBBBBB", "DDDDDDDD", "FFFFFFFF"],
            tags: [{ tag: "B" }, { tag: "D" }, { tag: "F", type: 1 }, { tag: "G" }],
        };
        const json2 = {
            key: "AAAAAAAA",
            version: 1235,
            itemType: "book",
            title: "Title 1",
            url: "https://www.zotero.org/",
            publicationTitle: "Publisher",
            dateModified: "2015-05-14 13:45:12",
            collections: ["AAAAAAAA", "DDDDDDDD", "FFFFFFFF"],
            tags: [{ tag: "A" }, { tag: "D" }, { tag: "F", type: 1 }, { tag: "G", type: 1 }],
        };
        const result = reconcile3(cacheJSON, json1, json2, ignoreFields);
        expect(result.changes).toHaveLength(0);
        expect(result.conflicts).toHaveLength(0);
    });

    test("should return conflict when changes can't be automatically resolved", () => {
        const result = reconcile3(
            { key: "AAAAAAAA", version: 1234, title: "Title 1", dateModified: "2015-05-14 12:34:56" },
            { key: "AAAAAAAA", version: 1234, title: "Title 2", dateModified: "2015-05-14 14:12:34" },
            { key: "AAAAAAAA", version: 1235, title: "Title 3", dateModified: "2015-05-14 13:45:12" },
            ignoreFields,
        );
        expect(result.changes).toHaveLength(0);
        expect(result.conflicts).toEqual([
            [
                { field: "title", op: "modify", value: "Title 2" },
                { field: "title", op: "modify", value: "Title 3" },
            ],
        ]);
    });

    test("should return conflict when creator changes can't be automatically resolved", () => {
        const creators = (n: number) => [{ firstName: `First${n}`, lastName: `Last${n}`, creatorType: "author" }];
        const result = reconcile3(
            { key: "AAAAAAAA", version: 1234, title: "Title", creators: creators(1) },
            { key: "AAAAAAAA", version: 1234, title: "Title", creators: creators(2) },
            { key: "AAAAAAAA", version: 1235, title: "Title", creators: creators(3) },
            ignoreFields,
        );
        expect(result.changes).toHaveLength(0);
        expect(result.conflicts).toEqual([
            [
                { field: "creators", op: "modify", value: creators(2) },
                { field: "creators", op: "modify", value: creators(3) },
            ],
        ]);
    });

    test("should automatically merge array/object members and generate conflicts for field changes in absence of cached version", () => {
        const json1 = {
            key: "AAAAAAAA",
            version: 1234,
            itemType: "book",
            title: "Title",
            creators: [{ name: "Center for History and New Media", creatorType: "author" }],
            place: "Place",
            dateModified: "2015-05-14 14:12:34",
            collections: ["AAAAAAAA"],
            relations: { a: "A", b: "B", e: "E1", f: ["F1", "F2"], h: "H", i: ["I"] },
            tags: [{ tag: "A" }, { tag: "C" }, { tag: "F", type: 1 }, { tag: "G" }, { tag: "H", type: 1 }],
        };
        const json2 = {
            key: "AAAAAAAA",
            version: 1235,
            itemType: "book",
            title: "Title",
            creators: [{ creatorType: "author", name: "Center for History and New Media" }],
            date: "2015-05-15",
            dateModified: "2015-05-14 13:45:12",
            collections: ["BBBBBBBB"],
            relations: { a: "A", c: "C", d: ["D"], e: "E2", f: ["F1", "F3"] },
            tags: [{ tag: "B" }, { tag: "C" }, { tag: "F", type: 1 }, { tag: "G", type: 1 }, { tag: "H" }],
        };
        const result = reconcile2(json1, json2, ignoreFields);
        expectSameMembers(result.changes, [
            { field: "collections", op: "member-add", value: "BBBBBBBB" },
            { field: "relations", op: "property-member-add", value: { key: "c", value: "C" } },
            { field: "relations", op: "property-member-add", value: { key: "d", value: "D" } },
            { field: "relations", op: "property-member-add", value: { key: "e", value: "E2" } },
            { field: "relations", op: "property-member-add", value: { key: "f", value: "F3" } },
            { field: "tags", op: "member-add", value: { tag: "B" } },
            { field: "tags", op: "member-add", value: { tag: "G", type: 1 } },
            { field: "tags", op: "member-add", value: { tag: "H" } },
        ]);
        expectSameMembers(result.conflicts, [
            [
                { field: "place", op: "add", value: "Place" },
                { field: "place", op: "delete" },
            ],
            [
                { field: "date", op: "delete" },
                { field: "date", op: "add", value: "2015-05-15" },
            ],
        ]);
    });

    test("should automatically use remote version for unresolvable conflicts when both sides are in trash", () => {
        const result = reconcile3(
            { key: "AAAAAAAA", version: 1234, title: "Title 1" },
            { key: "AAAAAAAA", version: 1234, title: "Title 2", deleted: true },
            { key: "AAAAAAAA", version: 1235, title: "Title 3", deleted: true },
            ignoreFields,
        );
        expect(result.changes).toEqual([{ field: "title", op: "modify", value: "Title 3" }]);
    });

    test("should automatically apply inPublications setting from remote", () => {
        const result = reconcile3(
            { key: "AAAAAAAA", version: 1234, title: "Title 1" },
            { key: "AAAAAAAA", version: 1234, title: "Title 1" },
            { key: "AAAAAAAA", version: 1235, title: "Title 1", inPublications: true },
            ignoreFields,
        );
        expect(result.changes).toEqual([{ field: "inPublications", op: "add", value: true }]);
    });

    test("tags: should handle multiple local type 1 and remote type 0", () => {
        const result = reconcile3(
            { tags: [] },
            { tags: [{ tag: "C", type: 1 }, { tag: "D", type: 1 }] },
            { tags: [{ tag: "C" }, { tag: "D" }] },
        );
        expectSameMembers(result.changes, [
            { field: "tags", op: "member-remove", value: { tag: "C", type: 1 } },
            { field: "tags", op: "member-add", value: { tag: "C" } },
            { field: "tags", op: "member-remove", value: { tag: "D", type: 1 } },
            { field: "tags", op: "member-add", value: { tag: "D" } },
        ]);
    });
});

describe("Zotero: reconcile2() (_reconcileChangesWithoutCache)", () => {
    test("should return conflict for conflicting fields", () => {
        const result = reconcile2(
            { key: "AAAAAAAA", version: 1234, title: "Title 1", pages: 10 },
            { key: "AAAAAAAA", version: 1235, title: "Title 2", place: "New York" },
            ignoreFields,
        );
        expect(result.changes).toHaveLength(0);
        expectSameMembers(result.conflicts, [
            [
                { field: "title", op: "add", value: "Title 1" },
                { field: "title", op: "add", value: "Title 2" },
            ],
            [{ field: "pages", op: "add", value: 10 }, { field: "pages", op: "delete" }],
            [{ field: "place", op: "delete" }, { field: "place", op: "add", value: "New York" }],
        ]);
    });

    test("should automatically use remote version for note markup differences when text content matches", () => {
        const val2 = "<p>Foo bar<br />bar   foo</p>";
        const result = reconcile2(
            { key: "AAAAAAAA", version: 0, itemType: "note", note: "Foo bar<br/>bar foo" },
            { key: "AAAAAAAA", version: 5, itemType: "note", note: val2 },
            ignoreFields,
        );
        expect(result.changes).toEqual([{ field: "note", op: "add", value: val2 }]);
        expect(result.conflicts).toHaveLength(0);
    });

    test("should show conflict for note markup differences when text content doesn't match", () => {
        const result = reconcile2(
            { key: "AAAAAAAA", version: 0, itemType: "note", note: "Foo bar?" },
            { key: "AAAAAAAA", version: 5, itemType: "note", note: "<p>Foo bar!</p>" },
            ignoreFields,
        );
        expect(result.changes).toHaveLength(0);
        expect(result.conflicts).toHaveLength(1);
    });

    test("should automatically use remote version for conflicting fields when both sides are in trash", () => {
        const result = reconcile2(
            { key: "AAAAAAAA", version: 1234, title: "Title 1", pages: 10, deleted: true },
            { key: "AAAAAAAA", version: 1235, title: "Title 2", place: "New York", deleted: true },
            ignoreFields,
        );
        expect(result.conflicts).toHaveLength(0);
        expectSameMembers(result.changes, [
            { field: "title", op: "modify", value: "Title 2" },
            { field: "pages", op: "delete" },
            { field: "place", op: "add", value: "New York" },
        ]);
    });
});

describe("reconcile3(): the cases sync relies on", () => {
    const base = { key: "K", version: 1, itemType: "note", note: "<p>n</p>", tags: [] };

    test("a change on one side only is applied without conflict", () => {
        const r = reconcile3(base, base, { ...base, version: 2, note: "<p>remote</p>" });
        expect(r.conflicts).toHaveLength(0);
        expect(applyChanges(base, r.changes).note).toBe("<p>remote</p>");
    });

    test("different fields merge", () => {
        const r = reconcile3(base, { ...base, tags: [{ tag: "L" }] }, { ...base, note: "<p>R</p>" });
        expect(r.conflicts).toHaveLength(0);
        expect(r.localChanged).toBe(true);
        const merged = applyChanges({ ...base, tags: [{ tag: "L" }] }, r.changes);
        expect(merged).toMatchObject({ note: "<p>R</p>", tags: [{ tag: "L" }] });
    });

    test("the same field changed differently is a conflict", () => {
        const r = reconcile3(base, { ...base, note: "<p>L</p>" }, { ...base, note: "<p>R</p>" });
        expect(r.conflicts).toHaveLength(1);
    });

    test("the same change on both sides is no conflict and nothing local remains", () => {
        const r = reconcile3(base, { ...base, note: "<p>X</p>" }, { ...base, note: "<p>X</p>" });
        expect(r).toEqual({ changes: [], conflicts: [], localChanged: false });
    });

    test("a note whose two sides differ only in markup takes the remote side", () => {
        const r = reconcile3(base, { ...base, note: "<p>same  text</p>" }, { ...base, note: "<div>same text</div>" });
        expect(r.conflicts).toHaveLength(0);
        expect(r.changes).toEqual([{ field: "note", op: "modify", value: "<div>same text</div>" }]);
    });

    test("the same tags added on both sides to an item without a tags field are no conflict", () => {
        const noTags = { key: "K", version: 1, title: "t" };
        const r = reconcile3(noTags, { ...noTags, tags: [{ tag: "same" }] }, { ...noTags, tags: [{ tag: "same" }] });
        expect(r).toEqual({ changes: [], conflicts: [], localChanged: false });
    });

    test("structured values added identically on both sides are no conflict", () => {
        const r = reconcile3({ title: "t" }, { title: "t", creators: [{ name: "A", creatorType: "author" }] }, { title: "t", creators: [{ name: "A", creatorType: "author" }] });
        expect(r.conflicts).toEqual([]);
    });

    test("dateModified never conflicts", () => {
        const r = reconcile3({ ...base, dateModified: "a" }, { ...base, dateModified: "b" }, { ...base, dateModified: "c" });
        expect(r).toEqual({ changes: [], conflicts: [], localChanged: false });
    });
});

describe("noteText", () => {
    test("strips tags, decodes entities and collapses whitespace", () => {
        expect(noteText("<p>a&amp;b<br/>c&nbsp;  d</p>")).toBe("a&b c d");
    });
});

describe("sameContent", () => {
    test("versions, timestamps and empty values are ignored", () => {
        expect(
            sameContent(
                { key: "K", version: 1, title: "t", extra: "", tags: [], dateModified: "a", deleted: false },
                { key: "K", version: 9, title: "t", dateModified: "b", relations: {} },
            ),
        ).toBe(true);
    });

    test("object keys and tag order do not matter", () => {
        expect(sameContent({ a: { x: 1, y: 2 }, tags: [{ tag: "b" }, { tag: "a" }] }, { tags: [{ tag: "a" }, { tag: "b", type: 0 }], a: { y: 2, x: 1 } })).toBe(
            true,
        );
    });

    test("annotationPosition is compared parsed", () => {
        expect(
            sameContent(
                { annotationPosition: '{"pageIndex":0,"rects":[[1,2]]}' },
                { annotationPosition: '{"rects":[[1,2]], "pageIndex":0}' },
            ),
        ).toBe(true);
    });

    test("a real difference is seen", () => {
        expect(sameContent({ note: "a" }, { note: "b" })).toBe(false);
        expect(sameContent({ deleted: true }, {})).toBe(false);
    });
});

describe("deleted: the boolean and the number", () => {
    // The server answers `deleted: 1`; ZotFlow (and 1.6.6) write `true`
    // locally when a note goes to the trash. Both mean "in the trash".
    test("diff sees no change between true and 1", () => {
        expect(diff({ deleted: true }, { deleted: 1 }, ignoreFields)).toEqual([]);
    });

    test("a note trashed on both sides takes the remote text, and deleted is no change", () => {
        // Both in the trash: Zotero applies the remote side without conflicts.
        const local = { deleted: true, note: "<p>local</p>" };
        const remote = { deleted: 1, note: "<p>remote</p>" };
        const r = reconcile2(local, remote);
        expect(r.conflicts).toEqual([]);
        expect(r.changes.map((c) => c.field)).toEqual(["note"]);
    });

    test("patch sends no deleted against a base that holds 1", () => {
        expect(patch({ deleted: 1, title: "a" }, { deleted: true, title: "b" })).toEqual({ title: "b" });
    });

    test("trashing on both sides is no change against a base", () => {
        const r = reconcile3({ note: "<p>a</p>" }, { note: "<p>a</p>", deleted: true }, { note: "<p>a</p>", deleted: 1 });
        expect(r.conflicts).toEqual([]);
    });

    test("restoring still counts: 1 against false is a change", () => {
        expect(diff({ deleted: 1 }, { deleted: false }, ignoreFields)).not.toEqual([]);
    });
});
