import type { AnnotationProfileSettings } from "utils/annotation-profiles";

/** Build only the opt-in annotation section; existing templates stay byte-for-byte intact. */
export function annotationPresentationTemplate(
    original: string,
    local: boolean,
    settings: AnnotationProfileSettings,
): string {
    if (
        !settings.groupSourceNoteAnnotations &&
        !settings.labeledAnnotationCallouts
    )
        return original;
    // Labeled-only mode preserves the original attachment and document ordering.
    if (!settings.groupSourceNoteAnnotations) {
        return original.replace(
            /^> \[!zotflow-.*\] (.+)$/gm,
            (_line, originalLink: string) =>
                `> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] {{ annotation.resolvedLabel | default: "Other" | annotation_label }}\n> ${originalLink}\n>`,
        );
    }
    const link = local
        ? "[[{{item.path}}#page={{ annotation.pageLabel }}#annotation={{ annotation.key | process_nav_info }}|{{ item.name }}, p.{{ annotation.pageLabel }}]]"
        : "[{{ annotation.attachmentTitle }}, p.{{ annotation.pageLabel }}]({{ annotation | annotation_link }})";
    const block = `
> [!zotflow-{{ annotation.type }}-{{ annotation.color }}] ${link}
{%- if annotation.type == "ink" or annotation.type == "image" -%}
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

`;
    const start = local
        ? original.indexOf("{%- if item.annotations.length > 0 -%}")
        : original.indexOf(
              "{%- if item.attachments.length > 0 and item.attachmentAnnotations.length > 0 -%}",
          );
    return (
        original.slice(0, start) +
        `
{%- for group in item.annotationGroups -%}
## {{ group.label | annotation_label }}
{%- for annotation in group.annotations -%}
${block}
{%- endfor -%}
{%- endfor -%}
`
    );
}
