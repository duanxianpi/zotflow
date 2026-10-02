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
export { key, LIBRARY_ID, local, reset, session } from "../sync/lib.mjs";

/**
 * Show a view in a fresh main-area tab, so each test starts from a newly
 * opened view (reusing a leaf is tested on its own in reader.live.mjs).
 *
 * Order matters:
 * - an empty tab is opened first, so the main area always keeps its tab
 *   group (closing every tab first left none, and the old fallback,
 *   `createLeafInParent(rootSplit)`, put leaves straight into the root split:
 *   no tab bar, saved into the vault's layout);
 * - leaves already showing this view type are closed before the view is
 *   loaded, since the reader allows one leaf per attachment and would close
 *   the new one instead.
 */
export async function openView(page, viewState) {
    await page.evaluate(async (state) => {
        document.querySelectorAll(".notice").forEach((n) => n.remove());
        const ws = window.app.workspace;
        const leaf = ws.getLeaf("tab");
        for (const l of ws.getLeavesOfType(state.type)) if (l !== leaf) l.detach();
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
