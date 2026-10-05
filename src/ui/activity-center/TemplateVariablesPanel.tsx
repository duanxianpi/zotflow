import React, { useMemo, useState } from "react";
import { ObsidianIcon } from "ui/ObsidianIcon";

import type {
    TemplateVariable,
    TemplateVariables,
} from "types/template-preview";

interface Props {
    variables: TemplateVariables | null;
    /** Shown instead of the list: nothing picked yet, loading, or a failure. */
    message: string;
    /** Show `item`'s variables unfolded (not where they are at the root already). */
    openItem: boolean;
    onInsert: (path: string) => void;
}

/** Whether `v` or anything under it matches the filter. */
function matches(v: TemplateVariable, query: string): boolean {
    if (v.path.toLowerCase().includes(query)) return true;
    if (v.value.toLowerCase().includes(query)) return true;
    return v.children?.some((c) => matches(c, query)) ?? false;
}

/** What the row shows for the value; `literal` when it is a JS value rather than text. */
function summary(v: TemplateVariable): { text: string; literal: boolean } {
    switch (v.type) {
        case "undefined":
        case "null":
            return { text: v.type, literal: true };
        case "array":
            return { text: `${v.count ?? 0} item${v.count === 1 ? "" : "s"}`, literal: true };
        case "object":
            return { text: "{…}", literal: true };
        case "string":
            return v.value === "" ? { text: '""', literal: true } : { text: v.value, literal: false };
        default:
            return { text: v.value, literal: false };
    }
}

const VariableRow: React.FC<{
    v: TemplateVariable;
    query: string;
    open: boolean;
    onInsert: (path: string) => void;
}> = ({ v, query, open, onInsert }) => {
    const shown = summary(v);
    const children = v.children?.filter((c) => !query || matches(c, query));
    const nested = (children?.length ?? 0) > 0;
    const row = (
        <div className={`zotflow-template-vars-row ${nested ? "" : "is-leaf"}`}>
            {nested && (
                <span className="zotflow-template-vars-chevron">
                    <ObsidianIcon icon="chevron-right" />
                </span>
            )}
            <span
                className="zotflow-template-vars-name"
                role="button"
                tabIndex={0}
                title={`Insert {{ ${v.path} }}`}
                onClick={(e) => {
                    // A click on the name inserts; the rest of the row folds.
                    e.preventDefault();
                    e.stopPropagation();
                    onInsert(v.path);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onInsert(v.path);
                    }
                }}
            >
                {v.name}
            </span>
            <span
                className={`zotflow-template-vars-value ${shown.literal ? "is-literal" : ""}`}
                title={shown.literal ? undefined : v.value}
            >
                {shown.text}
            </span>
        </div>
    );
    if (!nested) return row;
    return (
        <details className="zotflow-template-vars-nested" open={open || query !== ""}>
            <summary>{row}</summary>
            <div className="zotflow-template-vars-children">
                {children?.map((c) => (
                    <VariableRow key={c.path} v={c} query={query} open={false} onInsert={onInsert} />
                ))}
            </div>
        </details>
    );
};

/** The variables a template sees for the picked item or file; click one to insert it. */
export const TemplateVariablesPanel: React.FC<Props> = ({
    variables,
    message,
    openItem,
    onInsert,
}) => {
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();

    const shown = useMemo(
        () => (variables?.variables ?? []).filter((v) => !q || matches(v, q)),
        [variables, q],
    );

    if (!variables) {
        return <div className="zotflow-template-test-placeholder">{message}</div>;
    }

    return (
        <div className="zotflow-template-vars">
            <input
                type="search"
                className="zotflow-template-vars-search"
                placeholder="Filter variables and values…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            <div className="zotflow-template-vars-tree">
                {shown.map((v) => (
                    <VariableRow
                        key={v.path}
                        v={v}
                        query={q}
                        open={openItem && v.path === "item"}
                        onInsert={onInsert}
                    />
                ))}
            </div>
            {variables.filters.length > 0 && (
                <div className="zotflow-template-vars-filters">
                    <span className="zotflow-template-vars-filters-label">ZotFlow filters</span>
                    {variables.filters.map((f) => (
                        <code key={f}>{f}</code>
                    ))}
                </div>
            )}
        </div>
    );
};
