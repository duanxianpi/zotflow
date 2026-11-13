import { Component, MarkdownRenderChild, TFile } from "obsidian";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { EventBus } from "services/event-bus";
import { findPandocCitations } from "utils/pandoc-citation";
import { openAttachment, openSourceNote } from "utils/viewer";
import { fireAndForgetIn } from "utils/fire-and-forget";
import { CitationPopover } from "ui/citations/citation-popover";
import type ZotFlow from "main";
import type { MarkdownPostProcessorContext } from "obsidian";
import type {
    CitationReference,
    PandocCitation,
    RenderedPandocCitation,
} from "types/pandoc-citation";

const ff = fireAndForgetIn("PandocCitationRenderer");
export interface CitationDocument {
    clusters: PandocCitation[];
    rendered: (RenderedPandocCitation | null)[];
}

/** Shared, bounded document cache for editor widgets and reading sections. */
export class PandocCitationRenderer extends Component {
    readonly changed = new EventBus<[]>();
    private cache = new Map<string, Promise<CitationDocument>>();
    private generation = 0;
    private active = true;
    hoverPopover: CitationPopover | null = null;
    private restoringFocus = false;

    constructor(private plugin: ZotFlow) {
        super();
    }

    onload(): void {
        this.active = true;
        this.register(
            services.eventHub.syncFinished.subscribe(() => this.refresh()),
        );
        this.register(
            services.eventHub.treeChanged.subscribe(() => this.refresh()),
        );
        this.register(
            services.eventHub.cslChanged.subscribe(() => this.refresh()),
        );
    }

    refresh(): void {
        this.dismissPopover();
        this.generation++;
        this.cache.clear();
        this.changed.emit();
    }

    onunload(): void {
        this.active = false;
        this.refresh();
    }

    async render(source: string): Promise<CitationDocument> {
        if (!this.active || !this.plugin.settings.renderPandocCitations)
            return { clusters: [], rendered: [] };
        let pending = this.cache.get(source);
        if (!pending) {
            const generation = this.generation;
            const style = this.plugin.settings.cslDefaultStyleId;
            const clusters = findPandocCitations(source);
            pending = (async () => {
                try {
                    if (!clusters.length) return { clusters, rendered: [] };
                    const libraries =
                        await workerBridge.dbHelper.getFilteredLibraryIDs();
                    const rendered =
                        await workerBridge.cslRender.renderPandocCitations(
                            clusters,
                            libraries,
                            style,
                        );
                    return generation === this.generation
                        ? { clusters, rendered }
                        : { clusters: [], rendered: [] };
                } catch (error) {
                    services.logService.debug(
                        "Citation preview unavailable; keeping source",
                        "PandocCitationRenderer",
                        error,
                    );
                    return { clusters, rendered: [] };
                }
            })();
            const oldest = this.cache.keys().next();
            if (this.cache.size >= 12 && !oldest.done)
                this.cache.delete(oldest.value);
            this.cache.set(source, pending);
        }
        return pending;
    }

    postProcess(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
        ctx.addChild(new CitationSection(el, ctx, this));
    }

    /** Labels are text; reference cards sanitize CSL formatting markup. */
    createElement(
        doc: Document,
        citation: RenderedPandocCitation,
    ): HTMLElement {
        const root = doc.win.createSpan();
        root.className = "zotflow-pandoc-citation";
        root.setAttribute("role", "group");
        root.setAttribute("aria-label", "Citation and reference details");
        const first = citation.references[0];
        const pdfTarget = !!first?.page && !!first.attachmentKey;
        const target = new URLSearchParams({
            type: pdfTarget ? "open-attachment" : "open-note",
            libraryID: String(first?.libraryID ?? ""),
            key: (pdfTarget ? first?.attachmentKey : first?.key) ?? "",
        });
        if (pdfTarget)
            target.set("navigation", JSON.stringify({ pageLabel: first.page }));
        const label = root.createEl("a", {
            cls: "zotflow-pandoc-citation-label",
            text: citation.text,
            href: `obsidian://zotflow?${target}`,
        });
        label.setAttribute("aria-haspopup", "dialog");
        label.setAttribute(
            "aria-description",
            "Press Arrow Down for reference actions. Escape closes the preview.",
        );
        label.setAttribute("aria-expanded", "false");
        label.addEventListener("mouseenter", () =>
            this.showPopover(label, citation),
        );
        label.addEventListener("focus", () =>
            this.showPopover(label, citation, true),
        );
        label.addEventListener("blur", (event) => {
            const popover = this.hoverPopover;
            if (
                popover?.anchor === label &&
                !popover.hoverEl.contains(event.relatedTarget as Node | null)
            ) {
                popover.setIsFocused(false);
                popover.transition();
            }
        });
        label.addEventListener("keydown", (event) => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                event.stopPropagation();
                this.showPopover(label, citation, true);
                this.hoverPopover?.hoverEl.querySelector("button")?.focus();
            }
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.dismissPopover();
            }
        });
        label.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.dismissPopover();
            const ref = citation.references[0];
            if (ref)
                ff(
                    this.open(ref, !!ref.page && !!ref.attachmentKey),
                    "Could not open citation",
                );
        });
        return root;
    }

    private showPopover(
        anchor: HTMLElement,
        citation: RenderedPandocCitation,
        keyboard = false,
    ): void {
        if (!this.active || this.restoringFocus) return;
        if (this.hoverPopover?.anchor !== anchor) {
            this.dismissPopover();
            const popover = new CitationPopover(
                this,
                anchor,
                citation.references,
                {
                    open: (ref, pdf) =>
                        ff(this.open(ref, pdf), "Could not open citation"),
                    copyKey: (ref) => this.copyKey(ref, anchor.doc),
                    openInZotero: (ref) => this.openInZotero(ref, anchor.doc),
                    dismiss: (restore) => this.dismissPopover(restore),
                },
            );
            this.hoverPopover = popover;
        }
        if (keyboard) this.hoverPopover?.showForKeyboard();
    }

    private dismissPopover(restoreFocus = false): void {
        const popover = this.hoverPopover;
        if (!popover) return;
        this.hoverPopover = null;
        popover.hide();
        if (restoreFocus && popover.anchor.isConnected) {
            this.restoringFocus = true;
            popover.anchor.focus({ preventScroll: true });
            this.restoringFocus = false;
        }
    }

    private async open(ref: CitationReference, pdf: boolean): Promise<void> {
        try {
            if (pdf && ref.attachmentKey) {
                await openAttachment(
                    ref.libraryID,
                    ref.attachmentKey,
                    this.plugin.app,
                    ref.page
                        ? JSON.stringify({ pageLabel: ref.page })
                        : undefined,
                );
                return;
            }
            const path = await workerBridge.libraryNote.ensureNotePath(
                ref.libraryID,
                ref.key,
            );
            const file = path
                ? this.plugin.app.vault.getAbstractFileByPath(path)
                : null;
            if (!(file instanceof TFile))
                throw new Error("Source note unavailable");
            await openSourceNote(file, this.plugin.app);
        } catch (error) {
            services.logService.error(
                "Could not open citation target",
                "PandocCitationRenderer",
                error,
            );
            services.notificationService.notify(
                "error",
                "Could not open this reference.",
            );
        }
    }

    private async copyKey(
        ref: CitationReference,
        doc: Document,
    ): Promise<boolean> {
        try {
            await doc.win.navigator.clipboard.writeText(ref.citekey);
            return true;
        } catch (error) {
            services.logService.error(
                "Could not copy citation key",
                "PandocCitationRenderer",
                error,
            );
            services.notificationService.notify(
                "error",
                "Could not copy the citation key.",
            );
            return false;
        }
    }

    private openInZotero(ref: CitationReference, doc: Document): void {
        try {
            doc.win.open(ref.zoteroUri, "_blank", "noopener,noreferrer");
        } catch (error) {
            services.logService.error(
                "Could not open item in Zotero",
                "PandocCitationRenderer",
                error,
            );
            services.notificationService.notify(
                "error",
                "Could not open this item in Zotero.",
            );
        }
    }
}

class CitationSection extends MarkdownRenderChild {
    private revision = 0;
    private active = false;
    private replacements = new Map<HTMLElement, string>();

    constructor(
        el: HTMLElement,
        private ctx: MarkdownPostProcessorContext,
        private renderer: PandocCitationRenderer,
    ) {
        super(el);
    }

    onload(): void {
        this.active = true;
        this.register(
            this.renderer.changed.subscribe(() =>
                ff(this.update(), "Could not refresh citations"),
            ),
        );
        ff(this.update(), "Could not render citations");
    }

    onunload(): void {
        this.active = false;
        this.revision++;
        this.restore();
    }

    private restore(): void {
        for (const [el, raw] of this.replacements)
            el.replaceWith(el.ownerDocument.createTextNode(raw));
        this.replacements.clear();
    }

    private async update(): Promise<void> {
        const revision = ++this.revision;
        this.restore();
        const file = services.app.vault.getFileByPath(this.ctx.sourcePath);
        const source = file
            ? await services.app.vault.cachedRead(file)
            : this.ctx.getSectionInfo(this.containerEl)?.text;
        if (source === undefined) return;
        const result = await this.renderer.render(source);
        if (!this.active || revision !== this.revision) return;
        const byRaw = new Map(
            result.clusters.map((c, i) => [c.raw, result.rendered[i]]),
        );
        // DOM text has already lost Markdown escapes. Align repeated literals
        // to this source section before replacing, so \[@key] stays literal
        // even when an identical, valid citation occurs elsewhere.
        const section = this.ctx.getSectionInfo(this.containerEl);
        const sectionSource = section
            ? source
                  .split("\n")
                  .slice(section.lineStart, section.lineEnd + 1)
                  .join("\n")
            : source;
        const occurrences = new Map<string, PandocCitation[]>();
        for (const occurrence of findPandocCitations(sectionSource, true)) {
            const queue = occurrences.get(occurrence.raw) ?? [];
            queue.push(occurrence);
            occurrences.set(occurrence.raw, queue);
        }
        const doc = this.containerEl.ownerDocument;
        const walker = doc.createTreeWalker(
            this.containerEl,
            NodeFilter.SHOW_TEXT,
        );
        const nodes: Text[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
            if (
                node.parentElement?.closest(
                    "a, code, pre, script, style, math, .math, .zotflow-pandoc-citation",
                )
            )
                continue;
            nodes.push(node as Text);
        }
        for (const text of nodes) {
            const value = text.data;
            const matches = findPandocCitations(value).filter((c) => {
                const original = occurrences.get(c.raw)?.shift();
                return original && !original.literal && byRaw.get(c.raw);
            });
            if (!matches.length) continue;
            const fragment = doc.win.createFragment();
            let offset = 0;
            for (const match of matches) {
                fragment.append(
                    doc.createTextNode(value.slice(offset, match.from)),
                );
                const element = this.renderer.createElement(
                    doc,
                    byRaw.get(match.raw)!,
                );
                this.replacements.set(element, match.raw);
                fragment.append(element);
                offset = match.to;
            }
            fragment.append(doc.createTextNode(value.slice(offset)));
            text.replaceWith(fragment);
        }
    }
}
