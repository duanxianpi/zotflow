// Engine for the live-test fixture set: deterministic keys, generated
// attachment files, a Zotero Web API client, and a reconcile planner that
// only ever touches objects the fixture set owns.
//
// Ownership (anything else in the library is never read-modified-written):
//   - a regular item whose `extra` has a `zotflow-fixture: <id>` line
//   - a note whose HTML carries `data-zotflow-fixture="<id>"`
//   - a standalone attachment whose key is a fixture key
//   - any child (attachment, note, annotation) of an owned item, whatever
//     its key, so things tests create under fixture items are reset too
//   - the fixture root collection (fixture key + name) and its descendants

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { zipSync } from "fflate";

// ---------------------------------------------------------------------------
// Keys

// Zotero object keys: 8 characters from this alphabet (no 0, 1, O).
const KEY_ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
export const KEY_PREFIX = "ZFX";

/** Stable Zotero key for a fixture id: "ZFX" + 5 characters of its hash. */
export function fixtureKey(id) {
    const hash = createHash("sha256").update(`zotflow-fixture:${id}`).digest();
    let key = KEY_PREFIX;
    for (let i = 0; key.length < 8; i++) {
        key += KEY_ALPHABET[hash[i] % KEY_ALPHABET.length];
    }
    return key;
}

export const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// Generated files

// Helvetica advance widths (1/1000 em) for ASCII 32..126, from the standard
// Adobe AFM. Lets annotations be placed exactly over generated text.
const HELVETICA = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
    584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
    278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
    500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
    500, 334, 260, 334, 584,
];

function textWidth(text, fontSize) {
    let units = 0;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code < 32 || code > 126) {
            throw new Error(`PDF fixtures support ASCII only: ${JSON.stringify(text)}`);
        }
        units += HELVETICA[code - 32];
    }
    return (units * fontSize) / 1000;
}

const round = (n) => Math.round(n * 1000) / 1000;
const pad = (n, width) => String(Math.max(0, Math.floor(n))).padStart(width, "0");

/**
 * A minimal PDF: US Letter pages of left-aligned Helvetica lines. `find`
 * returns the reader position of a phrase (within one line), so fixture
 * annotations sit on real text.
 */
export function makePdf(pages, { fontSize = 12, leading = 18, margin = 72 } = {}) {
    const WIDTH = 612;
    const HEIGHT = 792;
    const layout = pages.map((lines) =>
        lines.map((text, i) => ({
            text,
            x: margin,
            y: HEIGHT - margin - fontSize - i * leading,
        })),
    );

    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        null, // page tree, filled in once page object numbers are known
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    const kids = [];
    for (const lines of layout) {
        const escape = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
        const stream = [
            "BT",
            `/F1 ${fontSize} Tf`,
            ...lines.map(
                (l) => `1 0 0 1 ${l.x} ${l.y} Tm (${escape(l.text)}) Tj`,
            ),
            "ET",
        ].join("\n");
        objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
        const contents = objects.length;
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`,
        );
        kids.push(`${objects.length} 0 R`);
    }
    objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;

    let out = "%PDF-1.4\n";
    const offsets = [];
    objects.forEach((body, i) => {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${pad(o, 10)} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = Buffer.from(out, "latin1");

    return {
        bytes,
        md5: md5(bytes),
        pageCount: pages.length,
        /** Reader position of `phrase` on `page` (0-based). */
        find(phrase, page = 0) {
            const lines = layout[page];
            if (!lines) throw new Error(`No page ${page}`);
            let offset = 0;
            for (const line of lines) {
                const at = line.text.indexOf(phrase);
                if (at !== -1) {
                    const x0 = line.x + textWidth(line.text.slice(0, at), fontSize);
                    const x1 = x0 + textWidth(phrase, fontSize);
                    const top = line.y + 0.78 * fontSize;
                    return {
                        pageIndex: page,
                        rects: [[round(x0), round(line.y - 0.22 * fontSize), round(x1), round(top)]],
                        sortIndex: `${pad(page, 5)}|${pad(offset + at, 6)}|${pad(HEIGHT - top, 5)}`,
                        text: phrase,
                    };
                }
                offset += line.text.length + 1;
            }
            throw new Error(`"${phrase}" is not on page ${page}`);
        },
    };
}

const escapeXml = (s) =>
    s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

/**
 * A minimal EPUB 3: one XHTML document per chapter (`<h1>` + `<p>`s directly
 * in `<body>`), so CFIs can be computed without a renderer. Zip entries use a
 * fixed mtime, keeping the bytes (and md5) stable across runs.
 */
export function makeEpub({ title, language = "en", chapters }) {
    const mtime = new Date(Date.UTC(2024, 0, 1));
    const file = (text, level = 6) => [Buffer.from(text, "utf8"), { level, mtime }];
    const chapterFiles = {};
    chapters.forEach((chapter, i) => {
        chapterFiles[`OEBPS/chapter${i + 1}.xhtml`] = file(
            `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="${language}"><head><title>${escapeXml(chapter.title)}</title></head><body><h1>${escapeXml(chapter.title)}</h1>${chapter.paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join("")}</body></html>`,
        );
    });
    const manifest = chapters
        .map(
            (_c, i) =>
                `<item id="c${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`,
        )
        .join("");
    const spine = chapters.map((_c, i) => `<itemref idref="c${i + 1}"/>`).join("");
    const nav = chapters
        .map((c, i) => `<li><a href="chapter${i + 1}.xhtml">${escapeXml(c.title)}</a></li>`)
        .join("");

    const bytes = Buffer.from(
        zipSync({
            // `mimetype` must come first and be stored uncompressed.
            mimetype: file("application/epub+zip", 0),
            "META-INF/container.xml": file(
                '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
            ),
            "OEBPS/content.opf": file(
                `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:zotflow-fixture:${escapeXml(title)}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>${language}</dc:language><meta property="dcterms:modified">2024-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${spine}</spine></package>`,
            ),
            "OEBPS/nav.xhtml": file(
                `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`,
            ),
            ...chapterFiles,
        }),
    );

    return {
        bytes,
        md5: md5(bytes),
        /** CFI selector for `phrase` inside paragraph `paragraph` of chapter `chapter` (0-based). */
        find(phrase, chapter = 0, paragraph = 0) {
            const text = chapters[chapter]?.paragraphs[paragraph];
            const at = text?.indexOf(phrase) ?? -1;
            if (at === -1) throw new Error(`"${phrase}" not in chapter ${chapter} paragraph ${paragraph}`);
            // Spine items are /6/2, /6/4…; in the document, <body> is /4 and
            // its children are <h1> (/2) then the paragraphs (/4, /6…).
            const path = `/6/${2 * (chapter + 1)}!/4/${2 * (paragraph + 2)}`;
            const before = chapters[chapter].paragraphs
                .slice(0, paragraph)
                .reduce((n, p) => n + p.length, chapters[chapter].title.length);
            return {
                position: {
                    type: "FragmentSelector",
                    conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html",
                    value: `epubcfi(${path},/1:${at},/1:${at + phrase.length})`,
                },
                sortIndex: `${pad(chapter, 5)}|${pad(before + at, 8)}`,
                text: phrase,
            };
        },
    };
}

export function makeHtml(title, paragraphs) {
    const bytes = Buffer.from(
        `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeXml(title)}</title></head><body><h1>${escapeXml(title)}</h1>${paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join("")}</body></html>\n`,
        "utf8",
    );
    return { bytes, md5: md5(bytes) };
}

// ---------------------------------------------------------------------------
// Annotation helpers for the spec

const pdfAnnotation = (type, page, extra = {}) => ({
    annotationType: type,
    annotationPageLabel: String(page + 1),
    annotationColor: "#ffd400",
    annotationComment: "",
    ...extra,
});

export const annotate = {
    /** Highlight or underline over `phrase` in a generated PDF. */
    pdfText(type, pdf, phrase, { page = 0, ...extra } = {}) {
        const at = pdf.find(phrase, page);
        return pdfAnnotation(type, page, {
            annotationText: at.text,
            annotationSortIndex: at.sortIndex,
            annotationPosition: { pageIndex: page, rects: at.rects },
            ...extra,
        });
    },
    /** Sticky note at (x, y) in PDF user space. */
    pdfNote(page, x, y, extra = {}) {
        return pdfAnnotation("note", page, {
            annotationSortIndex: `${pad(page, 5)}|000000|${pad(792 - y - 22, 5)}`,
            annotationPosition: { pageIndex: page, rects: [[x, y, x + 22, y + 22]] },
            ...extra,
        });
    },
    /** Rectangle selection (image annotation). */
    pdfImage(page, rect, extra = {}) {
        return pdfAnnotation("image", page, {
            annotationSortIndex: `${pad(page, 5)}|000000|${pad(792 - rect[3], 5)}`,
            annotationPosition: { pageIndex: page, rects: [rect] },
            ...extra,
        });
    },
    /** Freehand stroke through the given points. */
    pdfInk(page, points, extra = {}) {
        const ys = points.filter((_v, i) => i % 2 === 1);
        return pdfAnnotation("ink", page, {
            annotationSortIndex: `${pad(page, 5)}|000000|${pad(792 - Math.max(...ys), 5)}`,
            annotationPosition: { pageIndex: page, width: 2, paths: [points] },
            ...extra,
        });
    },
    /** Free text box. */
    pdfFreeText(page, rect, comment, extra = {}) {
        return pdfAnnotation("text", page, {
            annotationComment: comment,
            annotationSortIndex: `${pad(page, 5)}|000000|${pad(792 - rect[3], 5)}`,
            annotationPosition: { pageIndex: page, fontSize: 14, rotation: 0, rects: [rect] },
            ...extra,
        });
    },
    /** Highlight over `phrase` in a generated EPUB. */
    epubText(type, epub, phrase, { chapter = 0, paragraph = 0, ...extra } = {}) {
        const at = epub.find(phrase, chapter, paragraph);
        return {
            annotationType: type,
            annotationText: at.text,
            annotationComment: "",
            annotationColor: "#5fb236",
            annotationPageLabel: "",
            annotationSortIndex: at.sortIndex,
            annotationPosition: at.position,
            ...extra,
        };
    },
};

// ---------------------------------------------------------------------------
// Spec → desired Zotero objects

export const MARKER_LINE = /^zotflow-fixture: (.+)$/m;
const NOTE_MARKER = /data-zotflow-fixture="([^"]*)"/;
const TYPES_WITHOUT_EXTRA = new Set(["note", "attachment", "annotation"]);

/**
 * Flatten a spec into Zotero API objects keyed by fixture keys.
 * Each item gets `depth` (0 top-level, 1 child, 2 annotation) for write order.
 */
export function buildDesired(spec) {
    const collections = [];
    const items = [];
    const ids = new Map();
    const claim = (id) => {
        const key = fixtureKey(id);
        if (ids.has(key)) {
            throw new Error(`Fixture key collision: "${id}" and "${ids.get(key)}"`);
        }
        ids.set(key, id);
        return key;
    };

    const rootKey = claim(`collection:${spec.root.id}`);
    collections.push({
        id: spec.root.id,
        key: rootKey,
        depth: 0,
        data: { key: rootKey, name: spec.root.name, parentCollection: false },
    });
    const collectionKeys = new Map([[spec.root.id, rootKey]]);
    const depthOf = new Map([[spec.root.id, 0]]);
    for (const c of spec.collections) {
        const parent = collectionKeys.get(c.parent ?? spec.root.id);
        if (!parent) throw new Error(`Collection "${c.id}": unknown parent "${c.parent}"`);
        const key = claim(`collection:${c.id}`);
        collectionKeys.set(c.id, key);
        const depth = depthOf.get(c.parent ?? spec.root.id) + 1;
        depthOf.set(c.id, depth);
        collections.push({ id: c.id, key, depth, data: { key, name: c.name, parentCollection: parent } });
    }

    const toItem = (node, depth, parentKey) => {
        const key = claim(node.id);
        const data = { ...node.data, key };
        if (parentKey) data.parentItem = parentKey;
        if (data.collections) {
            data.collections = data.collections.map((c) => {
                const k = collectionKeys.get(c);
                if (!k) throw new Error(`Item "${node.id}": unknown collection "${c}"`);
                return k;
            });
        }
        if (data.itemType === "note") {
            data.note = `<div data-zotflow-fixture="${node.id}" data-schema-version="9">${data.note ?? ""}</div>`;
        } else if (!TYPES_WITHOUT_EXTRA.has(data.itemType)) {
            data.extra = [data.extra, `zotflow-fixture: ${node.id}`].filter(Boolean).join("\n");
        }
        if (data.annotationPosition && typeof data.annotationPosition !== "string") {
            data.annotationPosition = JSON.stringify(data.annotationPosition);
        }
        if (data.deleted) data.deleted = 1;
        const item = { id: node.id, key, depth, data };
        if (node.file) {
            item.file = { bytes: node.file.bytes, md5: node.file.md5 };
        }
        items.push(item);
        for (const child of node.children ?? []) toItem(child, depth + 1, key);
        for (const a of node.annotations ?? []) {
            // Explicit ids keep keys stable when annotations are reordered.
            if (!a.id) throw new Error(`Annotation under "${node.id}" needs an id`);
            toItem({ id: a.id, data: { itemType: "annotation", ...a.data } }, depth + 1, key);
        }
    };
    for (const node of spec.items) toItem(node, 0, null);

    return { rootKey, rootName: spec.root.name, collections, items, ids };
}

// ---------------------------------------------------------------------------
// Ownership and planning (pure)

/** Which remote objects belong to the fixture set. */
export function ownedSets(desired, remote) {
    const items = new Map(remote.items.map((i) => [i.key, i]));
    const owned = new Set();
    const memo = new Map();
    const isOwned = (key, seen = new Set()) => {
        if (memo.has(key)) return memo.get(key);
        const item = items.get(key);
        let result = false;
        if (item && !seen.has(key)) {
            seen.add(key);
            const d = item.data;
            if (d.parentItem) result = isOwned(d.parentItem, seen);
            else if (d.itemType === "note") result = NOTE_MARKER.test(d.note ?? "");
            else if (d.itemType === "attachment") result = desired.ids.has(key);
            else result = MARKER_LINE.test(d.extra ?? "");
        }
        memo.set(key, result);
        return result;
    };
    for (const key of items.keys()) if (isOwned(key)) owned.add(key);

    const collections = new Map(remote.collections.map((c) => [c.key, c]));
    const ownedCollections = new Set();
    const collectionOwned = (key, seen = new Set()) => {
        const c = collections.get(key);
        if (!c || seen.has(key)) return false;
        seen.add(key);
        if (key === desired.rootKey) return c.data.name === desired.rootName;
        return c.data.parentCollection ? collectionOwned(c.data.parentCollection, seen) : false;
    };
    for (const key of collections.keys()) if (collectionOwned(key)) ownedCollections.add(key);

    return { items: owned, collections: ownedCollections };
}

// Fields the server maintains, or that we never manage.
const IGNORED_FIELDS = new Set([
    "key", "version", "dateAdded", "dateModified", "relations", "md5", "mtime",
    "annotationAuthorName", "annotationIsExternal", "inPublications", "parentItem",
]);

const isEmpty = (v) =>
    v === undefined || v === null || v === "" || v === false || v === 0 ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

function normalize(field, value) {
    if (field === "annotationPosition" && typeof value === "string") {
        try {
            return JSON.stringify(JSON.parse(value));
        } catch {
            return value;
        }
    }
    if (field === "tags") {
        return JSON.stringify(
            (value ?? []).map((t) => ({ tag: t.tag, type: t.type ?? 0 })).sort((a, b) => a.tag.localeCompare(b.tag)),
        );
    }
    if (field === "collections") return JSON.stringify([...(value ?? [])].sort());
    if (field === "deleted") return value ? 1 : 0;
    if (field === "parentCollection") return value || false;
    return JSON.stringify(value ?? "");
}

/** Field-level differences; the object to send is `{...desired, ...changes}`. */
export function diffFields(want, have) {
    const changes = {};
    for (const [field, value] of Object.entries(want)) {
        if (IGNORED_FIELDS.has(field)) continue;
        if (normalize(field, value) !== normalize(field, have[field])) changes[field] = value;
    }
    for (const [field, value] of Object.entries(have)) {
        if (IGNORED_FIELDS.has(field) || field in want || isEmpty(value)) continue;
        // Something (a test, the user) set a field the spec leaves empty.
        changes[field] = Array.isArray(value) ? [] : field === "deleted" ? 0 : "";
    }
    if (want.parentItem !== undefined && want.parentItem !== have.parentItem) {
        changes.parentItem = want.parentItem;
    }
    return changes;
}

/**
 * What it takes to make the remote library match the spec, touching only
 * owned objects. `conflicts` lists fixture keys held by objects we do not own;
 * apply refuses to run while there are any.
 */
export function plan(desired, remote) {
    const own = ownedSets(desired, remote);
    const remoteItems = new Map(remote.items.map((i) => [i.key, i]));
    const remoteCollections = new Map(remote.collections.map((c) => [c.key, c]));
    const result = {
        conflicts: [],
        collections: { create: [], update: [] },
        items: { create: [], update: [] },
        uploads: [],
        deletes: { items: [], collections: [] },
    };

    for (const c of desired.collections) {
        const have = remoteCollections.get(c.key);
        if (!have) result.collections.create.push(c);
        else if (!own.collections.has(c.key)) result.conflicts.push({ kind: "collection", key: c.key, id: c.id });
        else {
            const changes = diffFields(c.data, have.data);
            if (Object.keys(changes).length > 0) {
                result.collections.update.push({ ...c, version: have.version, changes });
            }
        }
    }
    for (const item of desired.items) {
        const have = remoteItems.get(item.key);
        if (!have) result.items.create.push(item);
        else if (!own.items.has(item.key)) result.conflicts.push({ kind: "item", key: item.key, id: item.id });
        else {
            const changes = diffFields(item.data, have.data);
            if (Object.keys(changes).length > 0) {
                result.items.update.push({ ...item, version: have.version, changes });
            }
        }
        if (item.file && remoteItems.get(item.key)?.data.md5 !== item.file.md5) {
            result.uploads.push({ ...item, oldMd5: remoteItems.get(item.key)?.data.md5 ?? null });
        }
    }

    const wantedItems = new Set(desired.items.map((i) => i.key));
    const doomed = [...own.items].filter((k) => !wantedItems.has(k));
    const doomedSet = new Set(doomed);
    // Deleting a parent deletes its children; only send the topmost.
    result.deletes.items = doomed
        .filter((k) => !doomedSet.has(remoteItems.get(k)?.data.parentItem))
        .map((k) => remoteItems.get(k));

    const wantedCollections = new Set(desired.collections.map((c) => c.key));
    const doomedCollections = [...own.collections].filter((k) => !wantedCollections.has(k));
    const doomedCollectionSet = new Set(doomedCollections);
    result.deletes.collections = doomedCollections
        .filter((k) => !doomedCollectionSet.has(remoteCollections.get(k)?.data.parentCollection))
        .map((k) => remoteCollections.get(k));

    return result;
}

export function planIsEmpty(p) {
    return (
        p.collections.create.length + p.collections.update.length +
        p.items.create.length + p.items.update.length + p.uploads.length +
        p.deletes.items.length + p.deletes.collections.length === 0
    );
}

/** Plan that deletes everything owned (purge). */
export function purgePlan(desired, remote) {
    return plan({ ...desired, collections: [], items: [] }, remote);
}

// ---------------------------------------------------------------------------
// Zotero Web API client

export class ZoteroClient {
    constructor({ apiKey, library, fetchImpl = fetch, base = "https://api.zotero.org" }) {
        if (!/^(users|groups)\/\d+$/.test(library)) {
            throw new Error(`Library must look like "groups/<id>" or "users/<id>", got "${library}"`);
        }
        this.apiKey = apiKey;
        this.prefix = `${base}/${library}`;
        this.base = base;
        this.fetch = fetchImpl;
        this.version = null;
    }

    async request(method, url, { headers = {}, body } = {}) {
        for (let attempt = 0; ; attempt++) {
            const res = await this.fetch(url, {
                method,
                headers: { "Zotero-API-Key": this.apiKey, "Zotero-API-Version": "3", ...headers },
                body,
            });
            const version = res.headers.get("Last-Modified-Version");
            if (version) this.version = Number(version);
            const backoff = Number(res.headers.get("Backoff") ?? 0);
            if ((res.status === 429 || res.status === 503) && attempt < 5) {
                const wait = Number(res.headers.get("Retry-After") ?? 2 ** attempt);
                await sleep(wait * 1000);
                continue;
            }
            if (backoff > 0) await sleep(backoff * 1000);
            if (!res.ok) {
                throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
            }
            return res;
        }
    }

    async getAll(path) {
        const all = [];
        for (let start = 0; ; start += 100) {
            const sep = path.includes("?") ? "&" : "?";
            const res = await this.request("GET", `${this.prefix}${path}${sep}limit=100&start=${start}`);
            const page = await res.json();
            all.push(...page);
            const total = Number(res.headers.get("Total-Results") ?? all.length);
            if (all.length >= total || page.length === 0) return all;
        }
    }

    async snapshot() {
        const [items, collections] = await Promise.all([
            this.getAll("/items?includeTrashed=1"),
            this.getAll("/collections"),
        ]);
        return {
            items: items.map((i) => ({ key: i.key, version: i.version, data: i.data })),
            collections: collections.map((c) => ({ key: c.key, version: c.version, data: c.data })),
        };
    }

    /** POST up to 50 objects per request; throws on any per-object failure. */
    async write(kind, objects) {
        for (let i = 0; i < objects.length; i += 50) {
            const chunk = objects.slice(i, i + 50);
            const res = await this.request("POST", `${this.prefix}/${kind}`, {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(chunk),
            });
            const out = await res.json();
            const failed = Object.entries(out.failed ?? {});
            if (failed.length > 0) {
                const lines = failed.map(([idx, f]) => `${chunk[idx]?.key}: ${f.code} ${f.message}`);
                throw new Error(`Writing ${kind} failed:\n  ${lines.join("\n  ")}`);
            }
        }
    }

    async remove(kind, keys) {
        const param = kind === "items" ? "itemKey" : "collectionKey";
        for (let i = 0; i < keys.length; i += 50) {
            if (this.version === null) await this.request("GET", `${this.prefix}/items?limit=1`);
            await this.request("DELETE", `${this.prefix}/${kind}?${param}=${keys.slice(i, i + 50).join(",")}`, {
                headers: { "If-Unmodified-Since-Version": String(this.version) },
            });
        }
    }

    /** Zotero storage upload: authorize, send to S3, register. */
    async upload(key, bytes, filename, oldMd5) {
        const condition = oldMd5 ? { "If-Match": oldMd5 } : { "If-None-Match": "*" };
        const form = { "Content-Type": "application/x-www-form-urlencoded", ...condition };
        const auth = await (
            await this.request("POST", `${this.prefix}/items/${key}/file`, {
                headers: form,
                body: new URLSearchParams({
                    md5: md5(bytes),
                    filename,
                    filesize: String(bytes.length),
                    mtime: "1704067200000",
                }).toString(),
            })
        ).json();
        if (auth.exists) return;
        const s3 = await this.fetch(auth.url, {
            method: "POST",
            headers: { "Content-Type": auth.contentType },
            body: Buffer.concat([Buffer.from(auth.prefix, "latin1"), bytes, Buffer.from(auth.suffix, "latin1")]),
        });
        if (!s3.ok) throw new Error(`Upload of ${filename} failed: ${s3.status}`);
        await this.request("POST", `${this.prefix}/items/${key}/file`, {
            headers: form,
            body: `upload=${auth.uploadKey}`,
        });
    }

    /** Libraries this key can write to, for setup hints. */
    async writableLibraries() {
        const res = await this.request("GET", `${this.base}/keys/current`);
        const info = await res.json();
        const out = [];
        if (info.access?.user?.write) out.push({ library: `users/${info.userID}`, name: `${info.username} (My Library)` });
        const groups = info.access?.groups ?? {};
        const ids = Object.keys(groups).filter((id) => id !== "all");
        if (ids.length > 0 || groups.all) {
            const list = await (await this.request("GET", `${this.base}/users/${info.userID}/groups`)).json();
            for (const g of list) {
                const access = groups[g.id] ?? groups.all;
                if (access?.write) out.push({ library: `groups/${g.id}`, name: g.data.name });
            }
        }
        return out;
    }
}

// ---------------------------------------------------------------------------
// Apply

const byDepth = (list) => [...list].sort((a, b) => a.depth - b.depth);

/** Execute a plan: collections, items (parents first), files, then deletes. */
export async function applyPlan(client, p, log = () => {}) {
    if (p.conflicts.length > 0) {
        throw new Error(
            `Fixture keys already used by objects outside the fixture set: ${p.conflicts.map((c) => `${c.key} (${c.id})`).join(", ")}`,
        );
    }
    const collectionWrites = byDepth([
        ...p.collections.create.map((c) => ({ ...c, body: { ...c.data, version: 0 } })),
        ...p.collections.update.map((c) => ({ ...c, body: { ...c.changes, key: c.key, version: c.version } })),
    ]);
    for (const depth of new Set(collectionWrites.map((c) => c.depth))) {
        const batch = collectionWrites.filter((c) => c.depth === depth);
        log(`collections: writing ${batch.length} at depth ${depth}`);
        await client.write("collections", batch.map((c) => c.body));
    }

    const itemWrites = byDepth([
        ...p.items.create.map((i) => ({ ...i, body: { ...i.data, version: 0 } })),
        ...p.items.update.map((i) => ({
            ...i,
            body: { ...i.changes, key: i.key, itemType: i.data.itemType, version: i.version },
        })),
    ]);
    for (const depth of new Set(itemWrites.map((i) => i.depth))) {
        const batch = itemWrites.filter((i) => i.depth === depth);
        log(`items: writing ${batch.length} at depth ${depth}`);
        await client.write("items", batch.map((i) => i.body));
    }

    for (const u of p.uploads) {
        log(`upload: ${u.data.filename} (${u.file.bytes.length} bytes)`);
        await client.upload(u.key, u.file.bytes, u.data.filename, u.oldMd5);
    }

    if (p.deletes.items.length > 0) {
        log(`items: deleting ${p.deletes.items.length}`);
        await client.remove("items", p.deletes.items.map((i) => i.key));
    }
    if (p.deletes.collections.length > 0) {
        log(`collections: deleting ${p.deletes.collections.length}`);
        await client.remove("collections", p.deletes.collections.map((c) => c.key));
    }
}

/** Human-readable plan, one line per change. */
export function describePlan(p) {
    const label = (o) => `${o.data?.itemType ?? "collection"} ${o.id ?? o.key}`;
    return [
        ...p.conflicts.map((c) => `! conflict  ${c.kind} ${c.key} (${c.id}) is not a fixture object`),
        ...p.collections.create.map((c) => `+ create    collection ${c.id} "${c.data.name}"`),
        ...p.collections.update.map((c) => `~ update    collection ${c.id}: ${Object.keys(c.changes).join(", ")}`),
        ...p.items.create.map((i) => `+ create    ${label(i)}`),
        ...p.items.update.map((i) => `~ update    ${label(i)}: ${Object.keys(i.changes).join(", ")}`),
        ...p.uploads.map((u) => `^ upload    ${u.data.filename}`),
        ...p.deletes.items.map((i) => `- delete    ${i.data.itemType} ${i.key} ${JSON.stringify(i.data.title ?? i.data.annotationText ?? "").slice(0, 40)}`),
        ...p.deletes.collections.map((c) => `- delete    collection ${c.key} "${c.data.name}"`),
    ];
}
