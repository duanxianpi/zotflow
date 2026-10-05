import React, { useMemo, useState } from "react";

import type {
    TemplateVariable,
    TemplateVariables,
} from "types/template-preview";

interface Props {
    variables: TemplateVariables | null;
    /** Shown instead of the list: nothing picked yet, loading, or a failure. */
    message: string;
    onInsert: (path: string) => void;
}

/** Whether `v` or anything under it matches the filter. */
function matches(v: TemplateVariable, query: string): boolean {
    if (v.path.toLowerCase().includes(query)) return true;
    if (v.value.toLowerCase().includes(query)) return true;
    return v.children?.some((c) => matches(c, query)) ?? false;
}

function badge(v: TemplateVariable): string | null {
    if (v.kind === "type-specific") return "type field";
    if (v.kind === "base-mapped" && v.mappedFrom) return `← ${v.mappedFrom}`;
    return null;
}

function summary(v: TemplateVariable): string {
    if (v.type === "array") return `${v.count ?? 0} item${v.count === 1 ? "" : "s"}`;
    if (v.type === "object") return "{…}";
    return v.value;
}

const VariableRow: React.FC<{
    v: TemplateVariable;
    query: string;
    onInsert: (path: string) => void;
}> = ({ v, query, onInsert }) => {
    const label = badge(v);
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
            {label && <span className="zotflow-template-vars-badge">{label}</span>}
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
        <details className="zotflow-template-vars-nested" open={query !== ""}>
            <summary>{head}</summary>
            <div className="zotflow-template-vars-children">
                {children.map((c) => (
                    <VariableRow key={c.path} v={c} query={query} onInsert={onInsert} />
                ))}
            </div>
        </details>
    );
};

/** The variables a template can use for the picked item or file; click one to insert it. */
export const TemplateVariablesPanel: React.FC<Props> = ({
    variables,
    message,
    onInsert,
}) => {
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();

    const groups = useMemo(
        () =>
            (variables?.groups ?? [])
                .map((g) => ({
                    ...g,
                    variables: q ? g.variables.filter((v) => matches(v, q)) : g.variables,
                }))
                .filter((g) => g.variables.length > 0),
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
            {groups.map((g) => (
                <details
                    key={g.label}
                    className="zotflow-template-vars-group"
                    open={q !== "" || !g.collapsed}
                >
                    <summary>
                        {g.label}
                        <span className="zotflow-template-vars-count">
                            {g.variables.length}
                        </span>
                    </summary>
                    {g.note && <div className="zotflow-template-vars-note">{g.note}</div>}
                    {g.variables.map((v) => (
                        <VariableRow key={v.path} v={v} query={q} onInsert={onInsert} />
                    ))}
                </details>
            ))}
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
