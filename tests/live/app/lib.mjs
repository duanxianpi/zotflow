// Shared helpers for live UI tests: Playwright attached over CDP to the
// isolated test Obsidian (`npm run live:obsidian -- launch`).
//
// Data and the connection come from the live sync helpers: `session()` is
// the shared Playwright connection, `reset()` puts the fixture library and
// the local copy in a known state, `local.row()` reads IndexedDB.
//
// Locate things the way a user sees them (titles, text, ids) and let
// Playwright wait for them; never pick a sidebar card by index, since the
// reader sorts annotations by position on the page.

import { setTimeout as sleep } from "node:timers/promises";

import { LIBRARY_ID } from "../sync/lib.mjs";

// One Playwright connection per test file, shared with the sync helpers and
// closed by them when the file's tests end.
export { key, local, reset, session } from "../sync/lib.mjs";

/**
 * Show a view in a main-area leaf that is not already a reader. Reusing a
 * reader leaf hits a known bug (a second setViewState on a loaded reader
 * leaves it blank; see reader.live.mjs), and after the last main tab is
 * detached `getLeaf(true)` fails with "No tab group found", so fall back to
 * creating a leaf in the root split.
 */
export async function openView(page, viewState) {
    await page.evaluate(async (state) => {
        document.querySelectorAll(".notice").forEach((n) => n.remove());
        const ws = window.app.workspace;
        for (const l of ws.getLeavesOfType(state.type)) l.detach();
        const recent = ws.getMostRecentLeaf(ws.rootSplit);
        const leaf =
            recent && recent.view.getViewType() !== state.type
                ? recent
                : ws.createLeafInParent(ws.rootSplit, 0);
        await leaf.setViewState({ ...state, active: true });
        ws.setActiveLeaf(leaf, { focus: true });
    }, viewState);
}

/** Open a library attachment in ZotFlow's reader; returns its frames. */
export async function openReader(page, itemKey) {
    await openView(page, {
        type: "zotflow-zotero-reader-view",
        state: { libraryID: LIBRARY_ID, itemKey },
    });
    const reader = page.frameLocator(".workspace-leaf.mod-active iframe");
    // The document itself (PDF.js / EPUB view) is a second, nested iframe.
    const view = reader.frameLocator("iframe");
    const cards = reader.locator("[data-sidebar-annotation-id]");
    await reader.locator("#pageNumber").waitFor();
    return {
        reader,
        view,
        cards,
        async showSidebar() {
            if (!(await reader.locator(".annotations").isVisible())) {
                await reader.getByTitle("Toggle Sidebar").click();
            }
            await reader.locator(".annotations").waitFor();
        },
        async annotationIds() {
            return cards.evaluateAll((els) =>
                els.map((e) => e.getAttribute("data-sidebar-annotation-id")),
            );
        },
        card: (id) => reader.locator(`[data-sidebar-annotation-id="${id}"]`),
    };
}

/** Poll `fn` until it returns a truthy value. */
export async function until(fn, { timeout = 10000, interval = 100, message = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
        await sleep(interval);
    }
}
