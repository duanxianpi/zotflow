// Conflicts in the Activity Center: how a user sees and resolves them, with
// real clicks, against the real test library.

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, test } from "node:test";

import { fact, remote } from "../sync/lib.mjs";
import { key, local, reset, session as connect, until } from "./lib.mjs";

const F = import.meta.filename;

let session;
before(async () => {
    session = await connect();
});
beforeEach(reset);
afterEach(() => closeActivityCenter());

/** Open the Activity Center (Sync tab); returns its modal. */
async function openActivityCenter() {
    const { page } = session;
    await closeActivityCenter();
    await page.evaluate(() => {
        document.querySelectorAll(".notice").forEach((n) => n.remove());
        window.app.commands.executeCommandById("zotflow:open-activity-center");
    });
    const modal = page.locator(".modal.mod-zotflow-ac");
    await modal.locator(".zotflow-sync-view .zotflow-sync-conflicts").waitFor();
    return modal;
}

async function closeActivityCenter() {
    const { page } = session;
    const open = page.locator(".modal.mod-zotflow-ac");
    for (let i = 0; i < 5 && (await open.count()) > 0; i++) {
        await page.keyboard.press("Escape");
        await open.first().waitFor({ state: "detached", timeout: 2000 }).catch(() => {});
    }
    assert.equal(await open.count(), 0, "Activity Center closed");
}

/** The listed conflict for `k`. */
const listed = (modal, k) => modal.locator(".zotflow-conflict-item", { hasText: k });

/** Both sides changed the same note's text; synced once, so it is in conflict. */
async function noteConflict() {
    const N = key("attention-note");
    await local.editNote(N, "Local text");
    await remote.patch(N, { note: "<p>Remote text</p>" });
    await local.sync();
    return N;
}

describe("a changed conflict", () => {
    test("is listed with a field diff; Keep Local, then Sync All, puts the local text on the server", async () => {
        const N = await noteConflict();
        const modal = await openActivityCenter();

        await modal.locator(".zotflow-sync-conflict-badge", { hasText: "1" }).waitFor();
        await listed(modal, N).click();
        const row = modal.locator(".zotflow-field-diff-table tr", { has: session.page.locator("td.zotflow-field-diff-name", { hasText: /^note$/ }) });
        await row.waitFor();
        assert.match(await row.locator(".zotflow-field-diff-val--local").innerText(), /Local text/);
        assert.match(await row.locator(".zotflow-field-diff-val--remote").innerText(), /Remote text/);

        await modal.getByRole("button", { name: "Keep Local" }).click();
        await modal.getByText("No conflicts. Everything is in sync.").waitFor();
        await modal.getByText("All conflicts resolved. Run a sync to push your changes to Zotero.").waitFor();

        await modal.getByRole("button", { name: "Sync All" }).click();
        await until(async () => /Local text/.test((await remote.get(N)).data.note), {
            timeout: 60000,
            interval: 1000,
            message: "the local text on the server",
        });
        await until(async () => (await local.row(N)).syncStatus === "synced", { timeout: 30000, message: "the row synced" });
    });

    test("Accept Remote puts the server's text in the local copy", async () => {
        const N = await noteConflict();
        const modal = await openActivityCenter();

        await listed(modal, N).click();
        await modal.getByRole("button", { name: "Accept Remote" }).click();
        await modal.getByText("No conflicts. Everything is in sync.").waitFor();

        const row = await local.row(N);
        assert.equal(row.syncStatus, "synced");
        assert.match(row.raw.data.note, /Remote text/);
    });
});

describe("a remote deletion with local changes under it", () => {
    test("is listed under one heading and Accept Remote removes the whole group", async () => {
        await local.editNote(key("attention-note"), "Local edit before the remote delete");
        await remote.delete(key("attention"));
        await local.sync();
        const modal = await openActivityCenter();

        const heading = modal.locator(".zotflow-conflict-group-heading");
        await heading.waitFor();
        const text = await heading.innerText();
        fact(F, "group heading for a deleted parent with an edited child note", text);
        assert.match(text, /Deleted in Zotero together \(2\)/);

        await listed(modal, key("attention-note")).click();
        await modal.getByText(/This resolves all 2 items deleted in Zotero together/).waitFor();
        await modal.getByRole("button", { name: "Accept Remote" }).click();
        await modal.getByText("No conflicts. Everything is in sync.").waitFor();

        assert.equal(await local.row(key("attention")), undefined);
        assert.equal(await local.row(key("attention-note")), undefined);
        assert.deepEqual(await local.conflicts(), []);
    });
});

describe("an open Activity Center", () => {
    test("lists a conflict that a sync started from it finds", async () => {
        const modal = await openActivityCenter();
        await modal.getByText("No conflicts. Everything is in sync.").waitFor();

        const N = key("attention-note");
        await local.editNote(N, "Local text");
        await remote.patch(N, { note: "<p>Remote text</p>" });
        await modal.getByRole("button", { name: "Sync All" }).click();

        // Refreshed by the sync-finished event, without reopening.
        await listed(modal, N).waitFor({ timeout: 60000 });
        await modal.locator(".zotflow-sync-conflict-badge", { hasText: "1" }).waitFor();
    });
});
