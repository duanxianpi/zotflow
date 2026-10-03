import type { AnnotationGroup } from "utils/annotation-profiles";
import { annotationPresentationTemplate } from "worker/services/annotation-presentation";
import { Liquid } from "liquidjs";
import {
    resolveAnnotationMeaning, groupAnnotations, escapeAnnotationLabel,
} from "utils/annotation-profiles";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import type { ZotFlowSettings } from "settings/types";
import type { AnnotationJSON } from "types/zotero-reader";
import type { IParentProxy } from "bridge/types";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import { getLocalSidecarPath } from "utils/utils";
import { annoHtml2md } from "worker/convert";
import type { AnnotationTemplateContext } from "types/template-context";
import {
    renderLiquid,
    zfEnv,
    type LiquidFilterScope,
} from "./liquid-support";
import {
    mergeTemplateFrontmatter,
    withMandatoryFirst,
} from "utils/template-frontmatter";

/** Default LiquidJS template string for local vault file source notes. */
const DEFAULT_LOCAL_NOTE_TEMPLATE = `---
zotflow-locked: {{true}}
zotflow-local-attachment: [[{{ path }}]]
---
{%- capture quote_string %}{{ newline }}> {% endcapture -%}
{%- capture quote_string_2 %}{{ newline }}> >{% endcapture -%}
# {{ item.basename }}
{%- if item.annotations.length > 0 -%}
## Annotations
{%- for annotation in item.annotations -%}

> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] [[{{item.path}}#page={{ annotation.pageLabel }}#annotation={{ annotation.key | process_nav_info }}|{{ item.name }}, p.{{ annotation.pageLabel }}]]
{%- if annotation.type == "ink" or annotation.type == "image"-%}
> > ![[{{settings.annotationImageFolder}}/{{ annotation.key }}.png]]
{%- else -%}
> > {{ annotation.text | replace: newline, quote_string_2 }}
{%- endif -%}
>
> {{ annotation.comment | wrap_editable: "ANNO", annotation.key | replace: newline, quote_string }}
{%- if annotation.tags and annotation.tags.length > 0 -%}
>
> {% for t in annotation.tags %}#{{ t.tag | replace: " ", "_" }}{% unless forloop.last %} {% endunless %}{% endfor %}
{%- endif -%}
^{{ annotation.key }}

{%- endfor -%}
{%- endif -%}
`;

/** LiquidJS template engine for rendering local vault file (PDF/EPUB) source notes. */
/** Root scope handed to Liquid when rendering a local-file sidecar note. */
interface LocalRenderContext {
    item: {
        name: string;
        path: string;
        extension: string;
        basename: string;
        annotations: AnnotationTemplateContext[];
        annotationGroups: AnnotationGroup<AnnotationTemplateContext>[];
    };
    settings: ZotFlowSettings;
    __zfReadOnlyKeys: Set<string>;
}

export class LocalTemplateService {
    private engine: Liquid;

    constructor(
        private settings: ZotFlowSettings,
        private parentHost: IParentProxy,
    ) {
        this.initialize();
    }

    initialize() {
        this.engine = new Liquid({
            extname: ".md",
            greedy: false,
            globals: {
                newline: "\n",
            },
        });

        this.engine.registerFilter("annotation_label", escapeAnnotationLabel);

        this.engine.registerFilter("process_nav_info", (input: string) => {
            const navInfo = {
                annotationID: input,
            };
            return encodeURIComponent(JSON.stringify(navInfo));
        });

        this.engine.registerFilter(
            "wrap_editable",
            /**
             * Wrap content in ZF_<TYPE>_BEG/END markers so the CM6 editable
             * region extension can mount an editable zone. Mirrors the
             * library-template filter: consults the per-render
             * `__zfReadOnlyKeys` set so read-only annotations (external,
             * extracted from the PDF itself) render as plain locked text.
             */
            function (
                this: LiquidFilterScope,
                input: string,
                type: string,
                key: string,
            ) {
                if (!type || !key) return input;
                const readOnlyKeys = zfEnv(this).__zfReadOnlyKeys;
                if (readOnlyKeys && readOnlyKeys.has(`${type}:${key}`)) {
                    return input;
                }
                // Always block form: markers on their own lines. An inline
                // (single-line) layout was tried and retired — a line
                // starting with `<!--` becomes a CommonMark HTML block, so
                // markdown inside it renders raw in Reading view; `%%`
                // markers avoid that but introduce stray blank lines.
                return `<!-- ZF_${type}_BEG_${key} -->\n${input}\n<!-- ZF_${type}_END_${key} -->`;
            },
        );
    }

    updateSettings(newSettings: ZotFlowSettings) {
        this.settings = newSettings;
    }

    /**
     * Render the local note content using LiquidJS
     */
    async renderLocalNote(
        localAttachment: TFileWithoutParentAndVault,
        annotations: AnnotationJSON[],
        templateContent: string | null,
        originalFrontmatter: Record<string, unknown> = {},
    ): Promise<string> {
        try {
            const context = await this.prepareLocalAttachmentContext(
                localAttachment,
                annotations,
            );

            const template = templateContent || annotationPresentationTemplate(DEFAULT_LOCAL_NOTE_TEMPLATE, true, this.settings);

            // Separate Frontmatter and Body
            const frontmatterRegex = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
            const match = template.match(frontmatterRegex);

            let templateFrontmatterRaw = "";
            let body = template;

            if (match) {
                templateFrontmatterRaw = match[1] || "";
                body = template.substring(match[0].length);
            }

            // Parse Template Frontmatter
            let templateFrontmatter: Record<string, unknown> = {};
            if (templateFrontmatterRaw.trim()) {
                try {
                    // Render the frontmatter raw string first (allow liquid tags in frontmatter)
                    const renderedFrontmatterRaw =
                        await renderLiquid(
                            this.engine,
                            templateFrontmatterRaw,
                            context,
                        );

                    // Then parse the rendered string as YAML via Main Thread
                    templateFrontmatter = await this.parentHost.parseYaml(
                        renderedFrontmatterRaw,
                    );
                } catch (e) {
                    this.parentHost.log(
                        "error",
                        "Failed to parse template frontmatter",
                        "LocalTemplateService",
                        e,
                    );
                    // Continue execution, just without template frontmatter
                }
            }

            // `??key` supplies a default without overwriting a value the user
            // already has; bare keys retain overwrite-on-render semantics.
            // Mandatory fields, always overwritten and written first.
            const finalFrontmatter = withMandatoryFirst(
                {
                    "zotflow-locked": true,
                    "zotflow-local-attachment": `[[${localAttachment.path}]]`,
                },
                mergeTemplateFrontmatter(
                    originalFrontmatter,
                    templateFrontmatter,
                ),
            );

            // Stringify Frontmatter via Main Thread
            const frontmatterString =
                await this.parentHost.stringifyYaml(finalFrontmatter);

            // Render Body
            const renderedBody = await renderLiquid(
                this.engine,
                body,
                context,
            );

            return `---\n${frontmatterString}---\n${renderedBody}`;
        } catch (err) {
            throw ZotFlowError.wrap(
                err,
                ZotFlowErrorCode.PARSE_ERROR,
                "LocalTemplateService",
                `Failed to render note template: ${(err as Error).message}`,
            );
        }
    }

    public async prepareLocalAttachmentContext(
        localAttachment: TFileWithoutParentAndVault,
        annotations: AnnotationJSON[],
    ): Promise<LocalRenderContext> {
        const processedAnnotations: AnnotationTemplateContext[] = [...annotations]
            .sort((a, b) =>
                (a.sortIndex ?? "").localeCompare(b.sortIndex ?? ""),
            )
            .map((annotation) => {
                return {
                    ...resolveAnnotationMeaning(annotation, this.settings),
                    attachmentTitle: localAttachment.name,
                    key: annotation.id,
                    libraryID: 0, // Local files imply simplified library context
                    type: annotation.type,
                    authorName: annotation.authorName,
                    // Both fields carry Zotero's restricted annotation HTML
                    // (<b>/<i>/<sub>/<sup>) — convert to markdown, escaping
                    // stray </> on the way (annoHtml2md subsumes the old
                    // sanitizeQuotesString).
                    text: annoHtml2md(annotation.text || ""),
                    comment: annoHtml2md(annotation.comment || ""),
                    color: annotation.color,
                    pageLabel: annotation.pageLabel,
                    tags:
                        annotation.tags?.map((t) => ({
                            tag: t.name,
                        })) || [],
                    dateAdded: annotation.dateAdded,
                    dateModified: annotation.dateModified,
                    isExternal: annotation.isExternal === true,
                    readOnly:
                        annotation.readOnly === true ||
                        annotation.isExternal === true,
                    // Provide raw object for filter usage, ensuring it's an object, not string
                    raw: annotation,
                };
            });

        const item = {
            name: localAttachment.name,
            path: localAttachment.path,
            extension: localAttachment.extension,
            basename: localAttachment.basename,
            annotations: processedAnnotations,
            annotationGroups: groupAnnotations(processedAnnotations, this.settings),
        };

        // Read-only annotations must not become editable regions —
        // consumed by the wrap_editable filter.
        const readOnlyKeys = new Set<string>();
        for (const anno of processedAnnotations) {
            if (anno.readOnly) readOnlyKeys.add(`ANNO:${anno.key}`);
        }

        return {
            item,
            settings: {
                ...this.settings,
                annotationImageFolder:
                    this.settings.annotationImageFolder.replace(/\/$/, ""),
            },
            __zfReadOnlyKeys: readOnlyKeys,
        };
    }

    /** Preview-render a local vault file with the given template content. */
    async previewLocalNote(
        file: TFileWithoutParentAndVault,
        templateContent: string,
    ): Promise<string> {
        const annotations = await this.loadSidecarAnnotations(file);
        return this.renderLocalNote(file, annotations, templateContent, {});
    }

    /** Load annotations from the co-located `.zf.json` sidecar file, if it exists. */
    private async loadSidecarAnnotations(
        file: TFileWithoutParentAndVault,
    ): Promise<AnnotationJSON[]> {
        const jsonPath = getLocalSidecarPath(
            file.path,
            this.settings.localSidecarFolder,
        );

        try {
            const result = await this.parentHost.checkFile(jsonPath);
            if (!result.exists) return [];

            const content = await this.parentHost.readTextFile(jsonPath);
            if (!content) return [];

            const parsed = JSON.parse(content) as {
                annotations?: AnnotationJSON[];
            };
            return Array.isArray(parsed.annotations) ? parsed.annotations : [];
        } catch {
            return [];
        }
    }

    /** Return the user-configured template file content, or the built-in default. */
    async getDefaultTemplate(): Promise<string> {
        const path = this.settings.localSourceNoteTemplatePath;
        if (path) {
            try {
                const content = await this.parentHost.readTextFile(path);
                if (content != null) return content;
            } catch {
                // Fall through to default
            }
        }
        return annotationPresentationTemplate(DEFAULT_LOCAL_NOTE_TEMPLATE, true, this.settings);
    }
}
