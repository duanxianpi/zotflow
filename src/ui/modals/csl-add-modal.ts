import { ButtonComponent, Modal, setIcon, Setting } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { renderStyleDetails } from "ui/modals/csl-style-details";

import type { App } from "obsidian";
import type { LocalePreview, StylePreview } from "worker/csl";

/**
 * BRAT-style "add by id" modal: the user enters a style id (or full URL)
 * from https://www.zotero.org/styles/, the style is fetched and its
 * metadata, dependency impact and rendered preview are shown for
 * confirmation; Add stays disabled until a fetch succeeds. Unpublished
 * custom styles go in the vault styles folder instead.
 */
export class AddCslStyleModal extends Modal {
    private preview: StylePreview | null = null;
    private resultEl!: HTMLElement;
    private addBtn!: ButtonComponent;
    private busy = false;

    constructor(
        app: App,
        private onAdded: () => void,
    ) {
        super(app);
        this.setTitle("Add citation style");
    }

    onOpen(): void {
        const { contentEl } = this;
        this.modalEl.addClass("zotflow-modal", "zotflow-csl-modal");
        contentEl.addClass("zotflow-csl-add-modal");

        let input = "";
        const doFetch = () => void this.fetchPreview(input);

        new Setting(contentEl)
            .setName("Style ID or URL")
            .setDesc(
                createFragment((f) => {
                    f.appendText("Paste from the ");
                    f.createEl("a", {
                        text: "Zotero style repository",
                        href: "https://www.zotero.org/styles/",
                    });
                    f.appendText(" — e.g. ieee or apa.");
                }),
            )
            .addText((text) => {
                text.setPlaceholder("Example: ieee").onChange((v) => {
                    input = v;
                });
                text.inputEl.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") doFetch();
                });
            })
            .addButton((btn) => {
                btn.setButtonText("Fetch").setCta().onClick(doFetch);
            });

        this.resultEl = contentEl.createDiv("zotflow-csl-add-result");
        this.renderIdle();

        const buttons = new Setting(contentEl).setClass(
            "zotflow-csl-modal-buttons",
        );
        buttons.addButton((btn) => {
            btn.setButtonText("Cancel").onClick(() => this.close());
        });
        buttons.addButton((btn) => {
            this.addBtn = btn;
            btn.setButtonText("Add style")
                .setCta()
                .setDisabled(true)
                .onClick(() => void this.add());
        });
    }

    private renderIdle(): void {
        this.resultEl.empty();
        this.resultEl.createDiv({
            cls: "zotflow-csl-add-idle",
            text: "Fetch a style to preview it before adding.",
        });
    }

    private renderLoading(): void {
        this.resultEl.empty();
        const card = this.resultEl.createDiv(
            "zotflow-csl-modal-card is-loading",
        );
        for (const width of ["w60", "w35", "w80", "w50", "w70"]) {
            card.createDiv("zotflow-csl-modal-row").createSpan(
                `zotflow-csl-skeleton zotflow-csl-skeleton--${width}`,
            );
        }
    }

    private renderError(input: string): void {
        this.resultEl.empty();
        const box = this.resultEl.createDiv(
            "zotflow-csl-callout zotflow-csl-callout--error",
        );
        const icon = box.createSpan("zotflow-csl-inline-icon");
        setIcon(icon, "alert-triangle");
        const text = box.createSpan();
        text.appendText("Couldn't fetch ");
        text.createSpan({ cls: "zotflow-csl-mono", text: input.trim() });
        text.appendText(
            ". Check the ID against the Zotero style repository, or paste the full style URL.",
        );
    }

    private renderResult(p: StylePreview): void {
        this.resultEl.empty();

        if (p.dependent && p.parent) {
            const box = this.resultEl.createDiv("zotflow-csl-details-note");
            const icon = box.createSpan("zotflow-csl-inline-icon");
            setIcon(icon, "corner-down-right");
            const text = box.createSpan();
            text.appendText("This is an alias of ");
            text.createSpan({ cls: "zotflow-csl-strong", text: p.parent });
            text.appendText(" — the parent style will be downloaded too.");
        }
        if (p.alreadyInstalled) {
            const box = this.resultEl.createDiv(
                "zotflow-csl-callout zotflow-csl-callout--warning",
            );
            const icon = box.createSpan("zotflow-csl-inline-icon");
            setIcon(icon, "alert-triangle");
            box.createSpan({
                text: "A style with this id is already installed — adding will overwrite it.",
            });
        }

        const details = renderStyleDetails(
            this.resultEl,
            {
                id: p.id,
                title: p.title,
                citationFormat: p.citationFormat,
                hasBibliography: p.hasBibliography,
                defaultLocale: p.defaultLocale,
                source: "remote",
                sourceUrl: p.sourceUrl,
                aliasOf: p.dependent ? p.parent : undefined,
            },
            // The impact callout above already covers the relationship.
            { dependencyNotes: false },
        );
        details.setSample(p.sample);
    }

    private async fetchPreview(input: string): Promise<void> {
        if (!input.trim() || this.busy) return;
        this.busy = true;
        this.preview = null;
        this.addBtn.setDisabled(true);
        this.renderLoading();
        try {
            this.preview = await workerBridge.cslRender.previewStyle(input);
            this.renderResult(this.preview);
            this.addBtn.setDisabled(false);
        } catch (e) {
            services.logService.error(
                `Failed to fetch style "${input}"`,
                "AddCslStyleModal",
                e,
            );
            this.renderError(input);
        } finally {
            this.busy = false;
        }
    }

    private async add(): Promise<void> {
        if (!this.preview || this.busy) return;
        this.busy = true;
        this.addBtn.setDisabled(true).setButtonText("Adding…");
        try {
            const avail = await workerBridge.cslRender.addStyle(this.preview);
            services.notificationService.notify(
                avail.status === "ready" ? "success" : "warning",
                avail.status === "ready"
                    ? `Style "${this.preview.id}" added`
                    : `Style "${this.preview.id}" added, but not ready yet`,
            );
            this.onAdded();
            this.close();
        } catch (e) {
            services.logService.error(
                `Failed to add style "${this.preview.id}"`,
                "AddCslStyleModal",
                e,
            );
            services.notificationService.notify(
                "error",
                `Failed to add style "${this.preview.id}".`,
            );
            this.addBtn.setDisabled(false).setButtonText("Add style");
        } finally {
            this.busy = false;
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/** Companion modal for locales: enter a BCP-47 tag, confirm, then add. */
export class AddCslLocaleModal extends Modal {
    private preview: LocalePreview | null = null;
    private resultEl!: HTMLElement;
    private addBtn!: ButtonComponent;
    private busy = false;

    constructor(
        app: App,
        private onAdded: () => void,
    ) {
        super(app);
        this.setTitle("Add locale");
    }

    onOpen(): void {
        const { contentEl } = this;
        this.modalEl.addClass("zotflow-modal", "zotflow-csl-modal");
        contentEl.addClass("zotflow-csl-add-modal");

        let input = "";
        const doFetch = () => void this.fetchPreview(input);

        new Setting(contentEl)
            .setName("Locale tag")
            .setDesc(
                createFragment((f) => {
                    f.appendText(
                        "Enter a BCP-47 tag such as zh-CN. Available tags are listed in the ",
                    );
                    f.createEl("a", {
                        text: "locales repository",
                        href: "https://github.com/citation-style-language/locales",
                    });
                    f.appendText(".");
                }),
            )
            .addText((text) => {
                text.setPlaceholder("Example: de-DE").onChange((v) => {
                    input = v;
                });
                text.inputEl.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") doFetch();
                });
            })
            .addButton((btn) => {
                btn.setButtonText("Fetch").setCta().onClick(doFetch);
            });

        this.resultEl = contentEl.createDiv("zotflow-csl-add-result");
        this.resultEl.createDiv({
            cls: "zotflow-csl-add-idle",
            text: "Fetch a locale to confirm it before adding.",
        });

        const buttons = new Setting(contentEl).setClass(
            "zotflow-csl-modal-buttons",
        );
        buttons.addButton((btn) => {
            btn.setButtonText("Cancel").onClick(() => this.close());
        });
        buttons.addButton((btn) => {
            this.addBtn = btn;
            btn.setButtonText("Add locale")
                .setCta()
                .setDisabled(true)
                .onClick(() => void this.add());
        });
    }

    private async fetchPreview(input: string): Promise<void> {
        if (!input.trim() || this.busy) return;
        this.busy = true;
        this.preview = null;
        this.addBtn.setDisabled(true);
        this.resultEl.empty();
        const card = this.resultEl.createDiv(
            "zotflow-csl-modal-card is-loading",
        );
        for (const width of ["w35", "w70"]) {
            card.createDiv("zotflow-csl-modal-row").createSpan(
                `zotflow-csl-skeleton zotflow-csl-skeleton--${width}`,
            );
        }
        try {
            this.preview = await workerBridge.cslRender.previewLocale(input);
            this.resultEl.empty();
            const table = this.resultEl.createDiv("zotflow-csl-details-table");
            const row = (label: string, value: string, mono = false) => {
                const rowEl = table.createDiv("zotflow-csl-details-row");
                rowEl.createSpan({
                    cls: "zotflow-csl-details-label",
                    text: label,
                });
                rowEl.createSpan({
                    cls: `zotflow-csl-details-value${mono ? " zotflow-csl-mono" : ""}`,
                    text: value,
                });
            };
            row("Locale", this.preview.tag, true);
            row("Source", this.preview.sourceUrl);
            if (this.preview.alreadyInstalled) {
                const box = this.resultEl.createDiv(
                    "zotflow-csl-callout zotflow-csl-callout--warning",
                );
                const icon = box.createSpan("zotflow-csl-inline-icon");
                setIcon(icon, "alert-triangle");
                box.createSpan({
                    text: "This locale is already installed — adding will refresh it.",
                });
            }
            this.addBtn.setDisabled(false);
        } catch (e) {
            services.logService.error(
                `Failed to fetch locale "${input}"`,
                "AddCslLocaleModal",
                e,
            );
            this.resultEl.empty();
            const box = this.resultEl.createDiv(
                "zotflow-csl-callout zotflow-csl-callout--error",
            );
            const icon = box.createSpan("zotflow-csl-inline-icon");
            setIcon(icon, "alert-triangle");
            const text = box.createSpan();
            text.appendText("Couldn't fetch locale ");
            text.createSpan({ cls: "zotflow-csl-mono", text: input.trim() });
            text.appendText(". Check the tag — e.g. de-DE, zh-CN, pt-BR.");
        } finally {
            this.busy = false;
        }
    }

    private async add(): Promise<void> {
        if (!this.preview || this.busy) return;
        this.busy = true;
        this.addBtn.setDisabled(true).setButtonText("Adding…");
        try {
            await workerBridge.cslRender.addLocale(this.preview);
            services.notificationService.notify(
                "success",
                `Locale "${this.preview.tag}" added`,
            );
            this.onAdded();
            this.close();
        } catch (e) {
            services.logService.error(
                `Failed to add locale "${this.preview.tag}"`,
                "AddCslLocaleModal",
                e,
            );
            services.notificationService.notify(
                "error",
                `Failed to add locale "${this.preview.tag}".`,
            );
            this.addBtn.setDisabled(false).setButtonText("Add locale");
        } finally {
            this.busy = false;
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
