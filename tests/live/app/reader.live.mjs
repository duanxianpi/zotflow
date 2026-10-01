// Reader: the fixture attachments in ZotFlow's embedded Zotero reader, driven
// with real mouse and keyboard input through Playwright.

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";

import spec from "../../../scripts/fixture-library.mjs";
import { buildDesired } from "../../../scripts/zotero-fixtures-lib.mjs";
import { key, local, openReader, reset, session as connect, until } from "./lib.mjs";

const fixtures = buildDesired(spec);
const annotationsOf = (parentId) =>
    fixtures.items
        .filter((i) => i.data.itemType === "annotation" && i.data.parentItem === key(parentId))
        .map((i) => i.key)
        .sort();

let session;
before(async () => {
    session = await connect();
});
beforeEach(reset);

describe("PDF reader", () => {
    test("shows every fixture annotation in the sidebar", async () => {
        const r = await openReader(session.page, key("attention-pdf"));
        await r.showSidebar();
        const expected = annotationsOf("attention-pdf");
        await r.cards.nth(expected.length - 1).waitFor();
        assert.deepEqual((await r.annotationIds()).sort(), expected);
    });

    test("page navigation from the keyboard and toolbar", async () => {
        const r = await openReader(session.page, key("attention-pdf"));
        const pageNumber = r.reader.locator("#pageNumber");
        await pageNumber.fill("1");
        await pageNumber.press("Enter");
        await r.view.getByText("Attention Is All You Need").first().waitFor();
        await r.reader.getByTitle("Next Page").click();
        await until(async () => (await pageNumber.inputValue()) === "2", { message: "page 2" });
    });

    test("a dragged highlight is saved locally, and deleting it removes the unpushed row", async () => {
        const { page } = session;
        const r = await openReader(page, key("attention-pdf"));
        await r.reader.locator("#pageNumber").fill("1");
        await r.reader.locator("#pageNumber").press("Enter");
        await r.showSidebar();
        const fixtureIds = annotationsOf("attention-pdf");
        await r.cards.nth(fixtureIds.length - 1).waitFor();

        await r.reader.getByTitle("Highlight Text").click();
        const line = r.view.locator(".textLayer span", { hasText: "Ashish Vaswani" }).first();
        const box = await line.boundingBox();
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + 1, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.35, y, { steps: 12 });
        await page.mouse.up();

        const created = await until(
            async () => (await r.annotationIds()).find((id) => !fixtureIds.includes(id)),
            { message: "new sidebar card" },
        );
        const row = await until(() => local.row(created), { message: "IndexedDB row" });
        assert.equal(row.syncStatus, "created");
        assert.equal(row.raw.data.annotationType, "highlight");
        assert.match(row.raw.data.annotationText, /^Ashish/);

        await r.card(created).click();
        await page.keyboard.press("Delete");
        await r.card(created).waitFor({ state: "detached" });
        // Never pushed, so it is removed outright rather than queued.
        await until(async () => !(await local.row(created)), { message: "row removed" });
        for (const id of fixtureIds) {
            assert.equal((await local.row(id))?.syncStatus, "synced", id);
        }
    });
});

describe("reusing a reader leaf", () => {
    // Known bug: ZoteroReaderView.loadDocument() empties the view, removing the
    // bridge's iframe, but the bridge is created only once, so a second
    // setViewState on a loaded reader (same or another attachment) leaves it
    // on "Downloading/Loading…" forever. Drop `todo` once it is fixed.
    test("opening another attachment in the same leaf shows it", { todo: "blank reader on setViewState reuse" }, async () => {
        const { page } = session;
        await openReader(page, key("attention-pdf"));
        await page.evaluate(async (itemKey) => {
            await window.app.workspace.activeLeaf.setViewState({
                type: "zotflow-zotero-reader-view",
                state: { libraryID: Number(itemKey.lib), itemKey: itemKey.key },
                active: true,
            });
        }, { lib: String((await local.row(key("morphology-epub"))).libraryID), key: key("morphology-epub") });
        await page.locator(".workspace-leaf.mod-active iframe").waitFor({ timeout: 10000 });
    });
});

describe("EPUB reader", () => {
    test("shows the fixture highlight", async () => {
        const r = await openReader(session.page, key("morphology-epub"));
        await r.showSidebar();
        await r.card(key("morphology-epub-highlight")).waitFor();
        await r.view.getByText("smallest meaningful unit").first().waitFor();
    });
});
