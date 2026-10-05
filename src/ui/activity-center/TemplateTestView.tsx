import React, { useState, useCallback, useRef, useEffect } from "react";
import { Component, MarkdownRenderer } from "obsidian";
import { EditorView } from "@codemirror/view";
import { workerBridge } from "bridge";
import { services } from "services/services";
import { ItemPickerModal } from "ui/modals/item-picker";
import { FilePickerModal } from "ui/modals/file-picker";
import { TemplateWriteBackModal } from "ui/modals/template-write-back-modal";
import { createEmbeddableMarkdownEditor } from "ui/editor/markdown-editor";
import { ObsidianIcon } from "ui/ObsidianIcon";
import { MultiSelectDropdown } from "ui/activity-center/MultiSelectDropdown";
import { TemplateVariablesPanel } from "ui/activity-center/TemplateVariablesPanel";
import {
    applyWriteBack,
    loadSavedTemplate,
} from "ui/activity-center/template-store";
import {
    citationFormat,
    CONTEXT_LABELS,
    effectiveTemplate,
    isCitationContext,
    matchesSaved,
    needsLibraryItem,
    TEMPLATE_TARGETS,
} from "ui/activity-center/template-targets";

import type { EmbeddableMarkdownEditor } from "ui/editor/markdown-editor";
import type { MultiSelectOption } from "ui/activity-center/MultiSelectDropdown";
import type {
    SavedTemplate,
    TemplateContext,
    WriteBackPlan,
} from "ui/activity-center/template-targets";
import type { AnyIDBZoteroItem } from "types/db-schema";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import type { TFile } from "obsidian";
import type { AnnotationJSON } from "types/zotero-reader";
import type {
    TemplateError,
    TemplatePreviewResult,
    TemplateVariables,
} from "types/template-preview";

type OutputMode = "preview" | "source";
type RightTab = "output" | "variables";

/** The last render: which template it was, so a later edit can tell it is stale. */
interface LastRender {
    context: TemplateContext;
    template: string;
    result: TemplatePreviewResult;
}

const PHASE_LABELS: Record<TemplateError["phase"], string> = {
    parse: "Syntax error",
    render: "Render error",
    frontmatter: "Frontmatter error",
};

const MAX_ANNOTATION_LABEL_LENGTH = 30;

function annotationLabel(a: AnnotationJSON): string {
    const text = a.text || a.comment || a.id;
    if (text.length <= MAX_ANNOTATION_LABEL_LENGTH) return text;
    return text.slice(0, MAX_ANNOTATION_LABEL_LENGTH) + "…";
}

/** A rendered source note without its frontmatter, which is shown as a table instead. */
function stripFrontmatter(text: string): string {
    if (!text.startsWith("---\n")) return text;
    const end = text.indexOf("\n---\n", 3);
    return end === -1 ? text : text.slice(end + 5);
}

function propertyValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(propertyValue).join(", ");
    return JSON.stringify(value) ?? "";
}

/** Replace the editor's selection with `{{ path }}`. */
function insertVariable(editor: EmbeddableMarkdownEditor, path: string): void {
    const cm = editor.activeCM;
    const { from, to } = cm.state.selection.main;
    const text = `{{ ${path} }}`;
    cm.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
    });
    cm.focus();
}

/** Select line `line` in the template editor, with the cursor's end at `col`. */
function revealPosition(
    editor: EmbeddableMarkdownEditor,
    line: number,
    col = 1,
): void {
    const cm = editor.activeCM;
    const doc = cm.state.doc;
    const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(target.from + col - 1, target.to);
    cm.dispatch({
        selection: { anchor: target.to, head: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    cm.focus();
}

/** Template testing view for the Activity Center. */
export const TemplateTestView: React.FC = () => {
    const [context, setContext] = useState<TemplateContext>("library");

    const [selectedItem, setSelectedItem] = useState<AnyIDBZoteroItem | null>(
        null,
    );
    const [selectedFile, setSelectedFile] =
        useState<TFileWithoutParentAndVault | null>(null);

    // Annotations for citation preview
    const [availableAnnotations, setAvailableAnnotations] = useState<
        AnnotationJSON[]
    >([]);
    const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<
        string[]
    >([]);
    const [loadingAnnotations, setLoadingAnnotations] = useState(false);

    const [template, setTemplate] = useState("");
    const [saved, setSaved] = useState<SavedTemplate | null>(null);
    const [lastRender, setLastRender] = useState<LastRender | null>(null);
    const [rendering, setRendering] = useState(false);
    const [notice, setNotice] = useState("");
    const [outputMode, setOutputMode] = useState<OutputMode>("source");
    const [rightTab, setRightTab] = useState<RightTab>("output");
    const [variables, setVariables] = useState<TemplateVariables | null>(null);
    const [variablesMessage, setVariablesMessage] = useState("");

    const result = lastRender?.result ?? null;
    const rendered = result?.ok ? result.output : "";
    const frontmatter = result?.ok ? result.frontmatter : undefined;

    // Refs for imperative editor instances
    const templateContainerRef = useRef<HTMLDivElement>(null);
    const outputContainerRef = useRef<HTMLDivElement>(null);
    const previewContainerRef = useRef<HTMLDivElement>(null);
    const templateEditorRef = useRef<EmbeddableMarkdownEditor | null>(null);

    // Stable ref for current template value (avoids stale closures)
    const templateRef = useRef(template);
    templateRef.current = template;

    // Flag to skip onChange when we programmatically set the editor
    const settingProgrammatically = useRef(false);

    const currentTemplate = useCallback(
        () => templateEditorRef.current?.value ?? templateRef.current,
        [],
    );

    /** Replace the editor's content (a newly loaded template). */
    const loadIntoEditor = useCallback((text: string) => {
        setTemplate(text);
        if (templateEditorRef.current) {
            settingProgrammatically.current = true;
            templateEditorRef.current.set(text, false);
            settingProgrammatically.current = false;
        }
    }, []);

    // Create template editor (left panel)
    useEffect(() => {
        const container = templateContainerRef.current;
        if (!container) return;

        const editor = createEmbeddableMarkdownEditor(services.app, container, {
            value: templateRef.current,
            placeholder: "Enter your template here…",
            sourceMode: true,
            showLineNumbers: true,
            onChange: () => {
                if (editor && !settingProgrammatically.current) {
                    setTemplate(editor.value);
                }
            },
        });
        templateEditorRef.current = editor;

        return () => {
            templateEditorRef.current = null;
            editor.destroy();
        };
    }, []);

    // Create / recreate output editor (right panel — source mode)
    useEffect(() => {
        if (rightTab !== "output" || outputMode !== "source") return;

        const container = outputContainerRef.current;
        if (!container) return;

        const editor = createEmbeddableMarkdownEditor(services.app, container, {
            value: rendered,
            readOnly: true,
            sourceMode: true,
            showLineNumbers: true,
        });

        return () => {
            editor.destroy();
        };
        // Recreate when the source view is shown or the output changes
    }, [rightTab, outputMode, rendered]);

    // Render markdown preview (right panel — preview mode)
    useEffect(() => {
        if (rightTab !== "output" || outputMode !== "preview") return;

        const container = previewContainerRef.current;
        if (!container) return;

        container.empty();
        const comp = new Component();
        comp.load();

        if (rendered) {
            void MarkdownRenderer.render(
                services.app,
                frontmatter ? stripFrontmatter(rendered) : rendered,
                container,
                "",
                comp,
            );
        } else {
            container.createSpan({
                text: "Click Render to see output.",
                cls: "zotflow-template-test-placeholder",
            });
        }

        return () => {
            comp.unload();
        };
    }, [rightTab, outputMode, rendered, frontmatter]);

    const reloadSaved = useCallback(
        async (ctx: TemplateContext) => {
            try {
                const loaded = await loadSavedTemplate(ctx);
                setSaved(loaded);
                loadIntoEditor(effectiveTemplate(loaded));
            } catch (e) {
                services.logService.error(
                    "Failed to load the saved template",
                    "TemplateTestView",
                    e,
                );
                setSaved(null);
                loadIntoEditor("");
            }
            setLastRender(null);
            setNotice("");
        },
        [loadIntoEditor],
    );

    // Load the saved template when the context changes
    useEffect(() => {
        void reloadSaved(context);
    }, [context, reloadSaved]);

    // Reset item/file selection when switching between library ↔ local
    useEffect(() => {
        setSelectedItem(null);
        setSelectedFile(null);
        setAvailableAnnotations([]);
        setSelectedAnnotationIds([]);
    }, [needsLibraryItem(context)]);

    // Fetch annotations when a library item is picked (for citation contexts)
    useEffect(() => {
        if (!selectedItem) {
            setAvailableAnnotations([]);
            setSelectedAnnotationIds([]);
            return;
        }
        let cancelled = false;
        setLoadingAnnotations(true);
        void (async () => {
            try {
                const apiKey = services.settings.zoteroapikey;
                const annots =
                    await workerBridge.annotation.getAllItemAnnotations(
                        selectedItem.libraryID,
                        selectedItem.key,
                        apiKey,
                    );
                if (!cancelled) {
                    setAvailableAnnotations(annots);
                    setSelectedAnnotationIds([]);
                }
            } catch {
                if (!cancelled) {
                    setAvailableAnnotations([]);
                }
            } finally {
                if (!cancelled) setLoadingAnnotations(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selectedItem]);

    // List the variables for the picked item or file
    useEffect(() => {
        let cancelled = false;
        setVariables(null);
        const pickFirst = needsLibraryItem(context)
            ? "Pick a Zotero item to list its variables."
            : "Pick a local file to list its variables.";
        if (needsLibraryItem(context) ? !selectedItem : !selectedFile) {
            setVariablesMessage(pickFirst);
            return;
        }
        setVariablesMessage("Loading…");
        void (async () => {
            try {
                let vars: TemplateVariables;
                if (selectedItem && needsLibraryItem(context)) {
                    const { libraryID, key } = selectedItem;
                    if (context === "library") {
                        vars = await workerBridge.libraryTemplate.describeLibrarySourceNote(libraryID, key);
                    } else if (context === "library-path") {
                        vars = await workerBridge.notePath.describeLibraryNotePath(libraryID, key);
                    } else if (context === "display-title") {
                        vars = await workerBridge.displayTitle.describe(libraryID, key);
                    } else {
                        const annotations = availableAnnotations.filter((a) =>
                            selectedAnnotationIds.includes(a.id),
                        );
                        vars = await workerBridge.libraryTemplate.describeCitationTemplate({
                            item: selectedItem,
                            annotations: annotations.length > 0 ? annotations : undefined,
                        });
                    }
                } else if (selectedFile) {
                    vars =
                        context === "local"
                            ? await workerBridge.localTemplate.describeLocalNote(selectedFile)
                            : await workerBridge.notePath.describeLocalNotePath(selectedFile);
                } else {
                    return;
                }
                if (!cancelled) setVariables(vars);
            } catch (e) {
                services.logService.error(
                    "Failed to list template variables",
                    "TemplateTestView",
                    e,
                );
                if (!cancelled) setVariablesMessage("Could not list the variables. See the log for details.");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [context, selectedItem, selectedFile, selectedAnnotationIds, availableAnnotations]);

    const handlePick = useCallback(() => {
        if (needsLibraryItem(context)) {
            new ItemPickerModal(services.app, (item: AnyIDBZoteroItem) => {
                setSelectedItem(item);
                setLastRender(null);
                setNotice("");
            }).open();
        } else {
            new FilePickerModal(services.app, (file: TFile) => {
                setSelectedFile({
                    path: file.path,
                    name: file.name,
                    extension: file.extension,
                    basename: file.basename,
                });
                setLastRender(null);
                setNotice("");
            }).open();
        }
    }, [context]);

    const preview = useCallback(
        async (text: string): Promise<TemplatePreviewResult | null> => {
            if (needsLibraryItem(context)) {
                if (!selectedItem) {
                    setNotice("Pick a Zotero item first.");
                    return null;
                }
                const { libraryID, key } = selectedItem;
                if (context === "library") {
                    return workerBridge.libraryTemplate.previewLibrarySourceNote(
                        libraryID,
                        key,
                        text,
                    );
                }
                if (context === "library-path") {
                    return workerBridge.notePath.previewLibraryNotePath(
                        libraryID,
                        key,
                        text,
                    );
                }
                if (context === "display-title") {
                    return workerBridge.displayTitle.preview(libraryID, key, text);
                }
                if (isCitationContext(context)) {
                    const annotations = availableAnnotations.filter((a) =>
                        selectedAnnotationIds.includes(a.id),
                    );
                    return workerBridge.libraryTemplate.previewCitationTemplate(
                        {
                            item: selectedItem,
                            annotations:
                                annotations.length > 0 ? annotations : undefined,
                        },
                        text,
                        citationFormat(context),
                    );
                }
                return null;
            }
            if (!selectedFile) {
                setNotice("Pick a local file first.");
                return null;
            }
            return context === "local"
                ? workerBridge.localTemplate.previewLocalNote(selectedFile, text)
                : workerBridge.notePath.previewLocalNotePath(selectedFile, text);
        },
        [
            context,
            selectedItem,
            selectedFile,
            selectedAnnotationIds,
            availableAnnotations,
        ],
    );

    const handleRender = useCallback(async () => {
        setNotice("");
        setRendering(true);
        const text = currentTemplate();
        try {
            const result = await preview(text);
            if (result) setLastRender({ context, template: text, result });
        } catch (e) {
            setLastRender(null);
            setNotice("Could not render the template. See the log for details.");
            services.logService.error(
                "Template preview failed",
                "TemplateTestView",
                e,
            );
        } finally {
            setRendering(false);
        }
    }, [context, preview, currentTemplate]);

    const handleSave = useCallback(() => {
        if (!saved) return;
        const text = currentTemplate();
        new TemplateWriteBackModal(
            services.app,
            saved,
            text,
            async (plan: WriteBackPlan) => {
                try {
                    await applyWriteBack(plan);
                } catch (e) {
                    services.logService.error(
                        "Failed to save the template",
                        "TemplateTestView",
                        e,
                    );
                    services.notificationService.notify(
                        "error",
                        "Failed to save the template.",
                    );
                    return false;
                }
                services.notificationService.notify("success", "Template saved");
                const loaded = await loadSavedTemplate(saved.context);
                // The context may have changed while the modal was open.
                setSaved((prev) =>
                    prev?.context === loaded.context ? loaded : prev,
                );
                return true;
            },
        ).open();
    }, [saved, currentTemplate]);

    // The output belongs to the template as it was rendered; after an edit
    // it is stale, and saving needs a fresh successful render.
    const renderIsCurrent =
        lastRender !== null &&
        lastRender.context === context &&
        lastRender.template === template;
    const isSaved = saved !== null && matchesSaved(template, saved);
    let saveBlocker = "";
    if (!saved) saveBlocker = "The saved template could not be loaded.";
    else if (isSaved) saveBlocker = "This is the saved template.";
    else if (!renderIsCurrent || !lastRender.result.ok) {
        saveBlocker = "Render this template without errors first.";
    }
    const target = TEMPLATE_TARGETS[context];

    const selectionLabel = needsLibraryItem(context)
        ? (selectedItem?.title ?? "No item selected")
        : (selectedFile?.path ?? "No file selected");

    const annotationOptions: MultiSelectOption[] = availableAnnotations.map(
        (a) => ({
            value: a.id,
            label: `[${a.type}] ${annotationLabel(a)}`,
        }),
    );

    const error = result && !result.ok ? result.error : null;
    const hints = result?.hints ?? [];

    return (
        <div className="zotflow-template-test">
            {/* ── Environment ── */}
            <div className="zotflow-template-test-env-section">
                <span className="zotflow-template-test-section-header">
                    Environment
                </span>

                <div className="zotflow-template-test-env">
                    <select
                        className="dropdown"
                        value={context}
                        onChange={(e) =>
                            setContext(e.target.value as TemplateContext)
                        }
                    >
                        {(
                            Object.entries(CONTEXT_LABELS) as [
                                TemplateContext,
                                string,
                            ][]
                        ).map(([value, label]) => (
                            <option key={value} value={value}>
                                {label}
                            </option>
                        ))}
                    </select>

                    <button onClick={handlePick}>
                        {needsLibraryItem(context)
                            ? "Pick Zotero Item"
                            : "Pick Local File"}
                    </button>

                    <span className="zotflow-template-test-selection">
                        {selectionLabel}
                    </span>
                </div>

                {/* Annotation picker for citation contexts */}
                {isCitationContext(context) && selectedItem && (
                    <div className="zotflow-template-test-annotation-row">
                        <MultiSelectDropdown
                            options={annotationOptions}
                            selected={selectedAnnotationIds}
                            onChange={setSelectedAnnotationIds}
                            placeholder={
                                loadingAnnotations
                                    ? "Loading…"
                                    : "Annotations (optional)"
                            }
                            disabled={loadingAnnotations}
                        />
                    </div>
                )}
            </div>

            {/* ── Side-by-side panels ── */}
            <div className="zotflow-template-test-panels">
                {/* Left: Template editor */}
                <div className="zotflow-template-test-panel">
                    <div className="zotflow-template-test-panel-header">
                        <span className="zotflow-template-test-section-header">
                            Template
                        </span>
                        <div className="zotflow-template-test-mode-toggle">
                            <button
                                className="clickable-icon"
                                aria-label="Reload the saved template"
                                disabled={isSaved}
                                onClick={() => void reloadSaved(context)}
                            >
                                <ObsidianIcon icon="rotate-ccw" />
                            </button>
                            <button
                                className="clickable-icon"
                                aria-label="Copy template"
                                onClick={() => {
                                    void navigator.clipboard.writeText(
                                        currentTemplate(),
                                    );
                                    services.notificationService.notify(
                                        "success",
                                        "Template copied to clipboard",
                                    );
                                }}
                            >
                                <ObsidianIcon icon="copy" />
                            </button>
                        </div>
                    </div>
                    <div
                        ref={templateContainerRef}
                        className="zotflow-template-test-editor"
                    />
                </div>

                {/* Right: Output with preview/source toggle */}
                <div className="zotflow-template-test-panel">
                    <div className="zotflow-template-test-panel-header">
                        <div className="zotflow-template-test-tabs">
                            <button
                                className={`zotflow-template-test-section-header ${rightTab === "output" ? "is-active" : ""}`}
                                onClick={() => setRightTab("output")}
                            >
                                Output
                                {lastRender && !renderIsCurrent && (
                                    <span className="zotflow-template-test-stale">
                                        {" "}
                                        · outdated
                                    </span>
                                )}
                            </button>
                            <button
                                className={`zotflow-template-test-section-header ${rightTab === "variables" ? "is-active" : ""}`}
                                onClick={() => setRightTab("variables")}
                            >
                                Variables
                            </button>
                        </div>
                        <div
                            className={`zotflow-template-test-mode-toggle ${rightTab === "output" ? "" : "is-hidden"}`}
                        >
                            <button
                                className={`clickable-icon ${outputMode === "source" ? "is-active" : ""}`}
                                onClick={() => setOutputMode("source")}
                                aria-label="Source view"
                            >
                                <ObsidianIcon icon="code" />
                            </button>
                            <button
                                className={`clickable-icon ${outputMode === "preview" ? "is-active" : ""}`}
                                onClick={() => setOutputMode("preview")}
                                aria-label="Reading view"
                            >
                                <ObsidianIcon icon="book-open" />
                            </button>
                        </div>
                    </div>

                    {rightTab === "variables" && (
                        <div className="zotflow-template-test-output zotflow-template-test-variables">
                            <TemplateVariablesPanel
                                variables={variables}
                                message={variablesMessage}
                                onInsert={(path) => {
                                    if (templateEditorRef.current) {
                                        insertVariable(templateEditorRef.current, path);
                                    }
                                }}
                            />
                        </div>
                    )}

                    {rightTab === "output" && hints.length > 0 && (
                        <ul className="zotflow-template-test-hints">
                            {hints.map((hint) => (
                                <li key={hint}>
                                    <ObsidianIcon icon="info" />
                                    <span>{hint}</span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {rightTab === "output" && outputMode === "source" && (
                        <div
                            ref={outputContainerRef}
                            className="zotflow-template-test-output"
                        />
                    )}
                    {rightTab === "output" && outputMode === "preview" && (
                        <div className="zotflow-template-test-output zotflow-template-test-preview">
                            {frontmatter && (
                                <table className="zotflow-template-test-properties">
                                    <tbody>
                                        {Object.entries(frontmatter).map(
                                            ([key, value]) => (
                                                <tr key={key}>
                                                    <th>{key}</th>
                                                    <td>{propertyValue(value)}</td>
                                                </tr>
                                            ),
                                        )}
                                    </tbody>
                                </table>
                            )}
                            <div ref={previewContainerRef} />
                        </div>
                    )}
                </div>
            </div>

            {error && (
                <div className="zotflow-template-test-error">
                    <div className="zotflow-template-test-error-head">
                        <strong>{PHASE_LABELS[error.phase]}</strong>
                        {error.line !== undefined && (
                            <button
                                className="zotflow-template-test-error-position"
                                onClick={() => {
                                    if (templateEditorRef.current && error.line !== undefined) {
                                        revealPosition(
                                            templateEditorRef.current,
                                            error.line,
                                            error.col,
                                        );
                                    }
                                }}
                            >
                                Line {error.line}
                                {error.col !== undefined && `, column ${error.col}`}
                            </button>
                        )}
                    </div>
                    <div className="zotflow-template-test-error-message">
                        {error.message}
                    </div>
                    {error.renderedFrontmatter !== undefined && (
                        <details className="zotflow-template-test-error-detail">
                            <summary>Rendered frontmatter</summary>
                            <pre>{error.renderedFrontmatter}</pre>
                        </details>
                    )}
                </div>
            )}

            {notice && (
                <div className="zotflow-template-test-error">{notice}</div>
            )}

            {/* ── Actions ── */}
            <div className="zotflow-template-test-actions">
                <span className="zotflow-template-test-status">
                    {saved &&
                        (isSaved
                            ? saved.stored?.trim()
                                ? "Saved template"
                                : "Built-in template (nothing saved)"
                            : "Unsaved changes")}
                </span>
                <button
                    onClick={handleSave}
                    disabled={saveBlocker !== ""}
                    aria-label={saveBlocker || `Save to ${target.label}`}
                >
                    {target.kind === "file" ? "Save to File" : "Save to Settings"}
                </button>
                <button
                    className="mod-cta"
                    onClick={() => void handleRender()}
                    disabled={rendering}
                >
                    {rendering ? "Rendering..." : "Render"}
                </button>
            </div>
        </div>
    );
};
