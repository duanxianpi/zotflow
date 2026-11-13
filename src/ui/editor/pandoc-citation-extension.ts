import {
    Decoration,
    EditorView,
    ViewPlugin,
    WidgetType,
} from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type {
    CitationDocument,
    PandocCitationRenderer,
} from "ui/citations/pandoc-renderer";
import type { RenderedPandocCitation } from "types/pandoc-citation";

const refreshCitations = StateEffect.define<null>();

class CitationWidget extends WidgetType {
    constructor(
        private renderer: PandocCitationRenderer,
        private citation: RenderedPandocCitation,
    ) {
        super();
    }
    eq(other: CitationWidget): boolean {
        return JSON.stringify(this.citation) === JSON.stringify(other.citation);
    }
    toDOM(view: EditorView): HTMLElement {
        return this.renderer.createElement(
            view.dom.ownerDocument,
            this.citation,
        );
    }
    ignoreEvent(): boolean {
        return true;
    }
}

/** Widgets replace display only; selection always reveals the Pandoc source. */
export function pandocCitationExtension(
    renderer: PandocCitationRenderer,
): Extension {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet = Decoration.none;
            private result: CitationDocument = { clusters: [], rendered: [] };
            private revision = 0;
            private alive = true;
            private unsubscribe: () => void;
            private timer: ReturnType<Window["setTimeout"]> | undefined;
            private live: boolean;

            constructor(private view: EditorView) {
                this.live = !!view.state.field(editorLivePreviewField, false);
                this.unsubscribe = renderer.changed.subscribe(() =>
                    this.request(),
                );
                this.request();
            }

            update(update: ViewUpdate): void {
                const live = !!update.state.field(
                    editorLivePreviewField,
                    false,
                );
                if (update.docChanged || live !== this.live) {
                    this.live = live;
                    this.result = { clusters: [], rendered: [] };
                    this.request();
                }
                this.build();
            }

            private request(): void {
                const revision = ++this.revision;
                if (this.timer !== undefined)
                    this.view.dom.win.clearTimeout(this.timer);
                if (!this.live) return;
                const source = this.view.state.doc.toString();
                this.timer = this.view.dom.win.setTimeout(() => {
                    this.timer = undefined;
                    void renderer.render(source).then((result) => {
                        if (!this.alive || revision !== this.revision) return;
                        this.result = result;
                        this.view.dispatch({
                            effects: refreshCitations.of(null),
                        });
                    });
                }, 150);
            }

            private build(): void {
                const state = this.view.state;
                if (!state.field(editorLivePreviewField, false)) {
                    this.decorations = Decoration.none;
                    return;
                }
                this.decorations = Decoration.set(
                    this.result.clusters.flatMap((cluster, i) => {
                        const citation = this.result.rendered[i];
                        if (
                            !citation?.text ||
                            state.selection.ranges.some(
                                (r) =>
                                    r.from <= cluster.to &&
                                    r.to >= cluster.from,
                            )
                        )
                            return [];
                        return [
                            Decoration.replace({
                                widget: new CitationWidget(renderer, citation),
                            }).range(cluster.from, cluster.to),
                        ];
                    }),
                    true,
                );
            }

            destroy(): void {
                this.alive = false;
                this.revision++;
                if (this.timer !== undefined)
                    this.view.dom.win.clearTimeout(this.timer);
                this.unsubscribe();
            }
        },
        { decorations: (plugin) => plugin.decorations },
    );
}
