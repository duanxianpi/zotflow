import { App, Modal } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import { ZotFlowActivityCenter } from "./ZotFlowActivityCenter";

/** Obsidian `Modal` subclass that mounts the React `ZotFlowActivityCenter` component. */
export class ActivityCenterModal extends Modal {
    private root: Root | null = null;

    /** `initialTab`: the tab to open on (e.g. `"conflicts"`). */
    constructor(
        app: App,
        private initialTab?: string,
    ) {
        super(app);
        this.setTitle("ZotFlow Activity Center");
    }

    onOpen() {
        const { contentEl, modalEl } = this;

        modalEl.addClass("zotflow-modal", "mod-zotflow-ac");
        contentEl.empty();

        this.root = createRoot(contentEl);
        this.root.render(
            <React.StrictMode>
                <ZotFlowActivityCenter initialTab={this.initialTab} />
            </React.StrictMode>,
        );
    }

    onClose() {
        const { contentEl } = this;
        if (this.root) {
            this.root.unmount();
        }
        contentEl.empty();
    }
}
