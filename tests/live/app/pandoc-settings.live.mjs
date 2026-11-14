// Exercise the real declarative settings UI in the isolated test vault.
/* global app -- Obsidian's application object in page.evaluate callbacks. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness, loadConfig } from "../../../scripts/obsidian-harness.mjs";

test(
    "Pandoc preview sits below the default format and follows its visibility",
    { timeout: 30_000 },
    async () => {
        const config = loadConfig();
        assert.match(
            config.vaultPath.replaceAll("\\", "/"),
            /\/\.obsidian-test\/vault$/,
        );
        const { page, context, disconnect } = await new Harness(
            config,
        ).playwright();
        const original = await page.evaluate(() => ({
            format: app.plugins.plugins.zotflow.settings.defaultCitationFormat,
            preview: app.plugins.plugins.zotflow.settings.renderPandocCitations,
        }));
        try {
            await page.evaluate(() => {
                app.setting.open();
                app.setting.openTabById("zotflow");
            });
            let settingsPage;
            for (const candidate of context.pages()) {
                if ((await candidate.title()).startsWith("Settings"))
                    settingsPage = candidate;
            }
            assert.ok(settingsPage, "Obsidian settings window is open");
            await settingsPage.getByText("Citation", { exact: true }).click();
            const row = (name) =>
                settingsPage.locator(".setting-item").filter({
                    has: settingsPage.getByText(name, { exact: true }),
                });
            const format = row("Default Citation Format").locator(
                "select:not([aria-hidden=true])",
            );
            const preview = row("Preview Pandoc Citations");
            await format.selectOption("pandoc");
            await preview.waitFor({ state: "visible" });
            const names = await settingsPage
                .locator(".vertical-tab-content-container .setting-item-name")
                .allTextContents();
            assert.equal(
                names.indexOf("Preview Pandoc Citations"),
                names.indexOf("Default Citation Format") + 1,
            );
            await settingsPage.screenshot({
                path: ".obsidian-test/pandoc-settings.png",
                animations: "disabled",
            });
            for (const choice of ["footnote", "wikilink"]) {
                await format.selectOption(choice);
                await preview.waitFor({ state: "hidden" });
            }
            await format.selectOption("pandoc");
            await preview.waitFor({ state: "visible" });
            assert.equal(
                await page.evaluate(
                    () =>
                        app.plugins.plugins.zotflow.settings
                            .renderPandocCitations,
                ),
                original.preview,
            );
        } finally {
            await page.evaluate(async (original) => {
                const plugin = app.plugins.plugins.zotflow;
                plugin.settings.defaultCitationFormat = original.format;
                plugin.settings.renderPandocCitations = original.preview;
                await plugin.saveSettings();
                app.setting.close();
            }, original);
            await disconnect();
        }
    },
);
