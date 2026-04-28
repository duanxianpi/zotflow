import {
    EditorView,
    Decoration,
    WidgetType,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
import {
    type Extension,
    type EditorState,
    RangeSetBuilder,
} from "@codemirror/state";
import { setIcon } from "obsidian";
import {
    editableRegionsField,
    unlockedRegionsField,
    toggleRegionLockEffect,
} from "./zotflow-editable-region-extension";

/* ================================================================ */
/*  Helpers                                                         */
/* ================================================================ */

/** Check whether `library-id` exists in frontmatter. */
function hasLibraryId(state: EditorState): boolean {
    if (state.doc.sliceString(0, 3) !== "---") return false;
    const head = state.doc.sliceString(0, 10000);
    const fmMatch = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(
        head,
    );
    if (!fmMatch) return false;
    return /^library-id:\s*\d+/m.test(fmMatch[0]);
}

/* ================================================================ */
/*  Unlock icon widget                                              */
/* ================================================================ */

class UnlockIconWidget extends WidgetType {
    constructor(
        private regionKey: string,
        private unlocked: boolean,
    ) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement("span");
        span.className = "cm-zotflow-unlock-icon";
        if (this.unlocked) span.classList.add("cm-zotflow-unlocked");
        setIcon(span, this.unlocked ? "lock-open" : "lock");
        span.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            view.dispatch({
                effects: toggleRegionLockEffect.of(this.regionKey),
            });
        });
        return span;
    }

    eq(other: UnlockIconWidget): boolean {
        return (
            this.regionKey === other.regionKey &&
            this.unlocked === other.unlocked
        );
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/* ================================================================ */
/*  Region border overlay (ViewPlugin)                              */
/* ================================================================ */

/**
 * Draws absolutely-positioned border overlays around each editable region.
 *
 * Unlike Decoration.line() (which only styles .cm-line elements), this
 * overlay covers **all** elements in the region — including code blocks,
 * math renders, embedded images, and other widgets produced by external
 * CM6 extensions.
 *
 * The overlay is appended to .cm-sizer (contentDOM's parent) which has
 * `position: relative` and scrolls with content, so lineBlockAt()
 * coordinates map directly.
 */
class RegionBorderPlugin {
    private container: HTMLElement;
    private overlays: HTMLElement[] = [];
    /** Serialized positions from last rebuild — skip DOM work when unchanged. */
    private lastPositionKey = "";

    constructor(private view: EditorView) {
        this.container = document.createElement("div");
        this.container.className = "cm-zotflow-region-borders";
        this.container.setAttribute("aria-hidden", "true");

        const parent = view.contentDOM.parentElement;
        if (parent) parent.appendChild(this.container);

        this.rebuild();
    }

    update(update: ViewUpdate) {
        if (
            update.docChanged ||
            update.viewportChanged ||
            update.geometryChanged
        ) {
            this.rebuild();
        }
    }

    private rebuild() {
        // No library-id → not a ZotFlow source note, skip border overlays
        if (!hasLibraryId(this.view.state)) {
            if (this.overlays.length > 0) {
                for (const el of this.overlays) el.remove();
                this.overlays = [];
                this.lastPositionKey = "";
            }
            return;
        }

        const regions = this.view.state.field(editableRegionsField, false);
        if (!regions?.length) {
            if (this.overlays.length > 0) {
                for (const el of this.overlays) el.remove();
                this.overlays = [];
                this.lastPositionKey = "";
            }
            return;
        }

        const content = this.view.contentDOM;
        const left = content.offsetLeft;
        const width = content.offsetWidth;
        const topOffset = content.offsetTop;

        const pad = 6; // px — keep border outside the text/caret area

        // Compute positions and build a key for comparison
        const positions: {
            top: number;
            left: number;
            width: number;
            height: number;
        }[] = [];
        for (const region of regions) {
            // Only draw borders for NOTE regions
            if (region.type !== "NOTE") continue;

            const topBlock = this.view.lineBlockAt(region.begFrom);
            const bottomBlock = this.view.lineBlockAt(region.endTo);

            const top = topOffset + topBlock.top;
            const height = bottomBlock.top + bottomBlock.height - topBlock.top;

            positions.push({
                top,
                left: left - pad,
                width: width + pad * 2,
                height,
            });
        }

        // Skip DOM work if positions haven't changed
        const positionKey = positions
            .map((p) => `${p.top},${p.left},${p.width},${p.height}`)
            .join("|");
        if (positionKey === this.lastPositionKey) return;
        this.lastPositionKey = positionKey;

        for (const el of this.overlays) el.remove();
        this.overlays = [];

        for (const p of positions) {
            const el = document.createElement("div");
            el.className = "cm-zotflow-region-border-overlay";
            el.style.top = `${p.top}px`;
            el.style.left = `${p.left}px`;
            el.style.width = `${p.width}px`;
            el.style.height = `${p.height}px`;

            this.container.appendChild(el);
            this.overlays.push(el);
        }
    }

    destroy() {
        this.container.remove();
    }
}

/* ================================================================ */
/*  Main extension                                                  */
/* ================================================================ */

/**
 * CM6 decoration extension for ZotFlow editable regions in Source Mode.
 *
 * Visual treatment:
 * - Border overlay: continuous rounded-corner frame (ViewPlugin, covers
 *   all elements including code blocks / math / widgets)
 * - BEG marker line: subtle accent background + unlock icon
 * - END marker line: subtle accent background
 * - Meta line: collapsed single-row with ellipsis
 *
 * Derives all positions from the editable-regions StateField (no re-scan).
 *
 * @param isDefaultLocked — returns the current `defaultEditableRegionLocked` setting value.
 */
export function ZotFlowRegionDecorationExtension(
    isDefaultLocked: () => boolean,
): Extension {
    return [
        /* Line decorations (text styling, bg tints, widgets) */
        EditorView.decorations.compute(
            [editableRegionsField, unlockedRegionsField],
            (state) => {
                // No library-id → not a ZotFlow source note, skip all decorations
                if (!hasLibraryId(state)) return Decoration.none;

                const regions = state.field(editableRegionsField, false);
                if (!regions) return Decoration.none;

                const unlocked =
                    state.field(unlockedRegionsField, false) ??
                    new Set<string>();

                const ranges: {
                    from: number;
                    to: number;
                    deco: Decoration;
                }[] = [];

                for (const region of regions) {
                    const begLine = state.doc.lineAt(region.begFrom);
                    const endLine = state.doc.lineAt(region.endFrom);
                    const typeClass = region.type.toLowerCase(); // "note" | "anno"

                    // BEG marker: accent background
                    ranges.push({
                        from: begLine.from,
                        to: begLine.from,
                        deco: Decoration.line({
                            class: `cm-zotflow-beg-line cm-zotflow-beg-line-${typeClass}`,
                        }),
                    });
                    ranges.push({
                        from: region.begFrom,
                        to: region.begTo,
                        deco: Decoration.mark({
                            class: `cm-zotflow-tag-text cm-zotflow-tag-text-${typeClass}`,
                            inclusive: true,
                        }),
                    });
                    // Unlock icon widget after BEG marker text
                    const regionUnlocked = isDefaultLocked()
                        ? unlocked.has(region.key) // default locked → toggle set = unlocked keys
                        : !unlocked.has(region.key); // default unlocked → toggle set = locked keys
                    ranges.push({
                        from: region.begTo,
                        to: region.begTo,
                        deco: Decoration.widget({
                            widget: new UnlockIconWidget(
                                region.key,
                                regionUnlocked,
                            ),
                            side: 1,
                        }),
                    });

                    // END marker: accent background
                    ranges.push({
                        from: endLine.from,
                        to: endLine.from,
                        deco: Decoration.line({
                            class: `cm-zotflow-end-line cm-zotflow-end-line-${typeClass}`,
                        }),
                    });
                    ranges.push({
                        from: region.endFrom,
                        to: region.endTo,
                        deco: Decoration.mark({
                            class: `cm-zotflow-tag-text cm-zotflow-tag-text-${typeClass}`,
                            inclusive: true,
                        }),
                    });

                    // Meta line (if present)
                    if (region.metaFrom != null && region.metaTo != null) {
                        const metaLine = state.doc.lineAt(region.metaFrom);
                        ranges.push({
                            from: metaLine.from,
                            to: metaLine.from,
                            deco: Decoration.line({
                                class: "cm-zotflow-meta-line",
                            }),
                        });
                        ranges.push({
                            from: region.metaFrom,
                            to: region.metaTo,
                            deco: Decoration.mark({
                                class: `cm-zotflow-tag-text cm-zotflow-tag-text-${typeClass}`,
                                inclusive: true,
                            }),
                        });
                    }
                }

                ranges.sort((a, b) => a.from - b.from || a.to - b.to);

                const builder = new RangeSetBuilder<Decoration>();
                for (const r of ranges) {
                    builder.add(r.from, r.to, r.deco);
                }
                return builder.finish();
            },
        ),

        /* Border overlay plugin */
        ViewPlugin.fromClass(RegionBorderPlugin),

        /* Theme */
        EditorView.baseTheme({
            /* Overlay container (inside .cm-sizer, scrolls with content) */
            ".cm-zotflow-region-borders": {
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
                pointerEvents: "none",
                zIndex: "1",
            },

            /* Border frame around each region */
            ".cm-zotflow-region-border-overlay": {
                position: "absolute",
                boxSizing: "border-box",
                border: "1.5px solid var(--interactive-accent)",
                borderRadius: "var(--radius-m)",
                pointerEvents: "none",
            },

            /* BEG marker: subtle accent background */
            ".cm-zotflow-beg-line": {
                backgroundColor:
                    "color-mix(in srgb, var(--interactive-accent) 6%, transparent)",
            },

            /* END marker: subtle accent background */
            ".cm-zotflow-end-line": {
                backgroundColor:
                    "color-mix(in srgb, var(--interactive-accent) 6%, transparent)",
            },

            /* Marker text: small muted */
            ".cm-zotflow-tag-text": {
                fontSize: "var(--font-smallest)",
                color: "var(--text-muted)",
            },

            /* Unlock icon */
            ".cm-zotflow-unlock-icon": {
                display: "inline-flex",
                alignItems: "center",
                marginLeft: "4px",
                verticalAlign: "middle",
                fontSize: "var(--font-small)",
                color: "var(--text-muted)",
                opacity: "0.7",
                cursor: "pointer",
                pointerEvents: "auto",
            },
            ".cm-zotflow-unlock-icon:hover": {
                opacity: "1",
            },
            ".cm-zotflow-unlock-icon.cm-zotflow-unlocked": {
                color: "var(--interactive-accent)",
                opacity: "1",
            },
            ".cm-zotflow-unlock-icon svg": {
                width: "1em",
                height: "1em",
            },

            /* Meta line: collapsed single-row */
            ".cm-zotflow-meta-line:not(.cm-active)": {
                display: "flex !important",
                width: "auto",
                maxWidth: "100%",
                flexDirection: "row",
                alignItems: "baseline",
                verticalAlign: "bottom",
                boxSizing: "border-box",
            },
            ".cm-zotflow-meta-line:not(.cm-active) > span": {
                whiteSpace: "nowrap",
            },
            ".cm-zotflow-meta-line:not(.cm-active) > .cm-comment-start, .cm-zotflow-meta-line:not(.cm-active) > .cm-comment-end":
                {
                    flex: "0 0 auto",
                },
            ".cm-zotflow-meta-line:not(.cm-active) > .cm-comment:not(.cm-comment-start):not(.cm-comment-end)":
                {
                    flex: "0 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                },
        }),
    ];
}
