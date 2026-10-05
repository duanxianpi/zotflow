import React, { useMemo, useState } from "react";

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

function summary(v: TemplateVariable): string {
    if (v.type === "array") return `${v.count ?? 0} item${v.count === 1 ? "" : "s"}`;
    if (v.type === "object") return "{…}";
    return v.value;
}

const VariableRow: React.FC<{
    v: TemplateVariable;
    query: string;
    open: boolean;
    onInsert: (path: string) => void;
}> = ({ v, query, open, onInsert }) => {
    const head = (
        <div className="zotflow-template-vars-row">
            <button
                className="zotflow-template-vars-name"
                aria-label={`Insert {{ ${v.path} }}`}
                onClick={(e) => {
                    e.preventDefault();
                    onInsert(v.path);
                }}
            >
                {v.name}
            </button>
            <span
                className={`zotflow-template-vars-value ${v.type === "null" || v.value === "" ? "is-empty" : ""}`}
                title={v.type === "string" ? v.value : undefined}
            >
                {summary(v) || "empty"}
            </span>
        </div>
    );
    const children = v.children?.filter((c) => !query || matches(c, query));
    if (!children?.length) return head;
    return (
        <details className="zotflow-template-vars-nested" open={open || query !== ""}>
            <summary>{head}</summary>
            <div className="zotflow-template-vars-children">
                {children.map((c) => (
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
            <div>
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
                    <span>ZotFlow filters:</span>{" "}
                    {variables.filters.map((f) => (
                        <code key={f}>{f}</code>
                    ))}
                </div>
            )}
        </div>
    );
};
