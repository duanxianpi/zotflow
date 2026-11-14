// Offline UI regression: only rows and notes owned by this test in the isolated
// live:obsidian vault. No Zotero account or remote fixture library is needed.
/* global app -- Obsidian's application object in page.evaluate callbacks. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness, loadConfig } from "../../../scripts/obsidian-harness.mjs";
import { makePdf } from "../../../scripts/zotero-fixtures-lib.mjs";

const STYLE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
<info><title>Pandoc UI test</title><id>http://www.zotero.org/styles/zf-pandoc-ui</id></info>
<citation><layout prefix="(" suffix=")" delimiter="; "><group delimiter=", ">
<names variable="author"><name form="short"/></names><date variable="issued"><date-part name="year"/></date>
<text variable="locator" prefix="p. "/></group></layout></citation>
<bibliography><layout><names variable="author" suffix=". "><name initialize-with=". "/></names><date variable="issued" prefix="(" suffix="). "><date-part name="year"/></date><text variable="title" font-style="italic" suffix=". "/><text variable="container-title"/><text variable="DOI" prefix=". https://doi.org/"/><text variable="URL" prefix=". "/></layout></bibliography></style>`;
const SOURCE =
    "# Citation preview\n\nEvidence [@zfPreviewSmith, p. 5].\n\nCluster [@zfPreviewSmith; @zfPreviewJones, pp. 8–9].\n\nUnknown [@zfPreviewMissing].\n\n`[@zfPreviewSmith]` and \\[@zfPreviewSmith].\n\nSimple [@zfPreviewSmith].\n\nEnd.\n";
const PATH = "ZF Pandoc UI test.md";
const LIBRARY = 987654321;

test(
    "Pandoc citations display, edit, hover, navigate and refresh without rewriting Markdown",
    { timeout: 60_000 },
    async () => {
        const config = loadConfig();
        assert.match(
            config.vaultPath.replaceAll("\\", "/"),
            /\/\.obsidian-test\/vault$/,
            "This offline test only seeds the repository's default isolated vault",
        );
        const { page, disconnect } = await new Harness(config).playwright();
        await page.setViewportSize({ width: 1024, height: 800 });
        const hotReload = await page.evaluate(
            () => !!app.plugins.plugins["hot-reload"],
        );
        const pdf = makePdf(
            Array.from({ length: 9 }, (_, i) => [
                `Citation test page ${i + 1}`,
            ]),
        );
        let settings;
        try {
            settings = await page.evaluate(
                async ({ style, source, path, library, pdf }) => {
                    // A build may have queued Hot Reload; keep the plugin stable
                    // while this test owns its in-memory settings and CSL style.
                    await app.plugins.disablePlugin("hot-reload");
                    app.saveLocalStorage("zotflow-test-hooks", "1");
                    await app.plugins.disablePlugin("zotflow");
                    await app.plugins.enablePlugin("zotflow");
                    const plugin = app.plugins.plugins.zotflow;
                    const original = structuredClone(plugin.settings);
                    // Dexie opens lazily; let the worker create/upgrade its schema first.
                    await window.__zotflowTest.bridge.dbHelper.getItem(
                        library,
                        "ZFPAND01",
                    );
                    const request = indexedDB.open("zotflow-dev");
                    const db = await new Promise((ok, fail) => {
                        request.onsuccess = () => ok(request.result);
                        request.onerror = () => fail(request.error);
                    });
                    try {
                        const tx = db.transaction(
                            ["items", "keys", "libraries", "files"],
                            "readwrite",
                        );
                        tx.objectStore("keys").put({
                            key: "zf-pandoc-offline-test",
                            userID: library,
                            joinedGroups: [],
                            access: {
                                user: {
                                    library: true,
                                    notes: true,
                                    write: true,
                                    files: true,
                                },
                            },
                        });
                        tx.objectStore("libraries").put({
                            id: library,
                            name: "Pandoc offline UI",
                            type: "user",
                            itemVersion: 1,
                            collectionVersion: 1,
                        });
                        const data = {
                            key: "ZFPAND03",
                            version: 1,
                            itemType: "attachment",
                            parentItem: "ZFPAND01",
                            contentType: "application/pdf",
                            filename: "Citation UI.pdf",
                            linkMode: "imported_file",
                            md5: pdf.md5,
                        };
                        tx.objectStore("items").put({
                            libraryID: library,
                            key: data.key,
                            itemType: "attachment",
                            parentItem: data.parentItem,
                            trashed: 0,
                            title: data.filename,
                            version: 1,
                            synced: 1,
                            syncStatus: "synced",
                            raw: {
                                key: data.key,
                                version: 1,
                                library: {
                                    id: library,
                                    type: "user",
                                    links: {},
                                },
                                data,
                            },
                        });
                        tx.objectStore("files").put({
                            libraryID: library,
                            key: data.key,
                            buffer: new Uint8Array(pdf.bytes).buffer,
                            md5: pdf.md5,
                            size: pdf.bytes.length,
                            mimeType: data.contentType,
                            fileName: data.filename,
                            lastAccessedAt: new Date().toISOString(),
                        });
                        for (const [key, citekey, author] of [
                            ["ZFPAND01", "zfPreviewSmith", "Smith"],
                            ["ZFPAND02", "zfPreviewJones", "Jones"],
                        ]) {
                            tx.objectStore("items").put({
                                libraryID: library,
                                key,
                                citationKey: citekey,
                                itemType: "journalArticle",
                                parentItem: "",
                                trashed: 0,
                                title: `Reference ${author}: Writing with evidence in scientific research`,
                                version: 1,
                                synced: 1,
                                syncStatus: "synced",
                                collections: [],
                                searchCreators: [],
                                searchTags: [],
                                csljson: {
                                    id: key,
                                    type: "article-journal",
                                    title: `Reference ${author}: Writing with evidence in scientific research`,
                                    "container-title":
                                        "A ZotFlow preview example",
                                    ...(author === "Smith"
                                        ? { DOI: "10.1234/zotflow-preview" }
                                        : {
                                              URL: "https://example.org/zotflow-reference",
                                          }),
                                    author: [{ family: author }],
                                    issued: { "date-parts": [[2024]] },
                                },
                                raw: {
                                    key,
                                    version: 1,
                                    library: {
                                        id: library,
                                        type: "user",
                                        name: "Pandoc offline UI",
                                        links: {},
                                    },
                                    data: {
                                        key,
                                        version: 1,
                                        itemType: "journalArticle",
                                        title: `Reference ${author}`,
                                        creators: [
                                            {
                                                creatorType: "author",
                                                lastName: author,
                                            },
                                        ],
                                        tags: [],
                                        collections: [],
                                    },
                                },
                            });
                        }
                        await new Promise((ok, fail) => {
                            tx.oncomplete = ok;
                            tx.onerror = () => fail(tx.error);
                        });
                    } finally {
                        db.close();
                    }
                    Object.assign(plugin.settings, {
                        zoteroapikey: "zf-pandoc-offline-test",
                        librariesConfig: { [library]: { mode: "readonly" } },
                        autoSync: false,
                        useCache: true,
                        useZoteroStorage: false,
                        renderPandocCitations: true,
                        cslDefaultStyleId: "zf-pandoc-ui",
                    });
                    await window.__zotflowTest.bridge.updateSettings(
                        plugin.settings,
                    );
                    await window.__zotflowTest.bridge.cslRender.registerCustomStyle(
                        "zf-pandoc-ui",
                        style,
                    );
                    const existing = app.vault.getFileByPath(path);
                    const file =
                        existing ?? (await app.vault.create(path, source));
                    if (existing) await app.vault.modify(file, source);
                    const leaf = app.workspace.getLeaf("tab");
                    await leaf.openFile(file);
                    await leaf.setViewState({
                        type: "markdown",
                        active: true,
                        state: { file: path, mode: "source", source: false },
                    });
                    app.workspace.setActiveLeaf(leaf, { focus: true });
                    await app.workspace.revealLeaf(leaf);
                    leaf.view.editor.setCursor({
                        line: source.split("\n").length - 1,
                        ch: 0,
                    });
                    return original;
                },
                {
                    style: STYLE,
                    source: SOURCE,
                    path: PATH,
                    library: LIBRARY,
                    pdf: { bytes: [...pdf.bytes], md5: pdf.md5 },
                },
            );

            const widgets = page.locator(
                ".workspace-leaf.mod-active .cm-content .zotflow-pandoc-citation",
            );
            await widgets.first().waitFor();
            assert.equal(await widgets.count(), 3);
            assert.deepEqual(
                await widgets
                    .locator(".zotflow-pandoc-citation-label")
                    .allTextContents(),
                [
                    "(Smith, 2024, p. 5)",
                    "(Smith, 2024; Jones, 2024, p. 8–9)",
                    "(Smith, 2024)",
                ],
            );
            // Typing ordinary prose must preserve the existing citation DOM,
            // including edits on the same line and offsets before a citation.
            await page.evaluate(() => {
                app.workspace.activeLeaf.view.editor.setCursor({
                    line: 2,
                    ch: 0,
                });
                window.__zfTypingRoots = [
                    ...document.querySelectorAll(
                        ".workspace-leaf.mod-active .cm-content .zotflow-pandoc-citation",
                    ),
                ];
            });
            for (const letter of "abc") {
                await page.keyboard.type(letter);
                assert.equal(
                    await widgets.count(),
                    3,
                    "A prose keystroke must not expose raw citation syntax",
                );
                assert.ok(
                    await page.evaluate(() =>
                        window.__zfTypingRoots.every(
                            (node) => node.isConnected,
                        ),
                    ),
                    "Typing must reuse existing citation widgets",
                );
            }
            await page.evaluate(() => {
                const editor = app.workspace.activeLeaf.view.editor;
                editor.setCursor({ line: 2, ch: editor.getLine(2).length });
            });
            for (const letter of "xyz") {
                await page.keyboard.type(letter);
                assert.equal(await widgets.count(), 3);
                assert.ok(
                    await page.evaluate(() =>
                        window.__zfTypingRoots.every(
                            (node) => node.isConnected,
                        ),
                    ),
                );
            }
            await page.evaluate((source) => {
                delete window.__zfTypingRoots;
                app.workspace.activeLeaf.view.editor.setValue(source);
                app.workspace.activeLeaf.view.editor.setCursor({
                    line: 14,
                    ch: 0,
                });
            }, SOURCE);
            await page.waitForFunction(
                () =>
                    document.querySelectorAll(
                        ".workspace-leaf.mod-active .cm-content .zotflow-pandoc-citation",
                    ).length === 3,
            );
            // Editing one citation reveals that citation alone; other clusters
            // stay rendered while the changed key is resolved asynchronously.
            await page.evaluate(() => {
                app.workspace.activeLeaf.view.editor.setCursor({
                    line: 2,
                    ch: 15,
                });
                window.__zfTypingRoots = [
                    ...document.querySelectorAll(
                        ".workspace-leaf.mod-active .cm-content .zotflow-pandoc-citation",
                    ),
                ];
            });
            assert.equal(await widgets.count(), 2);
            await page.keyboard.type("x");
            assert.equal(await widgets.count(), 2);
            assert.ok(
                await page.evaluate(() =>
                    window.__zfTypingRoots.every((node) => node.isConnected),
                ),
            );
            await page.evaluate((source) => {
                delete window.__zfTypingRoots;
                app.workspace.activeLeaf.view.editor.setValue(source);
                app.workspace.activeLeaf.view.editor.setCursor({
                    line: 14,
                    ch: 0,
                });
            }, SOURCE);
            await page.waitForFunction(
                () =>
                    document.querySelectorAll(
                        ".workspace-leaf.mod-active .cm-content .zotflow-pandoc-citation",
                    ).length === 3,
            );
            const popover = page.locator(".zotflow-citation-popover");
            await widgets.first().hover();
            await popover
                .locator(".zotflow-citation-details")
                .waitFor({ state: "visible" });
            assert.match(
                await popover.locator(".zotflow-citation-details").innerText(),
                /Reference Smith/,
            );
            await page.evaluate(() =>
                app.workspace.activeLeaf.view.editor.setCursor({
                    line: 2,
                    ch: 15,
                }),
            );
            await page.waitForFunction(
                () =>
                    document.querySelectorAll(
                        ".workspace-leaf.mod-active .cm-content .zotflow-pandoc-citation",
                    ).length === 2,
            );
            assert.match(
                await page
                    .locator(".workspace-leaf.mod-active .cm-content")
                    .innerText(),
                /\[@zfPreviewSmith, p\. 5\]/,
            );
            assert.equal(
                await page.evaluate(() =>
                    app.workspace.activeLeaf.view.editor.getValue(),
                ),
                SOURCE,
            );

            // Source mode is never decorated; return to Live Preview afterwards.
            await page.evaluate(async (path) => {
                await app.workspace.activeLeaf.setViewState({
                    type: "markdown",
                    state: { file: path, mode: "source", source: true },
                });
            }, PATH);
            assert.equal(await widgets.count(), 0);

            await page.evaluate(async (path) => {
                await app.workspace.activeLeaf.setViewState({
                    type: "markdown",
                    state: { file: path, mode: "preview" },
                });
            }, PATH);
            const reading = page.locator(
                ".workspace-leaf.mod-active .markdown-preview-view .zotflow-pandoc-citation",
            );
            await reading.first().waitFor();
            assert.equal(await reading.count(), 3);
            // Changing the preference refreshes already rendered sections.
            await page.evaluate(() => {
                const plugin = app.plugins.plugins.zotflow;
                plugin.settings.renderPandocCitations = false;
                plugin.pandocCitations.refresh();
            });
            await page.waitForFunction(
                () =>
                    document.querySelectorAll(
                        ".workspace-leaf.mod-active .zotflow-pandoc-citation",
                    ).length === 0,
            );
            await page.evaluate(() => {
                const plugin = app.plugins.plugins.zotflow;
                plugin.settings.renderPandocCitations = true;
                plugin.pandocCitations.refresh();
            });
            await reading.first().waitFor();
            await reading.first().hover();
            await popover.waitFor({ state: "visible" });
            assert.equal(
                await popover.locator(".zotflow-citation-reference").count(),
                1,
            );
            assert.equal(
                await popover
                    .locator(".zotflow-citation-actions button")
                    .count(),
                3,
            );
            const titleStyle = await popover
                .locator('[data-csl-variable="title"]')
                .evaluate((el) => ({
                    weight: getComputedStyle(el).fontWeight,
                    style: getComputedStyle(el).fontStyle,
                }));
            assert.ok(Number(titleStyle.weight) >= 600);
            assert.equal(titleStyle.style, "italic");
            // Intercept OS-facing APIs: test the trusted clicks and exact
            // payloads without replacing the user's clipboard or opening Zotero.
            await page.evaluate(() => {
                const probe = (window.__zfCitationActions = {
                    copied: [],
                    opened: [],
                    clipboardDescriptor: Object.getOwnPropertyDescriptor(
                        navigator.clipboard,
                        "writeText",
                    ),
                    originalOpen: window.open,
                });
                Object.defineProperty(navigator.clipboard, "writeText", {
                    configurable: true,
                    value: async (text) => {
                        probe.copied.push(text);
                    },
                });
                window.open = (...args) => {
                    probe.opened.push(args);
                    return null;
                };
            });
            await popover
                .getByRole("button", {
                    name: "Copy Pandoc citation",
                    exact: true,
                })
                .click();
            await popover
                .getByRole("button", {
                    name: "Pandoc citation copied",
                    exact: true,
                })
                .waitFor();
            assert.deepEqual(
                await page.evaluate(() => window.__zfCitationActions.copied),
                ["[@zfPreviewSmith, p. 5]"],
            );
            const doiLink = popover.locator(
                "a.zotflow-citation-reference-link",
            );
            assert.equal(
                await doiLink.getAttribute("href"),
                "https://doi.org/10.1234/zotflow-preview",
            );
            await doiLink.click();
            assert.deepEqual(
                await page.evaluate(() => window.__zfCitationActions.opened),
                [
                    [
                        "https://doi.org/10.1234/zotflow-preview",
                        "_blank",
                        "noopener,noreferrer",
                    ],
                ],
            );
            await page.evaluate(() => {
                window.__zfCitationActions.opened.length = 0;
            });
            await page.screenshot({
                path: ".obsidian-test/pandoc-reading.png",
                animations: "disabled",
            });
            await popover
                .getByRole("button", { name: "Open in Zotero", exact: true })
                .click();
            assert.deepEqual(
                await page.evaluate(() => window.__zfCitationActions.opened),
                [
                    [
                        "zotero://select/library/items/ZFPAND01",
                        "_blank",
                        "noopener,noreferrer",
                    ],
                ],
            );
            // One work, one title, with both navigation actions even when the
            // citation cluster repeats it. This is not deduplication by title:
            // distinct Zotero works must remain distinct.
            await page.evaluate(async (source) => {
                const renderer = app.plugins.plugins.zotflow.pandocCitations;
                const result = await renderer.render(source);
                const reference = result.rendered[0].references[0];
                const test = renderer.createElement(document, {
                    text: "Combined reference test",
                    references: [
                        reference,
                        {
                            ...reference,
                            pandocCitation: "[@zfPreviewSmith, chap. 2]",
                        },
                    ],
                });
                test.id = "zf-combined-reference-test";
                document.body.appendChild(test);
                test.querySelector("a").focus();
            }, SOURCE);
            assert.equal(
                await popover.locator(".zotflow-citation-reference").count(),
                1,
            );
            assert.equal(
                await popover
                    .getByRole("button", { name: "Open source note" })
                    .count(),
                1,
            );
            assert.equal(
                await popover
                    .getByRole("button", { name: "Open PDF at page 5" })
                    .count(),
                1,
            );
            await popover
                .getByRole("button", {
                    name: "Copy Pandoc citation",
                    exact: true,
                })
                .click();
            assert.equal(
                await page.evaluate(() =>
                    window.__zfCitationActions.copied.at(-1),
                ),
                "[@zfPreviewSmith, p. 5; @zfPreviewSmith, chap. 2]",
            );
            await page.keyboard.press("Escape");
            await page.evaluate(() =>
                document.getElementById("zf-combined-reference-test")?.remove(),
            );
            // Keyboard access and native placement are part of the new card.
            const firstLink = reading
                .first()
                .locator(".zotflow-pandoc-citation-label");
            await firstLink.focus();
            await firstLink.press("ArrowDown");
            assert.equal(
                await page.evaluate(() =>
                    document.activeElement?.getAttribute("aria-label"),
                ),
                "Copy Pandoc citation",
            );
            await page.keyboard.press("Escape");
            await popover.waitFor({ state: "detached" });
            assert.equal(
                await firstLink.getAttribute("aria-expanded"),
                "false",
            );
            await firstLink.evaluate((el) => el.blur());

            await reading.nth(1).hover();
            await popover.waitFor({ state: "visible" });
            assert.equal(
                await popover.locator(".zotflow-citation-reference").count(),
                2,
            );
            const urlLink = popover.locator(
                'a[href="https://example.org/zotflow-reference"]',
            );
            await urlLink.click();
            assert.deepEqual(
                await page.evaluate(() =>
                    window.__zfCitationActions.opened.at(-1),
                ),
                [
                    "https://example.org/zotflow-reference",
                    "_blank",
                    "noopener,noreferrer",
                ],
            );
            await page.screenshot({
                path: ".obsidian-test/pandoc-cluster-light.png",
                animations: "disabled",
            });
            const appearance = await page.evaluate(() => ({
                dark: document.body.classList.contains("theme-dark"),
                width: innerWidth,
                height: innerHeight,
            }));
            try {
                await page.evaluate(() => {
                    document.body.classList.remove("theme-light");
                    document.body.classList.add("theme-dark");
                });
                await page.screenshot({
                    path: ".obsidian-test/pandoc-cluster-dark.png",
                    animations: "disabled",
                });
                await page.setViewportSize({ width: 640, height: 800 });
                await firstLink.focus();
                await page.keyboard.press("Escape");
                // A wrapped inline link's bounding box can cover adjacent
                // prose; move onto its first actual text rect instead.
                const target = await reading
                    .nth(1)
                    .locator("a")
                    .evaluate((el) => {
                        const rect = el.getClientRects()[0];
                        return {
                            x: rect.left + 4,
                            y: rect.top + rect.height / 2,
                        };
                    });
                await page.mouse.move(10, 10);
                await page.mouse.move(target.x, target.y);
                await popover.waitFor({ state: "visible" });
                assert.equal(
                    await popover
                        .locator(".zotflow-citation-reference")
                        .count(),
                    2,
                );
                const bounds = await popover.evaluate((el) => ({
                    left: el.getBoundingClientRect().left,
                    right: el.getBoundingClientRect().right,
                    width: innerWidth,
                }));
                assert.ok(
                    bounds.left >= 0 && bounds.right <= bounds.width,
                    `Card must fit viewport: ${JSON.stringify(bounds)}`,
                );
                await page.screenshot({
                    path: ".obsidian-test/pandoc-narrow-dark.png",
                    animations: "disabled",
                });
            } finally {
                await page.setViewportSize({
                    width: appearance.width,
                    height: appearance.height,
                });
                await page.evaluate((dark) => {
                    document.body.classList.toggle("theme-dark", dark);
                    document.body.classList.toggle("theme-light", !dark);
                }, appearance.dark);
            }
            await firstLink.press("ArrowDown");
            await popover.waitFor({ state: "visible" });
            await popover
                .getByRole("group", {
                    name: "Actions for zfPreviewSmith",
                    exact: true,
                })
                .getByRole("button", { name: "Open source note" })
                .click();
            await page.waitForFunction(
                () =>
                    app.workspace.getActiveFile()?.path !==
                    "ZF Pandoc UI test.md",
            );
            await page.waitForFunction(
                () =>
                    app.metadataCache.getFileCache(
                        app.workspace.getActiveFile(),
                    )?.frontmatter?.["zotero-key"] === "ZFPAND01",
            );
            assert.equal(
                await page.evaluate(
                    () =>
                        app.metadataCache.getFileCache(
                            app.workspace.getActiveFile(),
                        )?.frontmatter?.["zotero-key"],
                ),
                "ZFPAND01",
            );
            assert.equal(
                await page.evaluate(
                    async (path) =>
                        app.vault.cachedRead(app.vault.getFileByPath(path)),
                    PATH,
                ),
                SOURCE,
            );

            await page.evaluate((path) => {
                const leaf = app.workspace
                    .getLeavesOfType("markdown")
                    .find((leaf) => leaf.view.file?.path === path);
                app.workspace.setActiveLeaf(leaf, { focus: true });
            }, PATH);
            await reading.first().hover();
            await popover
                .getByRole("button", { name: "Open PDF at page 5" })
                .click();
            const reader = page.frameLocator(
                ".workspace-leaf.mod-active iframe",
            );
            const pageNumber = reader.locator("#pageNumber");
            await pageNumber.waitFor();
            await page.waitForFunction(() => {
                const view = app.workspace.activeLeaf.view;
                return view.getState()?.itemKey === "ZFPAND03";
            });
            await reader.locator("#pageNumber").evaluate(
                (input) =>
                    new Promise((resolve, reject) => {
                        const deadline = Date.now() + 10000;
                        const check = () => {
                            if (input.value === "5") resolve();
                            else if (Date.now() > deadline)
                                reject(
                                    new Error(
                                        `Expected PDF page 5, got ${input.value}`,
                                    ),
                                );
                            else window.setTimeout(check, 50);
                        };
                        check();
                    }),
            );
            assert.equal(await pageNumber.inputValue(), "5");
            await page.evaluate(async (path) => {
                const leaf = app.workspace
                    .getLeavesOfType("markdown")
                    .find((leaf) => leaf.view.file?.path === path);
                app.workspace.setActiveLeaf(leaf, { focus: true });
                await app.plugins.disablePlugin("zotflow");
            }, PATH);
            assert.equal(await reading.count(), 0);
            assert.equal(
                await page.evaluate(
                    async (path) =>
                        app.vault.cachedRead(app.vault.getFileByPath(path)),
                    PATH,
                ),
                SOURCE,
            );
            await page.evaluate(() => app.plugins.enablePlugin("zotflow"));
        } finally {
            await page.evaluate(() => {
                const probe = window.__zfCitationActions;
                if (!probe) return;
                window.open = probe.originalOpen;
                if (probe.clipboardDescriptor)
                    Object.defineProperty(
                        navigator.clipboard,
                        "writeText",
                        probe.clipboardDescriptor,
                    );
                else delete navigator.clipboard.writeText;
                delete window.__zfCitationActions;
            });
            if (settings)
                await page.evaluate(
                    async ({ settings, library, path }) => {
                        const plugin = app.plugins.plugins.zotflow;
                        Object.assign(plugin.settings, settings);
                        await window.__zotflowTest.bridge.updateSettings(
                            plugin.settings,
                        );
                        await window.__zotflowTest.bridge.cslRender.unregisterCustomStyle(
                            "zf-pandoc-ui",
                        );
                        for (const file of app.vault.getMarkdownFiles()) {
                            if (
                                file.path === path ||
                                app.metadataCache.getFileCache(file)
                                    ?.frontmatter?.["library-id"] === library
                            )
                                await app.vault.delete(file);
                        }
                        const request = indexedDB.open("zotflow-dev");
                        const db = await new Promise((ok) => {
                            request.onsuccess = () => ok(request.result);
                        });
                        for (const leaf of app.workspace.getLeavesOfType(
                            "zotflow-zotero-reader-view",
                        )) {
                            if (leaf.view.getState()?.libraryID === library)
                                leaf.detach();
                        }
                        const tx = db.transaction(
                            ["items", "keys", "libraries", "files"],
                            "readwrite",
                        );
                        for (const key of ["ZFPAND01", "ZFPAND02", "ZFPAND03"])
                            tx.objectStore("items").delete([library, key]);
                        tx.objectStore("keys").delete("zf-pandoc-offline-test");
                        tx.objectStore("libraries").delete(library);
                        tx.objectStore("files").delete([library, "ZFPAND03"]);
                        await new Promise((ok) => {
                            tx.oncomplete = ok;
                        });
                        db.close();
                    },
                    { settings, library: LIBRARY, path: PATH },
                );
            if (hotReload)
                await page.evaluate(() =>
                    app.plugins.enablePlugin("hot-reload"),
                );
            await disconnect();
        }
    },
);
