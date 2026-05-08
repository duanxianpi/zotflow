import { Liquid } from "liquidjs";
import type { TFileWithoutParentAndVault } from "types/zotflow";
import type { ZotFlowSettings } from "settings/types";
import type { AnnotationJSON } from "types/zotero-reader";
import type { IParentProxy } from "bridge/types";
import { ZotFlowError, ZotFlowErrorCode } from "utils/error";
import { getLocalSidecarPath } from "utils/utils";
import type { AnnotationTemplateContext } from "types/template-context";

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
{%- if annotation.comment != "" -%}
>
> {{ annotation.comment | replace: newline, quote_string }}
{%- endif -%}
^{{ annotation.key }}

{%- endfor -%}
{%- endif -%}
`;

/** LiquidJS template engine for rendering local vault file (PDF/EPUB) source notes. */
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

        this.engine.registerFilter("process_nav_info", (input: string) => {
            const navInfo = {
                annotationID: input,
            };
            return encodeURIComponent(JSON.stringify(navInfo));
        });
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
        originalFrontmatter: Record<string, any> = {},
    ): Promise<string> {
        try {
            const context = await this.prepareLocalAttachmentContext(
                localAttachment,
                annotations,
            );

            const template = templateContent || DEFAULT_LOCAL_NOTE_TEMPLATE;

            // Separate Frontmatter and Body
            const frontmatterRegex = /^---\s*([\s\S]*?)\s*---\n/;
            const match = template.match(frontmatterRegex);

            let templateFrontmatterRaw = "";
            let body = template;

            if (match) {
                templateFrontmatterRaw = match[1] || "";
                body = template.substring(match[0].length);
            }

            // Parse Template Frontmatter
            let templateFrontmatter: any = {};
            if (templateFrontmatterRaw.trim()) {
                try {
                    // Render the frontmatter raw string first (allow liquid tags in frontmatter)
                    const renderedFrontmatterRaw =
                        await this.engine.parseAndRender(
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

            // Merge Frontmatter (Original + Rendered Template)
            // Template keys overwrite Original keys
            const finalFrontmatter = {
                ...originalFrontmatter,
                ...templateFrontmatter,
            };

            // Ensure Mandatory Fields
            finalFrontmatter["zotflow-locked"] = true;
            finalFrontmatter["zotflow-local-attachment"] =
                `[[${localAttachment.path}]]`;

            // Stringify Frontmatter via Main Thread
            const frontmatterString =
                await this.parentHost.stringifyYaml(finalFrontmatter);

            // Render Body
            const renderedBody = await this.engine.parseAndRender(
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

    private sanitizeQuotesString(str: string | null | undefined): string {
        if (!str) return "";
        // Escape > into \> to prevent breaking blockquotes structure in Markdown
        return str.replace(/>/g, "\\>");
    }

    public async prepareLocalAttachmentContext(
        localAttachment: TFileWithoutParentAndVault,
        annotations: AnnotationJSON[],
    ): Promise<any> {
        const processedAnnotations: AnnotationTemplateContext[] = annotations
            .sort((a, b) =>
                (a.sortIndex ?? "").localeCompare(b.sortIndex ?? ""),
            )
            .map((annotation) => {
                return {
                    key: annotation.id,
                    libraryID: 0, // Local files imply simplified library context
                    type: annotation.type,
                    authorName: annotation.authorName,
                    text: this.sanitizeQuotesString(annotation.text),
                    comment: this.sanitizeQuotesString(annotation.comment),
                    color: annotation.color,
                    pageLabel: annotation.pageLabel,
                    tags:
                        annotation.tags?.map((t) => ({
                            tag: t.name,
                        })) || [],
                    dateAdded: annotation.dateAdded,
                    dateModified: annotation.dateModified,
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
        };

        return {
            item,
            settings: {
                ...this.settings,
                annotationImageFolder:
                    this.settings.annotationImageFolder.replace(/\/$/, ""),
            },
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
        return DEFAULT_LOCAL_NOTE_TEMPLATE;
    }
}
