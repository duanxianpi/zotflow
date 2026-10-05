import { Modal, setIcon, Setting } from "obsidian";
import { workerBridge } from "bridge";
import { renderStyleDetails } from "ui/modals/csl-style-details";

import type { App } from "obsidian";
import type { StyleDetailsMeta } from "ui/modals/csl-style-details";

/** Row state distilled from Availability for the details surface. */
export type StyleDetailsState = "ready" | "resolvable" | "unavailable";

export interface StyleDetailsEntry {
    meta: StyleDetailsMeta;
    state: StyleDetailsState;
    /** Human-readable explanation when state is "unavailable". */
    reason?: string;
    /** Missing parent slug when state is "resolvable". */
    parentNeeded?: string;
    /** Aliases never update independently — updates flow through the parent. */
    isAlias: boolean;
    /** The last update attempt in this session failed (still works offline). */
    updateFailed?: boolean;
}

export interface StyleDetailsActions {
    /** Refetch the style + chain (remote non-alias styles). */
    onUpdate?: () => void;
    /** Download the missing parent (resolvable styles). */
    onDownloadParent?: () => void;
    /** Remove the style (remote styles; folder styles are files). */
    onRemove?: () => void;
    /** Reveal the .csl file in the system explorer (folder styles). */
    onReveal?: () => void;
}

/**
 * Read-only detail surface for an installed style: shared StyleDetails
 * block (metadata + dependency relationship + rendered preview) plus the
 * state-appropriate actions. Opened by clicking a row in the CSL tab.
 */
export class StyleDetailsModal extends Modal {
    constructor(
        app: App,
        private entry: StyleDetailsEntry,
        private actions: StyleDetailsActions,
    ) {
        super(app);
        this.setTitle(entry.meta.title ?? entry.meta.id);
    }

    onOpen(): void {
        const { contentEl } = this;
        const { entry } = this;
        this.modalEl.addClass("zotflow-modal", "zotflow-csl-modal");
        contentEl.addClass("zotflow-csl-add-modal");

        if (entry.state === "unavailable" && entry.reason) {
            const box = contentEl.createDiv(
                "zotflow-csl-callout zotflow-csl-callout--error",
            );
            const icon = box.createSpan("zotflow-csl-inline-icon");
            setIcon(icon, "alert-triangle");
            box.createSpan({ text: entry.reason });
        }
        if (entry.state === "resolvable" && entry.parentNeeded) {
            const box = contentEl.createDiv(
                "zotflow-csl-callout zotflow-csl-callout--warning",
            );
            const icon = box.createSpan("zotflow-csl-inline-icon");
            setIcon(icon, "cloud");
            box.createSpan({
                text: `Needs the parent style "${entry.parentNeeded}" before it can render.`,
            });
        }
        if (entry.updateFailed) {
            const box = contentEl.createDiv(
                "zotflow-csl-callout zotflow-csl-callout--warning",
            );
            const icon = box.createSpan("zotflow-csl-inline-icon");
            setIcon(icon, "rotate-cw");
            box.createSpan({
                text: "Still works offline, but the last update check couldn't reach the repository.",
            });
        }

        const details = renderStyleDetails(contentEl, entry.meta);

        // Rendered sample is best-effort and only published for repo styles.
        if (entry.meta.source === "remote") {
            details.setSampleLoading();
            void workerBridge.cslRender
                .styleSample(entry.meta.id)
                .then((sample) => details.setSample(sample))
                .catch(() => details.setSample(undefined));
        } else {
            details.setSample(undefined);
        }

        const buttons = new Setting(contentEl).setClass(
            "zotflow-csl-modal-buttons",
        );
        if (this.actions.onRemove) {
            buttons.addButton((btn) => {
                btn.setButtonText("Remove")
                    .setClass("zotflow-csl-btn-left")
                    .setClass("mod-warning")
                    .onClick(() => {
                        this.actions.onRemove?.();
                        this.close();
                    });
            });
        }
        if (entry.state === "resolvable" && this.actions.onDownloadParent) {
            buttons.addButton((btn) => {
                btn.setButtonText("Download parent")
                    .setCta()
                    .onClick(() => {
                        this.actions.onDownloadParent?.();
                        this.close();
                    });
            });
        }
        if (
            entry.state !== "resolvable" &&
            !entry.isAlias &&
            this.actions.onUpdate
        ) {
            buttons.addButton((btn) => {
                btn.setButtonText(
                    entry.updateFailed ? "Retry update" : "Update",
                ).onClick(() => {
                    this.actions.onUpdate?.();
                    this.close();
                });
            });
        }
        if (this.actions.onReveal) {
            buttons.addButton((btn) => {
                btn.setButtonText("Reveal in folder").onClick(() => {
                    this.actions.onReveal?.();
                });
            });
        }
        buttons.addButton((btn) => {
            btn.setButtonText("Close").onClick(() => this.close());
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
