// The live-test fixture set: what `npm run live:fixtures -- apply` makes the test
// library contain. Ids are permanent: an object's Zotero key is derived from
// its id (fixtureKey), so tests can address it without a lookup. Rename an id
// and the object is deleted and recreated under a new key.
//
// Files are generated here, not stored: deterministic bytes, so re-applying
// uploads nothing unless the content below changes.
//
// Coverage goals, each something the fake server cannot show:
//   - item types whose base fields have their own names (case, statute,
//     patent, bookSection) and every creator role used by templates
//   - nested collections, unfiled items, standalone notes and attachments,
//     an item in the trash
//   - every PDF annotation type, placed on real generated text; an EPUB
//     highlight; tags on annotations; CJK and very long strings
//   - attachments without a file, link-only attachments, an HTML snapshot

import { annotate, makeEpub, makeHtml, makePdf } from "./zotero-fixtures-lib.mjs";

const attentionPdf = makePdf([
    [
        "Attention Is All You Need",
        "Ashish Vaswani, Noam Shazeer, Niki Parmar",
        "",
        "Abstract",
        "The dominant sequence transduction models are based on complex",
        "recurrent or convolutional neural networks. We propose a new simple",
        "network architecture, the Transformer, based solely on attention",
        "mechanisms, dispensing with recurrence and convolutions entirely.",
    ],
    [
        "3.2 Attention",
        "An attention function can be described as mapping a query and a set",
        "of key-value pairs to an output.",
        "",
        "3.2.1 Scaled Dot-Product Attention",
        "We compute the dot products of the query with all keys, divide each",
        "by the square root of the key dimension, and apply a softmax function.",
    ],
]);

const lectureNotesPdf = makePdf([
    [
        "Lecture Notes: Convolutional Networks",
        "A convolution layer slides a small filter over the input.",
        "Pooling reduces the spatial size of the representation.",
    ],
]);

const morphologyEpub = makeEpub({
    title: "Introducing Morphology",
    chapters: [
        {
            title: "Words and their parts",
            paragraphs: [
                "Morphology is the study of the internal structure of words.",
                "A morpheme is the smallest meaningful unit of a language.",
            ],
        },
        {
            title: "Inflection and derivation",
            paragraphs: [
                "Inflection creates forms of a word; derivation creates new words.",
            ],
        },
    ],
});

const resnetSnapshot = makeHtml("Deep Residual Learning for Image Recognition", [
    "Deeper neural networks are more difficult to train.",
    "We present a residual learning framework to ease the training of networks.",
]);

export default {
    root: { id: "root", name: "ZotFlow fixtures" },

    collections: [
        { id: "papers", name: "Papers" },
        { id: "papers-transformers", name: "Transformers", parent: "papers" },
        { id: "books", name: "Books" },
        { id: "legal", name: "Legal & Patents" },
        { id: "cjk", name: "中文资料 · 日本語" },
    ],

    items: [
        {
            id: "attention",
            data: {
                itemType: "journalArticle",
                title: "Attention Is All You Need",
                creators: [
                    { creatorType: "author", firstName: "Ashish", lastName: "Vaswani" },
                    { creatorType: "author", firstName: "Noam", lastName: "Shazeer" },
                    { creatorType: "editor", name: "NeurIPS Program Committee" },
                ],
                publicationTitle: "Advances in Neural Information Processing Systems",
                volume: "30",
                pages: "5998-6008",
                date: "2017-12-04",
                DOI: "10.48550/arXiv.1706.03762",
                url: "https://arxiv.org/abs/1706.03762",
                abstractNote: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
                tags: [{ tag: "transformer" }, { tag: "attention" }, { tag: "auto-imported", type: 1 }],
                collections: ["papers", "papers-transformers"],
            },
            children: [
                {
                    id: "attention-pdf",
                    data: {
                        itemType: "attachment",
                        linkMode: "imported_file",
                        title: "Full Text PDF",
                        filename: "Vaswani et al. - 2017 - Attention Is All You Need.pdf",
                        contentType: "application/pdf",
                    },
                    file: attentionPdf,
                    annotations: [
                        {
                            id: "attention-pdf-highlight-title",
                            data: annotate.pdfText("highlight", attentionPdf, "Attention Is All You Need", {
                                annotationComment: "Title highlight with a comment.",
                                tags: [{ tag: "key-paper" }],
                            }),
                        },
                        {
                            id: "attention-pdf-highlight-transformer",
                            data: annotate.pdfText("highlight", attentionPdf, "the Transformer", {
                                annotationColor: "#2ea8e5",
                            }),
                        },
                        {
                            id: "attention-pdf-underline",
                            data: annotate.pdfText("underline", attentionPdf, "Scaled Dot-Product Attention", {
                                page: 1,
                                annotationColor: "#ff6666",
                                annotationComment: "Multi-line\ncomment with **markdown** and a [[wikilink]].",
                            }),
                        },
                        {
                            id: "attention-pdf-note",
                            data: annotate.pdfNote(1, 520, 640, {
                                annotationComment: "Sticky note: 注意力机制的核心。",
                            }),
                        },
                        {
                            id: "attention-pdf-image",
                            // "Abstract" heading through the last abstract line.
                            data: annotate.pdfImage(0, [66, 572, 546, 670], {
                                annotationComment: "Abstract region.",
                            }),
                        },
                        {
                            id: "attention-pdf-ink",
                            data: annotate.pdfInk(1, [80, 560, 140, 590, 200, 560, 260, 590], {
                                annotationColor: "#a28ae5",
                            }),
                        },
                        {
                            id: "attention-pdf-text",
                            data: annotate.pdfFreeText(1, [320, 500, 540, 530], "Free text box"),
                        },
                    ],
                },
                {
                    id: "attention-note",
                    data: {
                        itemType: "note",
                        note: "<h1>Reading notes</h1><p>Self-attention replaces recurrence.</p><ul><li>Multi-head</li><li>Positional encoding</li></ul>",
                        tags: [{ tag: "summary" }],
                    },
                },
                {
                    id: "attention-link",
                    data: {
                        itemType: "attachment",
                        linkMode: "linked_url",
                        title: "arXiv abstract page",
                        url: "https://arxiv.org/abs/1706.03762",
                        contentType: "text/html",
                    },
                },
            ],
        },
        {
            id: "resnet",
            data: {
                itemType: "conferencePaper",
                title: "Deep Residual Learning for Image Recognition",
                creators: [
                    { creatorType: "author", firstName: "Kaiming", lastName: "He" },
                    { creatorType: "author", firstName: "Xiangyu", lastName: "Zhang" },
                ],
                proceedingsTitle: "Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition",
                conferenceName: "CVPR 2016",
                date: "2016",
                collections: ["papers"],
            },
            children: [
                {
                    id: "resnet-snapshot",
                    data: {
                        itemType: "attachment",
                        linkMode: "imported_url",
                        title: "Snapshot",
                        url: "https://arxiv.org/abs/1512.03385",
                        filename: "1512.03385.html",
                        contentType: "text/html",
                        charset: "utf-8",
                    },
                    file: resnetSnapshot,
                },
            ],
        },
        {
            id: "morphology",
            data: {
                itemType: "book",
                title: "Introducing Morphology",
                creators: [
                    { creatorType: "author", firstName: "Rochelle", lastName: "Lieber" },
                    { creatorType: "translator", firstName: "Example", lastName: "Translator" },
                ],
                publisher: "Example Press",
                place: "Cambridge",
                edition: "2",
                date: "2016",
                ISBN: "978-0-00-000000-2",
                collections: ["books"],
            },
            children: [
                {
                    id: "morphology-epub",
                    data: {
                        itemType: "attachment",
                        linkMode: "imported_file",
                        title: "EPUB",
                        filename: "Introducing Morphology.epub",
                        contentType: "application/epub+zip",
                    },
                    file: morphologyEpub,
                    annotations: [
                        {
                            id: "morphology-epub-highlight",
                            data: annotate.epubText("highlight", morphologyEpub, "smallest meaningful unit", {
                                paragraph: 1,
                                annotationComment: "Definition.",
                            }),
                        },
                    ],
                },
            ],
        },
        {
            id: "morphology-chapter",
            data: {
                itemType: "bookSection",
                title: "Words and their parts",
                bookTitle: "Introducing Morphology",
                creators: [
                    { creatorType: "author", firstName: "Rochelle", lastName: "Lieber" },
                    { creatorType: "bookAuthor", firstName: "Rochelle", lastName: "Lieber" },
                ],
                pages: "1-20",
                date: "2016",
                collections: ["books"],
            },
        },
        {
            id: "legal-case",
            data: {
                itemType: "case",
                caseName: "Example v. Fixture",
                court: "Supreme Court",
                dateDecided: "2001-05-14",
                reporter: "U.S.",
                reporterVolume: "532",
                firstPage: "1",
                collections: ["legal"],
            },
        },
        {
            id: "legal-statute",
            data: {
                itemType: "statute",
                nameOfAct: "Fixture Protection Act",
                code: "U.S.C.",
                codeNumber: "17",
                section: "107",
                dateEnacted: "1976",
                collections: ["legal"],
            },
        },
        {
            id: "legal-patent",
            data: {
                itemType: "patent",
                title: "Method for synchronizing reference libraries",
                creators: [{ creatorType: "inventor", firstName: "Ada", lastName: "Fixture" }],
                patentNumber: "US 1,234,567 B2",
                issueDate: "2020-02-02",
                filingDate: "2018-01-01",
                assignee: "ZotFlow Labs",
                collections: ["legal"],
            },
        },
        {
            id: "cjk-article",
            data: {
                itemType: "journalArticle",
                title: "注意力机制在自然语言处理中的应用 —— 日本語のサブタイトル付き",
                creators: [
                    { creatorType: "author", firstName: "伟", lastName: "张" },
                    { creatorType: "author", name: "山田太郎" },
                ],
                publicationTitle: "计算机学报",
                date: "2021年3月",
                language: "zh-CN",
                tags: [{ tag: "中文标签" }, { tag: "日本語タグ" }],
                collections: ["cjk"],
            },
        },
        {
            id: "long-title",
            data: {
                itemType: "report",
                title: "An extremely long report title used to check truncation, wrapping, file name limits and sanitization: slashes / back\\slashes, colons: question marks? asterisks* quotes \"double\" pipes | and angle <brackets> — repeated until it is well over two hundred characters long",
                institution: "ZotFlow Fixture Institute",
                date: "2024-01-01",
            },
        },
        {
            id: "unfiled-preprint",
            data: {
                itemType: "preprint",
                title: "An unfiled preprint without collections",
                creators: [{ creatorType: "author", name: "Single-Field Name" }],
                repository: "arXiv",
                archiveID: "arXiv:2401.00001",
                date: "2024-01-02",
            },
        },
        {
            id: "trashed-document",
            data: {
                itemType: "document",
                title: "A document in the trash",
                deleted: true,
                collections: ["papers"],
            },
        },
        {
            id: "standalone-note",
            data: {
                itemType: "note",
                note: "<h2>Standalone note</h2><p>Not attached to any item. Links to <a href=\"https://www.zotero.org\">Zotero</a>.</p>",
                collections: ["papers"],
            },
        },
        {
            id: "standalone-pdf",
            data: {
                itemType: "attachment",
                linkMode: "imported_file",
                title: "Lecture Notes - Convolutional Networks",
                filename: "LectureNotes_CNN.pdf",
                contentType: "application/pdf",
            },
            file: lectureNotesPdf,
            annotations: [
                {
                    id: "standalone-pdf-highlight",
                    data: annotate.pdfText("highlight", lectureNotesPdf, "small filter", {
                        annotationColor: "#5fb236",
                    }),
                },
            ],
        },
        {
            id: "missing-file",
            data: {
                itemType: "book",
                title: "A book whose PDF was never uploaded",
                creators: [{ creatorType: "author", firstName: "Missing", lastName: "File" }],
                date: "2010",
                collections: ["books"],
            },
            children: [
                {
                    id: "missing-file-pdf",
                    data: {
                        itemType: "attachment",
                        linkMode: "imported_file",
                        title: "Full Text PDF",
                        filename: "never-uploaded.pdf",
                        contentType: "application/pdf",
                    },
                },
            ],
        },
    ],
};
