// Local-only UI regression: run against `npm run live:obsidian -- launch`.
// No Zotero key or network writes. Fixtures live in the isolated harness vault.
import assert from "node:assert/strict";
import { Harness, loadConfig } from "../../scripts/obsidian-harness.mjs";
import {
    makePdf,
    makeEpub,
    makeHtml,
} from "../../scripts/zotero-fixtures-lib.mjs";

const session = await new Harness(loadConfig()).playwright();
const { page } = session;
page.setDefaultTimeout(15000);
const previous = await page.evaluate(() => {
    const settings = window.app.plugins.plugins.zotflow.settings;
    return Object.fromEntries(
        [
            "annotationProfiles",
            "defaultAnnotationProfileId",
            "autoTagAnnotations",
            "annotationCategoryTags",
            "groupSourceNoteAnnotations",
            "labeledAnnotationCallouts",
        ].map((key) => [key, settings[key]]),
    );
});
try {
    // Dismiss profile drafts left by an interrupted manual settings check.
    for (const windowPage of session.context.pages()) {
        for (const cancel of await windowPage.locator(".zotflow-profiles-modal").getByRole("button", { name: "Cancel", exact: true }).all()) {
            await cancel.click();
        }
    }
    const pdf = makePdf([
        [
            "Methodology evidence limitations.",
            "Another line for annotation testing.",
        ],
    ]);
    const epub = makeEpub({
        title: "Profile test",
        chapters: [
            {
                title: "Chapter",
                paragraphs: ["Methodology evidence limitations."],
            },
        ],
    });
    const html = makeHtml("Profile test", [
        "Methodology evidence limitations.",
    ]);
    await page.evaluate(
        async ({ files }) => {
            window.app.setting.close();
            const plugin = window.app.plugins.plugins.zotflow;
            plugin.settings.annotationProfiles = [
                {
                    id: "research",
                    name: "Research",
                    palette: [
                        { id: "m", color: "#ffd400", label: "Methodology" },
                        { id: "e", color: "#2ea8e5", label: "Evidence" },
                    ],
                },
                {
                    id: "review",
                    name: "Review",
                    palette: [
                        { id: "r", color: "#ffd400", label: "Limitations" },
                    ],
                },
            ];
            plugin.settings.defaultAnnotationProfileId = "research";
            plugin.settings.autoTagAnnotations = true;
            await plugin.saveSettings();
            for (const leaf of window.app.workspace.getLeavesOfType(
                "zotflow-local-zotero-reader-view",
            ))
                leaf.detach();
            for (const [name, bytes] of files) {
                const data = new Uint8Array(bytes).buffer;
                const existing = window.app.vault.getAbstractFileByPath(name);
                if (existing)
                    await window.app.vault.modifyBinary(existing, data);
                else await window.app.vault.createBinary(name, data);
            }
            const sidecar = "zf-profile-pdf.zf.json";
            const old = window.app.vault.getAbstractFileByPath(sidecar);
            const empty = JSON.stringify({ version: 1, annotations: [] });
            if (old) await window.app.vault.modify(old, empty);
            else await window.app.vault.create(sidecar, empty);
            await window.app.workspace.getLeaf("tab").setViewState({
                type: "zotflow-local-zotero-reader-view",
                state: { file: "zf-profile-pdf.pdf" },
                active: true,
            });
        },
        {
            files: [
                ["zf-profile-pdf.pdf", [...pdf.bytes]],
                ["zf-profile-book.epub", [...epub.bytes]],
                ["zf-profile-page.html", [...html.bytes]],
            ],
        },
    );

    const leaf = page.locator(".workspace-leaf.mod-active");
    const reader = leaf.frameLocator("iframe");
    const chooser = reader.getByRole("combobox", {
        name: "Annotation profile",
        exact: true,
    });
    await chooser.waitFor();
    assert.equal(await chooser.inputValue(), "research");
    // Electron native popup menus live outside CDP. Verify that trusted keys
    // reach the focused select unconsumed; selectOption tests its change event.
    await page.bringToFront();
    await chooser.focus();
    await chooser.evaluate((el) => {
        window.profileKeyEvents = [];
        el.addEventListener("keydown", (event) => {
            window.setTimeout(
                () =>
                    window.profileKeyEvents.push({
                        key: event.key,
                        prevented: event.defaultPrevented,
                        focused: document.activeElement === el,
                    }),
                0,
            );
        });
    });
    await chooser.press("ArrowDown");
    await chooser.press("Escape");
    const keyboardEvents = await chooser.evaluate(
        () => window.profileKeyEvents,
    );
    assert(
        keyboardEvents.some(
            (event) =>
                event.key === "ArrowDown" && !event.prevented && event.focused,
        ),
    );
    await chooser.selectOption("research");
    await reader.getByTitle("Highlight Text", { exact: true }).click();
    await reader.getByTitle("Pick a Color", { exact: true }).click();
    await reader
        .getByRole("button", { name: "Evidence (#2ea8e5)", exact: true })
        .click();

    const document = reader.frameLocator("#primary-view iframe");
    const text = document
        .locator(".textLayer span")
        .filter({ hasText: "Methodology evidence limitations." })
        .first();
    const box = await text.boundingBox();
    assert(box);
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, {
        steps: 12,
    });
    await page.mouse.up();
    await chooser.selectOption("review");
    await page.waitForFunction(
        async () =>
            JSON.parse(
                await window.app.vault.read(
                    window.app.vault.getAbstractFileByPath(
                        "zf-profile-pdf.zf.json",
                    ),
                ),
            ).annotations.length > 0,
    );
    const saved = await page.evaluate(async () =>
        JSON.parse(
            await window.app.vault.read(
                window.app.vault.getAbstractFileByPath(
                    "zf-profile-pdf.zf.json",
                ),
            ),
        ),
    );
    assert(
        saved.annotations.some((a) =>
            a.tags.some((tag) => tag.name === "Evidence"),
        ),
    );
    assert(
        !saved.annotations.some((a) =>
            a.tags.some((tag) => tag.name === "Limitations"),
        ),
    );

    // Settings changes update labels without changing saved annotations.
    await page.evaluate(async () => {
        const plugin = window.app.plugins.plugins.zotflow;
        plugin.settings.annotationProfiles.find(
            (p) => p.id === "review",
        ).palette[0].label = "Changed label";
        await plugin.saveSettings();
    });
    await reader.getByTitle("Pick a Color", { exact: true }).click();
    await reader
        .getByRole("button", { name: "Changed label (#ffd400)", exact: true })
        .waitFor();
    await page.keyboard.press("Escape");
    const after = await page.evaluate(async () =>
        JSON.parse(
            await window.app.vault.read(
                window.app.vault.getAbstractFileByPath(
                    "zf-profile-pdf.zf.json",
                ),
            ),
        ),
    );
    assert.deepEqual(after, saved);

    // All controls remain reachable in a phone-width viewport.
    const iframe = await leaf.locator("iframe").elementHandle();
    const frame = await iframe.contentFrame();
    await frame.evaluate(() => {
        window.frameElement.setCssProps({ width: "375px" });
    });
    await chooser.selectOption("research");
    await chooser.scrollIntoViewIfNeeded();
    const geometry = await chooser.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: window.innerWidth };
    });
    assert(geometry.left >= 0 && geometry.right <= geometry.width);
    await frame.evaluate(() => {
        window.frameElement.setCssProps({ width: "" });
    });

    for (const file of ["zf-profile-book.epub", "zf-profile-page.html"]) {
        await page.evaluate(async (file) => {
            await window.app.workspace.getLeaf("tab").setViewState({
                type: "zotflow-local-zotero-reader-view",
                state: { file },
                active: true,
            });
        }, file);
        await chooser.waitFor();
        assert.equal(await chooser.inputValue(), "research");
        await chooser.selectOption("review");
    }
    console.log(
        "PASS: PDF drag/tag persistence, profile switching, keyboard, live updates, narrow viewport, EPUB and HTML",
    );
} finally {
    await page.evaluate(async (settings) => {
        Object.assign(window.app.plugins.plugins.zotflow.settings, settings);
        await window.app.plugins.plugins.zotflow.saveSettings();
    }, previous);
    await session.disconnect();
}
