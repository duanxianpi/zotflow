import { HoverPopover, sanitizeHTMLToDom, setIcon, setTooltip } from "obsidian";
import type { HoverParent } from "obsidian";
import type { CitationReference } from "types/pandoc-citation";

/** Native positioning and dismissal, with one compact reference block per work.
 * ZotLit's citation popover is the visual reference: readable bibliography
 * text, quiet separators and small icon actions rather than form buttons.
 */
export class CitationPopover extends HoverPopover {
    constructor(
        parent: HoverParent,
        readonly anchor: HTMLElement,
        references: CitationReference[],
        open: (reference: CitationReference, pdf: boolean) => void,
        dismiss: (restoreFocus: boolean) => void,
    ) {
        super(parent, anchor, 300);
        this.hoverEl.addClass("zotflow-citation-popover");
        this.hoverEl.setAttribute("role", "dialog");
        this.hoverEl.setAttribute("aria-label", "Reference details");
        const content = this.hoverEl.createDiv({
            cls: "zotflow-citation-details",
        });
        // A work has one card. Its source note and PDF are actions on that
        // card, and repeated occurrences in a cluster do not repeat its title.
        const works = new Map<string, CitationReference>();
        for (const ref of references) {
            const id = `${ref.libraryID}/${ref.key}`;
            const existing = works.get(id);
            works.set(
                id,
                existing
                    ? {
                          ...existing,
                          attachmentKey:
                              existing.attachmentKey ?? ref.attachmentKey,
                          page: existing.page ?? ref.page,
                      }
                    : ref,
            );
        }
        for (const ref of works.values()) {
            const entry = content.createDiv({
                cls: "zotflow-citation-reference",
            });
            const header = entry.createDiv({ cls: "zotflow-citation-header" });
            header.createSpan({
                cls: "zotflow-citation-key",
                text: `@${ref.citekey}`,
            });
            if (ref.page)
                header.createSpan({
                    cls: "zotflow-citation-locator",
                    text: `p. ${ref.page}`,
                });
            const actions = header.createDiv({
                cls: "zotflow-citation-actions",
            });
            actions.setAttribute("role", "group");
            actions.setAttribute("aria-label", `Actions for ${ref.citekey}`);
            const addAction = (icon: string, label: string, pdf: boolean) => {
                const button = actions.createEl("button", {
                    cls: "clickable-icon zotflow-citation-action",
                    attr: { type: "button", "aria-label": label },
                });
                setIcon(button, icon);
                setTooltip(button, label);
                button.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    dismiss(false);
                    open(ref, pdf);
                });
            };
            addAction("file-text", "Open source note", false);
            if (ref.attachmentKey)
                addAction(
                    "file-symlink",
                    ref.page ? `Open PDF at page ${ref.page}` : "Open PDF",
                    true,
                );
            const bibliography = entry.createDiv({
                cls: "zotflow-citation-bibliography",
            });
            // CSL emits formatting markup; treat bibliographic metadata as
            // untrusted, just as the existing CSL style preview does.
            if (ref.bibliographyHtml)
                bibliography.appendChild(
                    sanitizeHTMLToDom(ref.bibliographyHtml),
                );
            else bibliography.setText(ref.bibliography);
        }
        this.registerDomEvent(this.hoverEl, "keydown", (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            dismiss(true);
        });
        this.registerDomEvent(this.hoverEl, "focusout", (event) => {
            if (
                event.relatedTarget === anchor ||
                this.hoverEl.contains(event.relatedTarget as Node | null)
            )
                return;
            this.setIsFocused(false);
            this.transition();
        });
        const observer = new MutationObserver(() => {
            if (!anchor.isConnected) dismiss(false);
        });
        observer.observe(anchor.doc.body, { childList: true, subtree: true });
        this.register(() => observer.disconnect());
        this.load();
    }

    /** Native HoverPopover timer handles belong to the target's window. */
    onShow(): void {
        // The renderer tracks this card during its opening delay as well.
        // Native onShow otherwise treats it as the previous card and hides it.
        if (this.parent.hoverPopover === this) this.parent.hoverPopover = null;
        super.onShow();
        this.anchor.setAttribute("aria-expanded", "true");
    }

    showForKeyboard(): void {
        this.setIsFocused(true);
        if (this.hoverEl.isConnected) return;
        this.anchor.win.clearTimeout(this.timer);
        this.show();
    }

    hide(): void {
        this.anchor.win.clearTimeout(this.timer);
        this.anchor.setAttribute("aria-expanded", "false");
        super.hide();
    }
}
