import { App, Modal } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";

import type { ConflictItemInfo } from "worker/services/conflict";

function formatTime(iso: string | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-US", {
        hour12: false,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/* ================================================================ */
/*  Why it is a conflict                                            */
/* ================================================================ */

/** Why a conflict exists, with the facts it rests on (the "?" modal). */
const ConflictDetails: React.FC<{ entry: ConflictItemInfo }> = ({ entry }) => {
    const d = entry.details;
    // What happened, in order: where both sides last agreed, what each
    // side did since, and when a sync found it.
    const facts: { label: string; value: string }[] = [];
    const lastAgreed =
        d.baseVersion ??
        (entry.kind === "local-deleted" && d.localVersion > 0
            ? d.localVersion
            : undefined);
    if (lastAgreed !== undefined) {
        facts.push({ label: "Last agreed", value: `version ${lastAgreed}` });
    } else if (entry.kind === "changed") {
        facts.push({ label: "Last agreed", value: "not recorded" });
    }
    const here = formatTime(d.localModified);
    facts.push({
        label: "Here",
        value:
            entry.kind === "local-deleted"
                ? `deleted ${here}`
                : d.localVersion === 0
                  ? `created${here ? ` ${here}` : ""}, never uploaded`
                  : here
                    ? `edited ${here}`
                    : "no changes of its own",
    });
    if (entry.kind === "remote-deleted") {
        facts.push({
            label: "In Zotero",
            value: d.groupRoot
                ? `deleted with “${d.groupRoot.title}”`
                : "deleted",
        });
    } else if (entry.remoteVersion > 0) {
        const there = formatTime(d.remoteModified);
        facts.push({
            label: "In Zotero",
            value: there
                ? `edited ${there}, now version ${entry.remoteVersion}`
                : `version ${entry.remoteVersion}`,
        });
    }
    facts.push({
        label: "Found",
        value: `${formatTime(d.detectedAt)}, during a sync`,
    });

    return (
        <div className="zotflow-conflict-why">
            <p className="zotflow-conflict-why-text">{d.explanation}</p>
            <dl className="zotflow-conflict-facts">
                {facts.map((f) => (
                    <React.Fragment key={f.label}>
                        <dt>{f.label}</dt>
                        <dd>{f.value || "—"}</dd>
                    </React.Fragment>
                ))}
            </dl>
            {d.serverError && (
                <p className="zotflow-conflict-server-error">
                    Zotero said: {d.serverError}
                </p>
            )}
        </div>
    );
};

/** "Why is this a conflict?": the explanation and facts behind one conflict. */
export class ConflictDetailsModal extends Modal {
    private root: Root | null = null;

    constructor(
        app: App,
        private entry: ConflictItemInfo,
    ) {
        super(app);
        this.setTitle("Why is this a conflict?");
    }

    onOpen() {
        this.contentEl.empty();
        this.root = createRoot(this.contentEl);
        this.root.render(<ConflictDetails entry={this.entry} />);
    }

    onClose() {
        this.root?.unmount();
        this.root = null;
        this.contentEl.empty();
    }
}
